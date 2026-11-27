#!/usr/bin/env python3
"""
Ticket CLI - Centrale Python wrapper voor Redmine ticket operaties.

Voordelen:
- Correct handling van quotes en speciale tekens
- Markdown validatie voor verzending
- Uniforme error handling
- DRY: alle operaties in één plek

Usage:
    ticket-cli.py create "Subject" --tracker=bug --epic=123 --desc="Description"
    ticket-cli.py close 123 --notes="Closing notes"
    ticket-cli.py update 123 --subject="New subject" --desc="New desc"
    ticket-cli.py note 123 "Note text"
    ticket-cli.py show 123
    ticket-cli.py list
    ticket-cli.py epics
    ticket-cli.py attach 123 /path/to/file
    ticket-cli.py reopen 123
    ticket-cli.py relate 123 blocks 456
"""

import argparse
import base64
import json
import logging
import os
import re
import sys
from datetime import datetime
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError
from urllib.parse import urlencode

# Add project root to path for lib imports
# Script location: packages/redmine/scripts/ticket-cli.py
PROJECT_ROOT_PATH = Path(__file__).parent.parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT_PATH))

try:
    from scripts.core.config import get_project_root
except ImportError:
    # Run on its own, outside the repository (the copy the MCP server carries):
    # the project is MCP_PROJECT_DIR, else the working directory.
    def get_project_root() -> Path:
        return Path(os.environ.get("MCP_PROJECT_DIR") or Path.cwd())

# Logging setup - workspace directory for persistence (TICKET_LOG_DIR names another folder)
PROJECT_ROOT = get_project_root()
LOG_DIR = Path(os.getenv("TICKET_LOG_DIR", PROJECT_ROOT / "workspace" / "logs"))
LOG_DIR.mkdir(parents=True, exist_ok=True)
LOG_FILE = LOG_DIR / "ticket-cli.log"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s",
    handlers=[
        logging.FileHandler(LOG_FILE),
    ]
)
logger = logging.getLogger("ticket-cli")


def log_operation(operation: str, args: dict, result: str = None, error: str = None):
    """Log ticket operation for later analysis."""
    log_data = {
        "timestamp": datetime.now().isoformat(),
        "operation": operation,
        "args": {k: v for k, v in args.items() if v is not None},
    }
    if result:
        log_data["result"] = result
    if error:
        log_data["error"] = error
        logger.error(json.dumps(log_data))
    else:
        logger.info(json.dumps(log_data))


def logged_command(operation: str):
    """Decorator to log all command invocations."""
    def decorator(func):
        def wrapper(args):
            # Extract relevant args for logging
            arg_dict = vars(args) if hasattr(args, '__dict__') else {}
            try:
                result = func(args)
                if result == 0:
                    log_operation(operation, arg_dict, result="success")
                else:
                    log_operation(operation, arg_dict, error=f"exit_code={result}")
                return result
            except Exception as e:
                log_operation(operation, arg_dict, error=str(e))
                raise
        return wrapper
    return decorator

# Configuration
REDMINE_URL = os.getenv("REDMINE_URL", "http://localhost:9114")
REDMINE_API_KEY = os.getenv("REDMINE_API_KEY")

def _redmine_public_url() -> str:
    """The address people open Redmine at, for display: REDMINE_PUBLIC_URL, else the API address."""
    return (os.environ.get("REDMINE_PUBLIC_URL") or REDMINE_URL).rstrip("/")

if not REDMINE_API_KEY:
    print("ERROR: REDMINE_API_KEY environment variable not set", file=sys.stderr)
    sys.exit(1)

# Tracker IDs
TRACKERS = {
    "bug": 1, "Bug": 1, "1": 1,
    "feature": 2, "Feature": 2, "2": 2,
    "support": 3, "Support": 3, "3": 3,
    "epic": 4, "Epic": 4, "4": 4,
}

# Custom field IDs
CF_BUSINESS_VALUE = 10
CF_EXPERTISE_AREA = 11
CF_ESTIMATED_HOURS = 12
CF_ACTUAL_HOURS = 13
CF_AI_HOURS = 14
CF_AI_AGENT = 17
CF_AI_SESSION_ID = 18

# AI Agent enumeration mapping (name -> Redmine enumeration ID)
# These IDs are from custom_field_enumerations table for custom_field_id=17
AI_AGENT_IDS = {
    "claude-code": "1",
    "cursor": "2",
    "github-copilot": "3",
    "windsurf": "4",
    "aider": "5",
    "continue": "6",
    "codex": "7",
    "manual": "8",
}
AI_AGENTS = list(AI_AGENT_IDS.keys())

# Status IDs (must match Redmine issue_statuses table)
STATUS_NEW = 1
STATUS_IN_PROGRESS = 2
STATUS_RESOLVED = 3          # is_closed=true
STATUS_CLOSED = 4            # is_closed=true
STATUS_TESTING = 5
STATUS_ACCEPTANCE = 6

# Status name → ID mapping (for --status parameter)
STATUS_MAP = {
    "new": STATUS_NEW,
    "in_progress": STATUS_IN_PROGRESS,
    "resolved": STATUS_RESOLVED,
    "closed": STATUS_CLOSED,
    "testing": STATUS_TESTING,
    "acceptance": STATUS_ACCEPTANCE,
}

# Relation types
RELATION_TYPES = ["relates", "duplicates", "blocks", "precedes", "copied_to"]


class MarkdownValidator:
    """Simple markdown validation with warnings."""

    @staticmethod
    def validate(text: str) -> list[str]:
        """Validate markdown and return list of warnings."""
        if not text:
            return []

        warnings = []
        lines = text.split('\n')

        # Check for common issues
        for i, line in enumerate(lines, 1):
            # Unclosed inline code
            backtick_count = line.count('`')
            if backtick_count % 2 != 0 and '```' not in line:
                warnings.append(f"Line {i}: Mogelijk onafgesloten inline code (oneven aantal backticks)")

            # Unclosed bold/italic
            asterisk_pairs = len(re.findall(r'\*\*', line))
            single_asterisks = line.count('*') - (asterisk_pairs * 2)
            if single_asterisks % 2 != 0:
                warnings.append(f"Line {i}: Mogelijk onafgesloten italic (*)")

            # Broken links
            if re.search(r'\[([^\]]*)\]\s+\(', line):
                warnings.append(f"Line {i}: Spatie tussen link tekst en URL: [text] (url)")

            # Missing link URL
            if re.search(r'\[[^\]]+\]\(\s*\)', line):
                warnings.append(f"Line {i}: Lege link URL: [text]()")

        # Check for unclosed code blocks
        code_block_count = text.count('```')
        if code_block_count % 2 != 0:
            warnings.append("Onafgesloten code block (oneven aantal ```)")

        return warnings

    @staticmethod
    def show_warnings(warnings: list[str], source: str = "text") -> None:
        """Display markdown warnings to stderr."""
        if warnings:
            print(f"⚠️  Markdown warnings in {source}:", file=sys.stderr)
            for w in warnings[:5]:  # Max 5 warnings
                print(f"   - {w}", file=sys.stderr)
            if len(warnings) > 5:
                print(f"   ... en {len(warnings) - 5} meer", file=sys.stderr)


def _find_dotenv_path() -> Path | None:
    """Locate the .env file.

    Tries (in order):
        1. $MCP_PROJECT_DIR/.env (the project folder the MCP server has mounted)
        2. /app/.env (a project mounted into a container)
        3. project root (CLI direct usage)
    """
    candidates: list[Path] = []
    mounted = os.environ.get("MCP_PROJECT_DIR")
    if mounted:
        candidates.append(Path(mounted) / ".env")
    candidates.append(Path("/app/.env"))
    try:
        candidates.append(get_project_root() / ".env")
    except Exception:
        pass
    for p in candidates:
        try:
            if p.is_file():
                return p
        except (OSError, PermissionError):
            continue
    return None


def _read_dotenv_value(key: str) -> str | None:
    """Best-effort read of a key from .env without mutating os.environ."""
    path = _find_dotenv_path()
    if not path:
        return None
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.startswith(f"{key}="):
                value = line.split("=", 1)[1].strip().strip('"').strip("'")
                return value or None
    except (OSError, UnicodeDecodeError):
        return None
    return None


def _resolve_switch_user(switch_user: str | None) -> str | None:
    """Resolve effective switch-user.

    Priority:
        1. Explicit switch_user argument
        2. REDMINE_DEFAULT_AUTHOR env var (this process)
        3. REDMINE_DEFAULT_AUTHOR in .env file
        4. None (no impersonation -- request runs as admin key owner)

    Note: there is intentionally no in-process "lazy resolve" path: the MCP
    server's start (`packages/mcp-server/scripts/ensure-redmine-author.ts`) is the
    single writer of the default author.
    """
    if switch_user:
        return switch_user
    env_default = os.environ.get("REDMINE_DEFAULT_AUTHOR")
    if env_default:
        return env_default
    dotenv_value = _read_dotenv_value("REDMINE_DEFAULT_AUTHOR")
    if dotenv_value:
        return dotenv_value
    return None


# Operations that mutate Redmine state and create journal entries attributed
# to a user. Read-only commands (show, list, epics) and metadata-only writes
# (attach, relate) are exempt: the former don't change anything, the latter
# don't appear in the journal under a user identity in the ways that matter
# for accountability.
WRITE_OPERATIONS: frozenset[str] = frozenset(
    {"create", "close", "reopen", "update", "note"}
)


def _require_author_for_write(operation: str, switch_user: str | None) -> int | None:
    """Hard-fail write operations when no author can be resolved.

    Returns 0 if the call should proceed, or a non-zero exit code (after
    printing an error to stderr) if the operation must be aborted.

    We refuse to silently attribute write
    operations to the admin API key owner when neither the operator nor
    the environment provides a deterministic identity. Better a loud
    failure than misattributed history.
    """
    if operation not in WRITE_OPERATIONS:
        return None  # not a write
    if _resolve_switch_user(switch_user):
        return None  # author resolved through normal priority chain
    print(
        "[ERROR] Cannot determine ticket author for write operation "
        f"'{operation}'. No deterministic signal available:\n"
        "  - REDMINE_DEFAULT_AUTHOR not set in env or .env\n"
        "  - --switch-user / author_login not passed\n"
        "  - mcp-server pre_start hook could not match git user.email or "
        "$USER to a Redmine account\n"
        "Refusing to attribute to admin API-key owner. Resolve by either:\n"
        "  - Setting REDMINE_DEFAULT_AUTHOR=<login> in .env and restarting "
        "mcp-server (`just restart mcp-server`)\n"
        "  - Passing --switch-user=<login> on the CLI\n"
        "  - Passing author_login=<login> on the MCP call\n"
        "  - Aligning git user.email or $USER with a Redmine account, "
        "then restarting mcp-server",
        file=sys.stderr,
    )
    return 2


# Cache of previously-validated switch users (avoid spam warnings during a run)
_SWITCH_USER_VALIDATED: set[str] = set()
_SWITCH_USER_REJECTED: set[str] = set()

# Cache of admin status per login (avoid repeated /users.json calls in a run)
_USER_ADMIN_CACHE: dict[str, bool] = {}


def _is_user_admin(login: str) -> bool | None:
    """Return True if `login` has admin privileges in Redmine, False if not,
    or None if the status cannot be determined (network error, user not
    found, or current API key lacks permission to read the admin field).

    Always runs as the API-key owner (skip_switch_user=True) — the admin
    field is only visible to admins, and our setup requires an admin key
    for X-Redmine-Switch-User to work anyway.
    """
    if not login:
        return None
    if login in _USER_ADMIN_CACHE:
        return _USER_ADMIN_CACHE[login]

    result, error = redmine_request(
        "GET",
        f"/users.json?name={login}&limit=10",
        skip_switch_user=True,
    )
    if error or not result:
        return None

    for user in result.get("users", []):
        if user.get("login") == login:
            admin = bool(user.get("admin", False))
            _USER_ADMIN_CACHE[login] = admin
            return admin
    return None


def _attribution_for_response(switch_user: str | None) -> dict:
    """Build attribution metadata for MCP JSON responses.

    Returns a dict with:
        - author_login: the login the action was attributed to (resolved
          via the same priority chain as `_resolve_switch_user`).
        - author_hint: (optional) advisory message when the resolved
          author is an admin user. Surfaces silent fallback to admin
          (typically misconfigured REDMINE_DEFAULT_AUTHOR or the
          mcp-server pre_start hook couldn't resolve the operator) so
          the agent can correct attribution on the next call.

    Empty dict if no author can be resolved — the write would have been
    blocked by `_require_author_for_write` anyway.
    """
    info: dict = {}
    resolved = _resolve_switch_user(switch_user)
    if not resolved:
        return info

    info["author_login"] = resolved
    if _is_user_admin(resolved) is True:
        info["author_hint"] = (
            f"Attributed to admin user '{resolved}' — pass "
            "`--switch-user=<login>` (CLI) / `author_login=<login>` (MCP) "
            "to override."
        )
    return info


# Status IDs covered by the custom unique index `idx_issues_unique_active_subject`
# (see packages/redmine/scripts/migration/redmine-data-to-prod.py:694):
#   CREATE UNIQUE INDEX ... ON issues (project_id, subject)
#   WHERE (status_id = ANY (ARRAY[1, 2]));
# 1 = New, 2 = In Progress. Issues in other states (Resolved/Closed/etc.)
# are exempt from the dedup check and don't trigger PG::UniqueViolation.
_ACTIVE_STATUS_IDS: frozenset[int] = frozenset({1, 2})


def _check_duplicate_active_issue(
    project_id: int,
    subject: str,
    exclude_id: int | None = None,
) -> dict | None:
    """Look up an existing active issue with the same (project_id, subject).

    Used to translate Redmine's raw HTTP 500 — which leaks when our custom
    `idx_issues_unique_active_subject` unique index rejects an INSERT/UPDATE
    via PG::UniqueViolation — into a deterministic, agent-actionable error
    that names the conflicting issue.

    Returns the matching issue dict (with at least `id`, `subject`, `status`)
    or None when no active duplicate exists or the lookup itself fails.
    Failures are swallowed: callers fall back to the original 500 surface.

    Bypasses `redmine_request` to avoid recursion if the lookup endpoint
    itself returns 500. Always runs as the API-key owner (no switch-user)
    because the dedup check is metadata, not an attributed action.
    """
    try:
        params = urlencode({
            "project_id": project_id,
            "subject": subject,
            "status_id": "open",
            "limit": 100,
        })
        url = f"{REDMINE_URL}/issues.json?{params}"
        req = Request(url, headers={"X-Redmine-API-Key": REDMINE_API_KEY})
        with urlopen(req) as response:
            content = response.read().decode()
        data = json.loads(content) if content else {}
    except (HTTPError, URLError, json.JSONDecodeError, ValueError):
        return None

    # Redmine's `subject=X` filter does substring/fuzzy matching, so
    # post-filter for exact equality. Status filter `open` is broader than
    # the dedup index (it also returns Feedback etc.), so re-check the
    # status_id against the index's WHERE clause.
    for issue in data.get("issues", []):
        if exclude_id is not None and issue.get("id") == exclude_id:
            continue
        if issue.get("subject") != subject:
            continue
        status_id = (issue.get("status") or {}).get("id")
        if status_id in _ACTIVE_STATUS_IDS:
            return issue
    return None


def redmine_request(
    method: str,
    endpoint: str,
    data: dict = None,
    switch_user: str | None = None,
    skip_switch_user: bool = False,
) -> tuple[dict | None, str | None]:
    """Make request to Redmine API. Returns (response, error).

    If switch_user is provided (or REDMINE_DEFAULT_AUTHOR env is set), the
    request includes X-Redmine-Switch-User: LOGIN so Redmine attributes the
    action to that user. Requires the API key to belong to an admin.

    Hard-fails (returns error tuple, no silent fallback) if the switch-user
    is not recognized by Redmine. Caller is expected to surface the error
    so the agent can correct the login or omit it deliberately.

    HTTP 500 on POST/PUT to /issues* is translated into a duplicate-subject
    error when the custom `idx_issues_unique_active_subject` index has
    rejected the write — see `_check_duplicate_active_issue` for the lookup
    contract and the migration script that creates the index.
    """
    url = f"{REDMINE_URL}{endpoint}"
    headers = {
        "X-Redmine-API-Key": REDMINE_API_KEY,
        "Content-Type": "application/json",
    }

    # Read-only metadata lookups (epic existence, current user) opt out of
    # switch-user entirely — they don't need attribution and shouldn't be
    # affected by a bad REDMINE_DEFAULT_AUTHOR env var.
    effective_user = None if skip_switch_user else _resolve_switch_user(switch_user)

    # Fast-fail if this user was already rejected earlier in this run.
    # Avoids a second pointless network round-trip and keeps the error
    # message identical to the first failure.
    if effective_user and effective_user in _SWITCH_USER_REJECTED:
        return None, (
            f"Switch-user '{effective_user}' is not a valid Redmine login "
            f"(rejected earlier in this run). Refusing to attribute action "
            f"to admin. Verify the login exists in Redmine and retry."
        )

    if effective_user:
        headers["X-Redmine-Switch-User"] = effective_user

    body = None
    if data:
        body = json.dumps(data).encode('utf-8')

    req = Request(url, data=body, headers=headers, method=method)

    try:
        with urlopen(req) as response:
            if effective_user and effective_user not in _SWITCH_USER_VALIDATED:
                _SWITCH_USER_VALIDATED.add(effective_user)
            if response.status == 204:  # No content
                return {}, None
            content = response.read().decode()
            return json.loads(content) if content else {}, None
    except HTTPError as e:
        # Hard-fail (no silent fallback) when the switch-user is unknown.
        # Redmine returns 412 (Precondition Failed) when the
        # X-Redmine-Switch-User header refers to a non-existent or invalid
        # user; some setups return 404. Either way, we refuse to silently
        # attribute the action to the admin — that masks the user's intent.
        if (
            effective_user
            and e.code in (404, 412)
            and "X-Redmine-Switch-User" in headers
        ):
            _SWITCH_USER_REJECTED.add(effective_user)
            return None, (
                f"Switch-user '{effective_user}' not recognized by Redmine "
                f"(HTTP {e.code}). No silent fallback to admin. Verify the "
                f"login exists in Redmine before retrying, or omit "
                f"--switch-user / author_login to attribute to the API key owner."
            )

        error_body = e.read().decode() if e.fp else ""

        # Translate raw HTTP 500 on issue writes into a duplicate-subject
        # error when our custom unique index has rejected the write. Redmine
        # surfaces PG::UniqueViolation as an opaque
        # `{"status":500,"error":"Internal Server Error"}` with no detail,
        # which previously misled agents into guessing the switch-user was
        # invalid. We pre-flight a lookup only on 500 (not on every write),
        # so the happy path keeps a single round-trip.
        if (
            e.code == 500
            and method in ("POST", "PUT")
            and endpoint.startswith("/issues")
            and isinstance(data, dict)
            and isinstance(data.get("issue"), dict)
            and data["issue"].get("subject")
        ):
            issue_data = data["issue"]
            subject = issue_data["subject"]
            project_id = issue_data.get("project_id")
            exclude_id = None

            # PUT /issues/{id}.json: project_id is rarely in the payload
            # (Redmine doesn't require it on update), so derive from the
            # endpoint and look up the existing issue's project.
            if method == "PUT":
                m = re.match(r"^/issues/(\d+)(?:\.json)?$", endpoint)
                if m:
                    exclude_id = int(m.group(1))
                    if project_id is None:
                        try:
                            lookup_url = f"{REDMINE_URL}/issues/{exclude_id}.json"
                            lookup_req = Request(
                                lookup_url,
                                headers={"X-Redmine-API-Key": REDMINE_API_KEY},
                            )
                            with urlopen(lookup_req) as resp:
                                existing = json.loads(resp.read().decode() or "{}")
                            project_id = (
                                existing.get("issue", {}).get("project", {}).get("id")
                            )
                        except (HTTPError, URLError, json.JSONDecodeError, ValueError):
                            project_id = None

            if project_id is not None:
                duplicate = _check_duplicate_active_issue(
                    int(project_id), subject, exclude_id=exclude_id
                )
                if duplicate:
                    status_name = (duplicate.get("status") or {}).get("name", "?")
                    return None, (
                        f"Active issue with subject \"{subject}\" already exists "
                        f"in project {project_id} (#{duplicate['id']}, status: "
                        f"{status_name}). Redmine's custom "
                        f"`idx_issues_unique_active_subject` index blocks duplicate "
                        f"active subjects; pick a unique subject or update "
                        f"#{duplicate['id']} instead."
                    )

        try:
            error_json = json.loads(error_body)
            errors = error_json.get("errors", [error_body])
            return None, f"HTTP {e.code}: {', '.join(errors)}"
        except:
            return None, f"HTTP {e.code}: {error_body or e.reason}"
    except URLError as e:
        return None, f"Connection error: {e.reason}"


def redmine_get(endpoint: str, switch_user: str | None = None) -> tuple[dict | None, str | None]:
    """GET request to Redmine."""
    return redmine_request("GET", endpoint, switch_user=switch_user)


def redmine_post(endpoint: str, data: dict, switch_user: str | None = None) -> tuple[dict | None, str | None]:
    """POST request to Redmine."""
    return redmine_request("POST", endpoint, data, switch_user=switch_user)


def redmine_put(endpoint: str, data: dict, switch_user: str | None = None) -> tuple[dict | None, str | None]:
    """PUT request to Redmine."""
    return redmine_request("PUT", endpoint, data, switch_user=switch_user)


def get_ticket_status(ticket_id: int) -> tuple[bool, bool]:
    """Get ticket status. Returns (exists, is_closed).

    Always runs as the API key owner (admin); read-only metadata lookups
    must not be affected by switch-user, since the action being attributed
    is the *next* call (e.g. ticket creation), not the lookup itself.
    """
    result, error = redmine_request("GET", f"/issues/{ticket_id}.json", skip_switch_user=True)
    if error or not result:
        return False, False
    return True, result.get("issue", {}).get("status", {}).get("is_closed", False)


def get_current_user() -> str | None:
    """Get current user login (always as API key owner — no switch-user)."""
    result, error = redmine_request("GET", "/users/current.json", skip_switch_user=True)
    if error or not result:
        return None
    return result.get("user", {}).get("login")


def resolve_user(user_spec: str) -> int | None:
    """Resolve user spec to user ID. 'me' -> current user."""
    if user_spec.lower() == "me":
        result, error = redmine_get("/users/current.json")
        if error or not result:
            return None
        return result.get("user", {}).get("id")

    # Try as login name
    result, error = redmine_get(f"/users.json?name={user_spec}&limit=1")
    if error or not result:
        return None
    users = result.get("users", [])
    return users[0]["id"] if users else None


# ============= Session Detection =============

def auto_detect_session_id() -> str | None:
    """
    Auto-detect Claude Code session ID for AI traceability.

    Strategy:
    1. Check CLAUDE_SESSION_ID env var (future-proof)
    2. Find most recently modified .jsonl in session directory

    Returns:
        Session ID string or None if not in a Claude Code session.
    """
    # 1. Check environment variable (future-proof if Claude adds this)
    env_session = os.environ.get("CLAUDE_SESSION_ID")
    if env_session:
        return env_session

    # 2. Find most recently modified session file
    home = Path.home()
    claude_projects = home / ".claude" / "projects"

    if not claude_projects.exists():
        return None

    # Encode current working directory path like Claude does
    cwd = Path.cwd().resolve()
    encoded_path = str(cwd).replace("/", "-").lstrip("-")

    # Try both path formats (with and without leading dash)
    for prefix in ["-", ""]:
        session_dir = claude_projects / f"{prefix}{encoded_path}"
        if session_dir.exists():
            break
    else:
        return None

    # Find all .jsonl files and get most recent
    session_files = list(session_dir.glob("*.jsonl"))
    if not session_files:
        return None

    # Sort by modification time, most recent first
    session_files.sort(key=lambda f: f.stat().st_mtime, reverse=True)

    # Session ID is the filename without extension
    return session_files[0].stem


# ============= Commands =============

@logged_command("create")
def cmd_create(args) -> int:
    """Create a new ticket."""
    subject = args.subject
    tracker_id = TRACKERS.get(args.tracker, 2)
    epic_id = args.epic

    # Read description from file or argument
    description = ""
    if args.desc_file:
        try:
            description = Path(args.desc_file).read_text()
        except Exception as e:
            print(f"[ERROR] Cannot read file: {e}", file=sys.stderr)
            return 1
    elif args.desc:
        description = args.desc

    # Validate markdown
    if description:
        warnings = MarkdownValidator.validate(description)
        MarkdownValidator.show_warnings(warnings, "description")

    # Epic required for non-epic trackers
    if tracker_id != 4 and not epic_id:
        print("\n[INFO] Epic ID required. Available epics:\n")
        result, _ = redmine_get("/issues.json?tracker_id=4&status_id=open&limit=15")
        if result:
            for issue in result.get("issues", []):
                print(f"  --epic={issue['id']}  {issue['subject'][:50]}")
        print(f"\nUsage: just ticket create \"{subject}\" --tracker={args.tracker} --epic=ID")
        return 1

    # Validate epic is open
    if epic_id and tracker_id != 4:
        exists, is_closed = get_ticket_status(epic_id)
        if not exists:
            print(f"[ERROR] Epic #{epic_id} niet gevonden", file=sys.stderr)
            return 1
        if is_closed:
            print(f"[ERROR] Epic #{epic_id} is gesloten - heropen eerst met: just ticket reopen {epic_id}", file=sys.stderr)
            return 1

    # Handle long subjects (Redmine max 255)
    full_subject = None
    if len(subject) > 255:
        print(f"[INFO] Subject te lang ({len(subject)} tekens), wordt automatisch afgehandeld...")
        full_subject = subject
        subject = subject[:245] + "..."
        attach_note = "[Volledige titel zie attachment: full_subject.txt]"
        description = f"{attach_note}\n\n{description}" if description else attach_note

    # Build issue data
    issue_data = {
        "issue": {
            "project_id": 1,
            "tracker_id": tracker_id,
            "subject": subject,
            "description": description,
        }
    }

    if epic_id:
        issue_data["issue"]["parent_issue_id"] = epic_id

    # Add AI traceability custom fields
    custom_fields = []
    ai_agent = getattr(args, 'ai_agent', None)
    ai_session = getattr(args, 'ai_session', None)

    # Auto-detect session ID if not provided
    if not ai_session:
        ai_session = auto_detect_session_id()
        if ai_session and not ai_agent:
            ai_agent = "claude-code"  # If we detected a session, assume Claude Code

    if ai_agent:
        if ai_agent not in AI_AGENTS:
            print(f"[WARN] Unknown AI agent '{ai_agent}', valid: {', '.join(AI_AGENTS)}", file=sys.stderr)
        # Use enumeration ID for Redmine API
        agent_id = AI_AGENT_IDS.get(ai_agent, ai_agent)
        custom_fields.append({"id": CF_AI_AGENT, "value": agent_id})

    if ai_session:
        custom_fields.append({"id": CF_AI_SESSION_ID, "value": ai_session})

    if custom_fields:
        issue_data["issue"]["custom_fields"] = custom_fields

    # Handle assignment
    if args.assign:
        user_id = resolve_user(args.assign)
        if user_id:
            issue_data["issue"]["assigned_to_id"] = user_id
        else:
            print(f"[WARN] User '{args.assign}' niet gevonden, ticket wordt niet toegewezen", file=sys.stderr)

    # Create ticket (with optional impersonation)
    switch_user = getattr(args, 'switch_user', None)
    result, error = redmine_post("/issues.json", issue_data, switch_user=switch_user)
    if error:
        print(f"[ERROR] {error}", file=sys.stderr)
        return 1

    ticket_id = result["issue"]["id"]
    tracker_name = args.tracker

    # Attach full subject if truncated
    if full_subject:
        attach_full_subject(ticket_id, full_subject)

    if getattr(args, 'json', False):
        # JSON output for MCP integration
        output = {
            "success": True,
            "id": ticket_id,
            "subject": subject,
            "tracker": tracker_name,
            "epic": epic_id,
            "url": f"{REDMINE_URL}/issues/{ticket_id}",
            **_attribution_for_response(switch_user),
        }
        print(json.dumps(output, indent=2, ensure_ascii=False))
        return 0

    # Human-readable output
    print(f"✅ Ticket #{ticket_id} aangemaakt: {_redmine_public_url()}/issues/{ticket_id}")
    print(f"   Subject: {subject}")
    print(f"   Tracker: {tracker_name}")
    if epic_id:
        print(f"   Epic:    #{epic_id}")

    return 0


def attach_full_subject(ticket_id: int, full_subject: str) -> None:
    """Attach full subject text to ticket."""
    import tempfile

    with tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False) as f:
        f.write(full_subject)
        temp_path = f.name

    try:
        attach_file(ticket_id, temp_path, filename="full_subject.txt")
    finally:
        os.unlink(temp_path)


# Default Redmine `attachment_max_size` (5MB) — config in
# /admin/settings/edit?tab=general. Override via --max-size on the CLI when a
# Redmine instance has been reconfigured to allow larger uploads.
ATTACHMENT_DEFAULT_MAX_BYTES: int = 5 * 1024 * 1024


def attach_file(
    ticket_id: int,
    file_path: str,
    filename: str | None = None,
    description: str | None = None,
    content_type: str | None = None,
    switch_user: str | None = None,
    max_size_bytes: int = ATTACHMENT_DEFAULT_MAX_BYTES,
) -> tuple[dict | None, str | None]:
    """Upload a file and attach it to a ticket.

    Two-step flow per the Redmine REST API:
      1. POST /uploads.json with `Content-Type: application/octet-stream` and
         the file binary as the body. Redmine returns `{upload: {token: ...}}`.
      2. PUT /issues/<id>.json with `{issue: {uploads: [{token, filename,
         content_type, description}]}}` to link the uploaded blob to the issue.

    Verification: after the PUT, GET /issues/<id>.json?include=attachments and
    locate the attachment whose `token` (Redmine echoes part of it) matches —
    we use the more reliable check of "newest attachment by id with our exact
    filename + filesize". This guards against silent failures where the PUT
    returns 200 but Redmine refused the upload (rare but seen on misconfigured
    `attachments_path`).

    Returns ``(data, error)`` where ``data`` on success is the structured
    response:
        success, attachment_id, filename, filesize, content_type,
        content_url, issue_id, plus _attribution_for_response() output.
    """
    import mimetypes

    path = Path(file_path)
    if not path.exists():
        return None, f"File not found: {file_path}"
    if not path.is_file():
        return None, f"Path is not a regular file: {file_path}"

    size = path.stat().st_size
    if size == 0:
        return None, f"File is empty: {file_path}"
    if size > max_size_bytes:
        return None, (
            f"File too large: {size} bytes > {max_size_bytes} bytes "
            f"(Redmine attachment_max_size). Override with --max-size."
        )

    resolved_filename = filename or path.name
    resolved_content_type = (
        content_type
        or mimetypes.guess_type(resolved_filename)[0]
        or "application/octet-stream"
    )

    content = path.read_bytes()

    # Step 1: POST /uploads.json with raw octet-stream body. Redmine accepts
    # this form natively — no multipart wrapper needed (cleaner than the
    # previous WebKitBoundary form, and matches the just recipe).
    upload_url = f"{REDMINE_URL}/uploads.json"
    upload_headers = {
        "X-Redmine-API-Key": REDMINE_API_KEY,
        "Content-Type": "application/octet-stream",
    }
    effective_user = _resolve_switch_user(switch_user)
    if effective_user:
        if effective_user in _SWITCH_USER_REJECTED:
            return None, (
                f"Switch-user '{effective_user}' is not a valid Redmine login "
                f"(rejected earlier in this run). Refusing to attribute "
                f"upload to admin."
            )
        upload_headers["X-Redmine-Switch-User"] = effective_user

    req = Request(upload_url, data=content, headers=upload_headers, method="POST")
    try:
        with urlopen(req) as response:
            upload_body = response.read().decode() or "{}"
            upload_result = json.loads(upload_body)
            token = upload_result.get("upload", {}).get("token")
    except HTTPError as e:
        if (
            effective_user
            and e.code in (404, 412)
            and "X-Redmine-Switch-User" in upload_headers
        ):
            _SWITCH_USER_REJECTED.add(effective_user)
            return None, (
                f"Switch-user '{effective_user}' not recognized by Redmine "
                f"(HTTP {e.code}) on /uploads.json. No silent fallback to admin."
            )
        body = e.read().decode() if e.fp else ""
        return None, f"Upload failed: HTTP {e.code}: {body or e.reason}"
    except URLError as e:
        return None, f"Upload failed: connection error: {e.reason}"
    except (json.JSONDecodeError, ValueError) as e:
        return None, f"Upload failed: malformed response: {e}"

    if not token:
        return None, "Upload failed: Redmine returned no token"

    # Step 2: PUT /issues/<id>.json. Use redmine_request for the same
    # switch-user / 500-translation behaviour as ticket writes.
    upload_link: dict[str, str] = {
        "token": token,
        "filename": resolved_filename,
        "content_type": resolved_content_type,
    }
    if description:
        upload_link["description"] = description

    attach_data = {"issue": {"uploads": [upload_link]}}
    _, error = redmine_request(
        "PUT", f"/issues/{ticket_id}.json", attach_data, switch_user=switch_user
    )
    if error:
        return None, f"Attach failed: {error}"

    # Step 3: verify attachment is actually linked. Redmine sometimes returns
    # 200 on PUT even when the upload did not get persisted (rare but seen on
    # misconfigured attachments_path). Looking up the issue with attachments
    # gives us a deterministic confirmation + the attachment_id we need to
    # return to the caller.
    verify, verify_err = redmine_request(
        "GET", f"/issues/{ticket_id}.json?include=attachments",
        switch_user=switch_user,
    )
    if verify_err or not verify:
        return None, f"Attach verify failed: {verify_err or 'empty response'}"

    attachments = (verify.get("issue") or {}).get("attachments") or []
    # Match newest-first on (filename, filesize) — Redmine assigns ids
    # monotonically so the highest id with our filename is our upload.
    matches = [
        a for a in attachments
        if a.get("filename") == resolved_filename
        and a.get("filesize") == size
    ]
    if not matches:
        return None, (
            f"Attach verify failed: uploaded file '{resolved_filename}' "
            f"({size} bytes) not present in issue {ticket_id} attachments. "
            f"Redmine accepted the PUT but did not persist the upload."
        )
    attachment = max(matches, key=lambda a: a.get("id", 0))

    response_data: dict = {
        "success": True,
        "attachment_id": attachment.get("id"),
        "filename": attachment.get("filename"),
        "filesize": attachment.get("filesize"),
        "content_type": attachment.get("content_type"),
        "content_url": attachment.get("content_url"),
        "description": attachment.get("description") or "",
        "issue_id": ticket_id,
    }
    response_data.update(_attribution_for_response(switch_user))
    return response_data, None


@logged_command("close")
def cmd_close(args) -> int:
    """Close a ticket."""
    ticket_id = args.id
    json_output = getattr(args, 'json', False)

    # Check if already closed (idempotent)
    exists, is_closed = get_ticket_status(ticket_id)
    if not exists:
        if json_output:
            print(json.dumps({"error": f"Ticket #{ticket_id} niet gevonden"}))
        else:
            print(f"[ERROR] Ticket #{ticket_id} niet gevonden", file=sys.stderr)
        return 1

    if is_closed:
        if json_output:
            print(json.dumps({"success": True, "id": ticket_id, "already_closed": True}))
        else:
            print(f"ℹ️  Ticket #{ticket_id} is al gesloten (idempotent)")
        return 0

    # Read notes from file or argument
    notes = ""
    if args.notes_file:
        try:
            notes = Path(args.notes_file).read_text()
        except Exception as e:
            if json_output:
                print(json.dumps({"error": f"Cannot read file: {e}"}))
            else:
                print(f"[ERROR] Cannot read file: {e}", file=sys.stderr)
            return 1
    elif args.notes:
        notes = args.notes

    # Validate markdown (skip in JSON mode)
    if notes and not json_output:
        warnings = MarkdownValidator.validate(notes)
        MarkdownValidator.show_warnings(warnings, "notes")

    # Close ticket (with optional impersonation)
    close_data = {
        "issue": {
            "status_id": STATUS_RESOLVED,
            "notes": notes,
        }
    }

    switch_user = getattr(args, 'switch_user', None)
    result, error = redmine_put(f"/issues/{ticket_id}.json", close_data, switch_user=switch_user)

    if error:
        if json_output:
            print(json.dumps({"error": error}))
        else:
            print(f"[ERROR] {error}", file=sys.stderr)
        return 1

    # Verify the ticket was actually closed (Redmine may silently reject workflow transitions)
    verify_result, _ = redmine_get(f"/issues/{ticket_id}.json")
    status_info = verify_result.get("issue", {}).get("status", {}) if verify_result else {}
    is_now_closed = status_info.get("is_closed", False)

    if not is_now_closed:
        if json_output:
            print(json.dumps({"error": f"Ticket #{ticket_id} status niet gewijzigd - mogelijk workflow restrictie (status_after={status_info})"}))
        else:
            print(f"[ERROR] Ticket #{ticket_id} status niet gewijzigd naar Resolved", file=sys.stderr)
            print(f"        Status after PUT: {status_info}", file=sys.stderr)
        return 1

    if json_output:
        output = {
            "success": True,
            "id": ticket_id,
            "status": "closed",
            **_attribution_for_response(switch_user),
        }
        print(json.dumps(output))
    else:
        print(f"✅ Ticket #{ticket_id} gesloten: {_redmine_public_url()}/issues/{ticket_id}")
    return 0


@logged_command("reopen")
def cmd_reopen(args) -> int:
    """Reopen a closed ticket."""
    ticket_id = args.id
    json_output = getattr(args, 'json', False)

    exists, is_closed = get_ticket_status(ticket_id)
    if not exists:
        if json_output:
            print(json.dumps({"error": f"Ticket #{ticket_id} niet gevonden"}))
        else:
            print(f"[ERROR] Ticket #{ticket_id} niet gevonden", file=sys.stderr)
        return 1

    if not is_closed:
        if json_output:
            print(json.dumps({"success": True, "id": ticket_id, "already_open": True}))
        else:
            print(f"ℹ️  Ticket #{ticket_id} is al open (idempotent)")
        return 0

    reopen_data = {
        "issue": {
            "status_id": STATUS_IN_PROGRESS,
            "notes": "Heropend",
        }
    }

    switch_user = getattr(args, 'switch_user', None)
    result, error = redmine_put(f"/issues/{ticket_id}.json", reopen_data, switch_user=switch_user)
    if error:
        if json_output:
            print(json.dumps({"error": error}))
        else:
            print(f"[ERROR] {error}", file=sys.stderr)
        return 1

    if json_output:
        output = {
            "success": True,
            "id": ticket_id,
            "status": "reopened",
            **_attribution_for_response(switch_user),
        }
        print(json.dumps(output))
    else:
        print(f"✅ Ticket #{ticket_id} heropend")
    return 0


@logged_command("update")
def cmd_update(args) -> int:
    """Update a ticket."""
    ticket_id = args.id

    # Check ticket exists
    exists, is_closed = get_ticket_status(ticket_id)
    if not exists:
        print(f"[ERROR] Ticket #{ticket_id} niet gevonden", file=sys.stderr)
        return 1

    # Auto-reopen if closed, unless we're explicitly setting a status
    status_arg = getattr(args, 'status', None)
    if is_closed and not status_arg:
        print(f"[INFO] Ticket #{ticket_id} is gesloten, wordt heropend...")
        cmd_reopen(argparse.Namespace(id=ticket_id))

    # Build update data
    update_data = {"issue": {}}

    # Handle status change
    if status_arg:
        status_id = STATUS_MAP.get(status_arg)
        if status_id:
            update_data["issue"]["status_id"] = status_id

    if args.subject:
        update_data["issue"]["subject"] = args.subject

    # Read description
    description = None
    if args.desc_file:
        try:
            description = Path(args.desc_file).read_text()
        except Exception as e:
            print(f"[ERROR] Cannot read file: {e}", file=sys.stderr)
            return 1
    elif args.desc:
        description = args.desc

    if description:
        warnings = MarkdownValidator.validate(description)
        MarkdownValidator.show_warnings(warnings, "description")
        update_data["issue"]["description"] = description

    # Read notes (journal entry)
    notes = None
    notes_file = getattr(args, 'notes_file', None)
    if notes_file:
        try:
            notes = Path(notes_file).read_text()
        except Exception as e:
            print(f"[ERROR] Cannot read notes file: {e}", file=sys.stderr)
            return 1
    elif getattr(args, 'notes', None):
        notes = args.notes

    if notes:
        update_data["issue"]["notes"] = notes

    # Handle assignment
    if args.assign:
        user_id = resolve_user(args.assign)
        if user_id:
            update_data["issue"]["assigned_to_id"] = user_id

    # Handle priority
    priority = getattr(args, 'priority', None)
    if priority:
        priority_map = {"low": 1, "normal": 2, "high": 3, "urgent": 4, "immediate": 5}
        update_data["issue"]["priority_id"] = priority_map[priority]

    # Handle parent epic change
    epic_id = getattr(args, 'epic', None)
    if epic_id is not None:
        if epic_id == 0:
            # Remove parent (set to null)
            update_data["issue"]["parent_issue_id"] = ""
        else:
            # Validate epic exists and is open
            epic_exists, epic_closed = get_ticket_status(epic_id)
            if not epic_exists:
                print(f"[ERROR] Epic #{epic_id} niet gevonden", file=sys.stderr)
                return 1
            if epic_closed:
                print(f"[ERROR] Epic #{epic_id} is gesloten - heropen eerst met: just ticket reopen {epic_id}", file=sys.stderr)
                return 1
            update_data["issue"]["parent_issue_id"] = epic_id

    # Custom fields
    custom_fields = []
    if args.value:
        custom_fields.append({"id": CF_BUSINESS_VALUE, "value": args.value})
    if args.area:
        custom_fields.append({"id": CF_EXPERTISE_AREA, "value": args.area})
    if args.est:
        custom_fields.append({"id": CF_ESTIMATED_HOURS, "value": args.est})
    if args.actual:
        custom_fields.append({"id": CF_ACTUAL_HOURS, "value": args.actual})
    if args.ai:
        custom_fields.append({"id": CF_AI_HOURS, "value": args.ai})

    if custom_fields:
        update_data["issue"]["custom_fields"] = custom_fields

    if not update_data["issue"]:
        print("[ERROR] Geen updates opgegeven", file=sys.stderr)
        return 1

    switch_user = getattr(args, 'switch_user', None)
    result, error = redmine_put(f"/issues/{ticket_id}.json", update_data, switch_user=switch_user)
    if error:
        if getattr(args, 'json', False):
            print(json.dumps({"error": error}))
        else:
            print(f"[ERROR] {error}", file=sys.stderr)
        return 1

    if getattr(args, 'json', False):
        output = {
            "success": True,
            "id": ticket_id,
            "status": "updated",
            **_attribution_for_response(switch_user),
        }
        print(json.dumps(output))
    else:
        print(f"✅ Ticket #{ticket_id} bijgewerkt")
    return 0


@logged_command("note")
def cmd_note(args) -> int:
    """Add a note to a ticket."""
    ticket_id = args.id
    json_output = getattr(args, 'json', False)

    # Check ticket and reopen if closed
    exists, is_closed = get_ticket_status(ticket_id)
    if not exists:
        if json_output:
            print(json.dumps({"error": f"Ticket #{ticket_id} niet gevonden"}))
        else:
            print(f"[ERROR] Ticket #{ticket_id} niet gevonden", file=sys.stderr)
        return 1

    if is_closed:
        if not json_output:
            print(f"[INFO] Ticket #{ticket_id} is gesloten, wordt heropend...")
        # Pass json flag to reopen
        reopen_args = argparse.Namespace(id=ticket_id)
        if json_output:
            reopen_args.json = True
        cmd_reopen(reopen_args)

    # Read note from file or argument
    note_text = ""
    if args.file:
        try:
            note_text = Path(args.file).read_text()
        except Exception as e:
            if json_output:
                print(json.dumps({"error": f"Cannot read file: {e}"}))
            else:
                print(f"[ERROR] Cannot read file: {e}", file=sys.stderr)
            return 1
    else:
        note_text = args.text

    if not note_text:
        if json_output:
            print(json.dumps({"error": "Note text required"}))
        else:
            print("[ERROR] Note text required", file=sys.stderr)
        return 1

    # Validate markdown (skip in JSON mode)
    if not json_output:
        warnings = MarkdownValidator.validate(note_text)
        MarkdownValidator.show_warnings(warnings, "note")

    note_data = {
        "issue": {
            "notes": note_text,
        }
    }

    switch_user = getattr(args, 'switch_user', None)
    result, error = redmine_put(f"/issues/{ticket_id}.json", note_data, switch_user=switch_user)
    if error:
        if json_output:
            print(json.dumps({"error": error}))
        else:
            print(f"[ERROR] {error}", file=sys.stderr)
        return 1

    if json_output:
        output = {
            "success": True,
            "id": ticket_id,
            "status": "note_added",
            **_attribution_for_response(switch_user),
        }
        print(json.dumps(output))
    else:
        print(f"✅ Notitie toegevoegd aan #{ticket_id}")
    return 0


@logged_command("show")
def cmd_show(args) -> int:
    """Show ticket details."""
    ticket_id = args.id

    result, error = redmine_get(f"/issues/{ticket_id}.json?include=journals,children")
    if error:
        if getattr(args, 'json', False):
            print(json.dumps({"error": error}))
        else:
            print(f"[ERROR] {error}", file=sys.stderr)
        return 1

    issue = result.get("issue", {})

    # Extract custom field values
    cf_map = {CF_BUSINESS_VALUE: "business_value", CF_EXPERTISE_AREA: "expertise_area",
              CF_ESTIMATED_HOURS: "estimated_hours", CF_ACTUAL_HOURS: "actual_hours", CF_AI_HOURS: "ai_hours"}
    cf_values = {}
    for cf in issue.get("custom_fields", []):
        if cf["id"] in cf_map:
            cf_values[cf_map[cf["id"]]] = cf.get("value", "")

    if getattr(args, 'json', False):
        # JSON output for MCP integration
        output = {
            "id": issue.get("id"),
            "tracker": issue.get("tracker", {}).get("name"),
            "subject": issue.get("subject"),
            "description": issue.get("description"),
            "status": issue.get("status", {}).get("name"),
            "priority": issue.get("priority", {}).get("name"),
            "assigned_to": issue.get("assigned_to", {}).get("name"),
            "author": issue.get("author", {}).get("name"),
            "created_on": issue.get("created_on"),
            "updated_on": issue.get("updated_on"),
            "parent": issue.get("parent", {}).get("id"),
            "children": [
                {"id": c.get("id"), "subject": c.get("subject")}
                for c in issue.get("children", [])
            ],
            "recent_updates": [
                {
                    "user": j.get("user", {}).get("name"),
                    "date": j.get("created_on"),
                    "notes": j.get("notes")
                }
                for j in issue.get("journals", [])[-5:]
                if j.get("notes")
            ],
            **cf_values
        }
        print(json.dumps(output, indent=2, ensure_ascii=False))
        return 0

    # Human-readable output
    tracker = issue.get("tracker", {}).get("name", "?")
    subject = issue.get("subject", "?")
    print(f"#{ticket_id} - {tracker}: {subject}")
    print("─" * 60)

    # Status info
    status = issue.get("status", {}).get("name", "?")
    assigned = issue.get("assigned_to", {}).get("name", "niemand")
    created = issue.get("created_on", "?")[:10]
    parent = issue.get("parent", {}).get("id", "none")

    print(f"Status:     {status}")
    print(f"Tracker:    {tracker}")
    print(f"Epic:       #{parent}")
    print(f"Assigned:   {assigned}")
    print(f"Created:    {created}")

    # Custom fields
    print("\nLifecycle:")
    cf_display = {CF_BUSINESS_VALUE: "Value", CF_EXPERTISE_AREA: "Expertise",
                  CF_ESTIMATED_HOURS: "Est", CF_ACTUAL_HOURS: "Actual", CF_AI_HOURS: "AI"}
    cf_display_values = {}
    for cf in issue.get("custom_fields", []):
        if cf["id"] in cf_display:
            cf_display_values[cf_display[cf["id"]]] = cf.get("value", "")

    print(f"  Value:      {cf_display_values.get('Value', '')}  |  Expertise: {cf_display_values.get('Expertise', '')}")
    print(f"  Hours:    Est: {cf_display_values.get('Est', '')}  Actual: {cf_display_values.get('Actual', '')}  AI: {cf_display_values.get('AI', '')}")

    # Description
    desc = issue.get("description", "")
    if desc:
        print(f"\nDescription:\n{desc[:500]}{'...' if len(desc) > 500 else ''}")

    return 0


@logged_command("list")
def cmd_list(args) -> int:
    """List tickets with optional filters."""
    # Build query parameters
    params = []

    # Status filter
    status = getattr(args, 'status', 'open')
    if status == 'open':
        params.append("status_id=open")
    elif status == 'closed':
        params.append("status_id=closed")
    # 'all' = no status filter

    # Tracker filter
    tracker = getattr(args, 'tracker', None)
    if tracker:
        tracker_ids = {"bug": 1, "feature": 2, "support": 3, "epic": 4}
        if tracker in tracker_ids:
            params.append(f"tracker_id={tracker_ids[tracker]}")

    # Limit
    limit = getattr(args, 'limit', 25)
    params.append(f"limit={limit}")

    # Sort by updated_on desc
    params.append("sort=updated_on:desc")

    query_string = "&".join(params)
    result, error = redmine_get(f"/issues.json?{query_string}")
    if error:
        if getattr(args, 'json', False):
            print(json.dumps({"error": error}))
        else:
            print(f"[ERROR] {error}", file=sys.stderr)
        return 1

    issues = result.get("issues", [])
    total_count = result.get("total_count", len(issues))  # Redmine API returns total_count

    # Client-side query filter (Redmine API doesn't support full-text search well)
    query = getattr(args, 'query', None)
    search_body = getattr(args, 'search_body', False)
    search_journals = getattr(args, 'search_journals', False)

    # search_journals implies search_body
    if search_journals:
        search_body = True

    if query:
        query_lower = query.lower()

        if search_body:
            # Slower: fetch each issue to get description (and optionally journals)
            search_level = "body + journals" if search_journals else "body"
            if not getattr(args, 'json', False):
                print(f"[INFO] Searching {len(issues)} issues (including {search_level})...", file=sys.stderr)

            filtered_issues = []
            for issue in issues:
                # Check subject first (fast)
                if query_lower in issue.get("subject", "").lower():
                    filtered_issues.append(issue)
                    continue

                # Fetch full issue to check description (and journals if requested)
                include_param = "?include=journals" if search_journals else ""
                detail, err = redmine_get(f"/issues/{issue['id']}.json{include_param}")
                if not err and detail:
                    issue_data = detail.get("issue", {})

                    # Check description
                    desc = issue_data.get("description", "") or ""
                    if query_lower in desc.lower():
                        filtered_issues.append(issue)
                        continue

                    # Check journals if requested
                    if search_journals:
                        journals = issue_data.get("journals", [])
                        for journal in journals:
                            notes = journal.get("notes", "") or ""
                            if query_lower in notes.lower():
                                filtered_issues.append(issue)
                                break

            issues = filtered_issues
        else:
            # Fast: only search in subject
            issues = [i for i in issues if query_lower in i.get("subject", "").lower()]

        # Note: total_count is from API, filtered count may differ
        total_count = len(issues)  # After client-side filter, total = returned

    if getattr(args, 'json', False):
        # JSON output for MCP integration
        output = {
            "issues": [
                {
                    "id": issue["id"],
                    "tracker": issue.get("tracker", {}).get("name"),
                    "subject": issue.get("subject"),
                    "status": issue.get("status", {}).get("name"),
                    "priority": issue.get("priority", {}).get("name"),
                    "assigned_to": issue.get("assigned_to", {}).get("name"),
                }
                for issue in issues
            ],
            "total": total_count,  # Total available (or filtered count if query used)
            "returned": len(issues),  # Actually returned
            "limit": limit,
            "has_more": len(issues) < total_count and not query  # Only meaningful without client-side filter
        }
        print(json.dumps(output, indent=2, ensure_ascii=False))
        return 0

    # Human-readable output
    if not issues:
        print("Geen open tickets")
        return 0

    print(f"{'ID':>6} {'Tracker':<10} {'Subject':<50}")
    print("─" * 70)
    for issue in issues:
        tracker = issue.get("tracker", {}).get("name", "?")[:9]
        subject = issue.get("subject", "?")[:49]
        print(f"{issue['id']:>6} {tracker:<10} {subject:<50}")

    return 0


@logged_command("epics")
def cmd_epics(args) -> int:
    """List epics with optional filters."""
    # Build query parameters
    params = ["tracker_id=4"]  # Epic tracker

    # Status filter
    status = getattr(args, 'status', 'open')
    if status == 'open':
        params.append("status_id=open")
    elif status == 'closed':
        params.append("status_id=closed")
    # 'all' = no status filter

    # Limit (default 100 for epics)
    limit = getattr(args, 'limit', 100)
    params.append(f"limit={limit}")

    # Sort by updated_on desc
    params.append("sort=updated_on:desc")

    query_string = "&".join(params)
    result, error = redmine_get(f"/issues.json?{query_string}")
    if error:
        if getattr(args, 'json', False):
            print(json.dumps({"error": error}))
        else:
            print(f"[ERROR] {error}", file=sys.stderr)
        return 1

    issues = result.get("issues", [])
    total_count = result.get("total_count", len(issues))  # Redmine API returns total_count
    limit_used = limit

    if getattr(args, 'json', False):
        # JSON output for MCP integration
        output = {
            "epics": [
                {
                    "id": issue["id"],
                    "subject": issue.get("subject"),
                    "status": issue.get("status", {}).get("name"),
                    "priority": issue.get("priority", {}).get("name"),
                    "assigned_to": issue.get("assigned_to", {}).get("name"),
                    "created_on": issue.get("created_on"),
                    "updated_on": issue.get("updated_on"),
                }
                for issue in issues
            ],
            "total": total_count,  # Total available in Redmine
            "returned": len(issues),  # Actually returned
            "limit": limit_used,
            "has_more": len(issues) < total_count
        }
        print(json.dumps(output, indent=2, ensure_ascii=False))
        return 0

    # Human-readable output
    if not issues:
        print("Geen open epics")
        return 0

    print(f"{'ID':>6} {'Subject':<60}")
    print("─" * 70)
    for issue in issues:
        subject = issue.get("subject", "?")[:59]
        print(f"{issue['id']:>6} {subject:<60}")

    return 0


@logged_command("attach")
def cmd_attach(args) -> int:
    """Attach file to ticket.

    Wires the CLI subparser to ``attach_file()`` and renders either a
    structured JSON payload (``--json``) or the legacy human-friendly
    confirmation line. JSON shape:
    ``{success, attachment_id, filename, filesize, content_type,
    content_url, description, issue_id, author_login, author_hint}``.
    """
    json_output = getattr(args, "json", False)
    max_size = getattr(args, "max_size", ATTACHMENT_DEFAULT_MAX_BYTES)
    data, error = attach_file(
        ticket_id=args.id,
        file_path=args.file,
        filename=getattr(args, "filename", None),
        description=getattr(args, "description", None),
        content_type=getattr(args, "content_type", None),
        switch_user=getattr(args, "switch_user", None),
        max_size_bytes=max_size,
    )
    if error or data is None:
        if json_output:
            print(json.dumps({"success": False, "error": error or "unknown error"}))
        else:
            print(f"[ERROR] {error or 'unknown error'}", file=sys.stderr)
        return 1

    if json_output:
        print(json.dumps(data, ensure_ascii=False))
    else:
        print(
            f"✅ Bestand '{data['filename']}' ({data['filesize']} bytes) "
            f"toegevoegd aan #{args.id} (attachment #{data['attachment_id']})"
        )
    return 0


@logged_command("relate")
def cmd_relate(args) -> int:
    """Create relation between tickets."""
    if args.type not in RELATION_TYPES:
        print(f"[ERROR] Invalid relation type. Use: {', '.join(RELATION_TYPES)}", file=sys.stderr)
        return 1

    relation_data = {
        "relation": {
            "issue_to_id": args.target,
            "relation_type": args.type,
        }
    }

    result, error = redmine_post(f"/issues/{args.id}/relations.json", relation_data)
    if error:
        print(f"[ERROR] {error}", file=sys.stderr)
        return 1

    print(f"✅ Relatie aangemaakt: #{args.id} {args.type} #{args.target}")
    return 0


def output_result(data: dict, json_output: bool = False) -> None:
    """Output result as JSON or human-readable."""
    if json_output:
        print(json.dumps(data, indent=2, ensure_ascii=False))
    else:
        # Human-readable handled by caller
        pass


def main():
    parser = argparse.ArgumentParser(description="Ticket CLI - Redmine ticket management")
    parser.add_argument("--json", action="store_true", help="Output in JSON format")
    subparsers = parser.add_subparsers(dest="command", help="Commands")

    # create
    p_create = subparsers.add_parser("create", help="Create ticket")
    p_create.add_argument("subject", help="Ticket subject")
    p_create.add_argument("--tracker", default="feature", help="Tracker: bug, feature, support, epic")
    p_create.add_argument("--epic", type=int, help="Parent epic ID")
    p_create.add_argument("--desc", help="Description")
    p_create.add_argument("--desc-file", help="Description from file")
    p_create.add_argument("--assign", help="Assign to user (login or 'me')")
    p_create.add_argument("--ai-agent", help="AI agent that created this ticket (e.g., 'Claude Code', 'Cursor')")
    p_create.add_argument("--ai-session", help="AI session ID for traceability")
    p_create.add_argument("--switch-user", help="Redmine login to impersonate via X-Redmine-Switch-User (admin API key required). Defaults to REDMINE_DEFAULT_AUTHOR env if unset. Hard-fails if the login is not recognized — no silent fallback to admin.")

    # close
    p_close = subparsers.add_parser("close", help="Close ticket")
    p_close.add_argument("id", type=int, help="Ticket ID")
    p_close.add_argument("--notes", help="Closing notes")
    p_close.add_argument("--notes-file", help="Notes from file")
    p_close.add_argument("--switch-user", help="Redmine login to impersonate (see create --switch-user)")

    # reopen
    p_reopen = subparsers.add_parser("reopen", help="Reopen ticket")
    p_reopen.add_argument("id", type=int, help="Ticket ID")
    p_reopen.add_argument("--switch-user", help="Redmine login to impersonate (see create --switch-user)")

    # update
    p_update = subparsers.add_parser("update", help="Update ticket")
    p_update.add_argument("id", type=int, help="Ticket ID")
    p_update.add_argument("--subject", help="New subject")
    p_update.add_argument("--desc", help="New description")
    p_update.add_argument("--desc-file", help="Description from file")
    p_update.add_argument("--notes", help="Add journal note")
    p_update.add_argument("--notes-file", help="Journal note from file")
    p_update.add_argument("--assign", help="Assign to user")
    p_update.add_argument("--priority", choices=["low", "normal", "high", "urgent", "immediate"], help="Priority level")
    p_update.add_argument("--value", help="Business value")
    p_update.add_argument("--area", help="Expertise area")
    p_update.add_argument("--est", help="Estimated hours")
    p_update.add_argument("--actual", help="Actual hours")
    p_update.add_argument("--ai", help="AI hours")
    p_update.add_argument("--epic", type=int, help="Change parent epic (use 0 to remove parent)")
    p_update.add_argument("--status", choices=list(STATUS_MAP.keys()), help="Change status")
    p_update.add_argument("--switch-user", help="Redmine login to impersonate (see create --switch-user)")

    # note
    p_note = subparsers.add_parser("note", help="Add note to ticket")
    p_note.add_argument("id", type=int, help="Ticket ID")
    p_note.add_argument("text", nargs="?", help="Note text")
    p_note.add_argument("--file", help="Note from file")
    p_note.add_argument("--switch-user", help="Redmine login to impersonate (see create --switch-user)")

    # show
    p_show = subparsers.add_parser("show", help="Show ticket details")
    p_show.add_argument("id", type=int, help="Ticket ID")

    # list
    p_list = subparsers.add_parser("list", help="List tickets")
    p_list.add_argument("--tracker", choices=["bug", "feature", "support", "epic"], help="Filter by tracker")
    p_list.add_argument("--status", choices=["open", "closed", "all"], default="open", help="Filter by status (default: open)")
    p_list.add_argument("--limit", type=int, default=25, help="Max results (default: 25)")
    p_list.add_argument("--query", help="Search in subject (case-insensitive)")
    p_list.add_argument("--search-body", action="store_true", help="Also search in description (slower)")
    p_list.add_argument("--search-journals", action="store_true", help="Also search in journals/notes (slowest, implies --search-body)")

    # epics
    p_epics = subparsers.add_parser("epics", help="List epics")
    p_epics.add_argument("--status", choices=["open", "closed", "all"], default="open", help="Filter by status (default: open)")
    p_epics.add_argument("--limit", type=int, default=100, help="Max results (default: 100)")

    # attach
    p_attach = subparsers.add_parser("attach", help="Attach file to ticket")
    p_attach.add_argument("id", type=int, help="Ticket ID")
    p_attach.add_argument("file", help="File path")
    p_attach.add_argument(
        "--filename",
        help="Override displayed filename in Redmine (default: basename of file path)",
    )
    p_attach.add_argument(
        "--description",
        help="Optional attachment description shown next to the file in Redmine",
    )
    p_attach.add_argument(
        "--content-type",
        dest="content_type",
        help="Override MIME content-type (default: auto-detect from filename)",
    )
    p_attach.add_argument(
        "--max-size",
        dest="max_size",
        type=int,
        default=ATTACHMENT_DEFAULT_MAX_BYTES,
        help=(
            "Override maximum file size in bytes (default: 5 MiB, matching "
            "Redmine attachment_max_size). Increase only if the target "
            "instance has been reconfigured."
        ),
    )
    p_attach.add_argument(
        "--switch-user",
        dest="switch_user",
        help=(
            "Redmine login to attribute the upload to via X-Redmine-Switch-User "
            "(admin API key required). Defaults to REDMINE_DEFAULT_AUTHOR env. "
            "Hard-fails if rejected — no silent fallback to admin."
        ),
    )

    # relate
    p_relate = subparsers.add_parser("relate", help="Create relation")
    p_relate.add_argument("id", type=int, help="Source ticket ID")
    p_relate.add_argument("type", help="Relation type")
    p_relate.add_argument("target", type=int, help="Target ticket ID")

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        return 1

    commands = {
        "create": cmd_create,
        "close": cmd_close,
        "reopen": cmd_reopen,
        "update": cmd_update,
        "note": cmd_note,
        "show": cmd_show,
        "list": cmd_list,
        "epics": cmd_epics,
        "attach": cmd_attach,
        "relate": cmd_relate,
    }

    # Hard-fail write operations when no author is resolvable.
    # Read-only commands and metadata writes are exempt.
    abort = _require_author_for_write(
        args.command, getattr(args, "switch_user", None)
    )
    if abort is not None:
        return abort

    return commands[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
