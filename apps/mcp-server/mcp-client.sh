#!/bin/bash
#
# MCP Client - Bash versie voor Linux/WSL
#
# Installatie:
#   curl -sL https://<adres van de MCP-server>/client.sh -o mcp-client.sh && chmod +x mcp-client.sh
#
# Gebruik:
#   ./mcp-client.sh help
#   ./mcp-client.sh login
#   ./mcp-client.sh packages
#

VERSION="1.6.1"
MCP_URL="${MCP_URL:-${MCP_SERVER_URL}}"
TOKEN_FILE="$HOME/.mcp-client-token.json"
CONFIG_FILE="$HOME/.mcp-client-config.json"
APIKEY_FILE="$HOME/.mcp-client-apikey"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# ============================================
# HELPER FUNCTIONS
# ============================================

print_color() {
    local color=$1
    local text=$2
    echo -e "${color}${text}${NC}"
}

check_dependencies() {
    local missing=()
    for cmd in curl jq; do
        if ! command -v $cmd &> /dev/null; then
            missing+=($cmd)
        fi
    done
    if [ ${#missing[@]} -gt 0 ]; then
        print_color $RED "Ontbrekende dependencies: ${missing[*]}"
        echo "Installeer met: sudo apt install ${missing[*]}"
        exit 1
    fi
}

# ============================================
# TOKEN MANAGEMENT
# ============================================

load_token() {
    # First check for permanent API key
    if [ -f "$APIKEY_FILE" ]; then
        TOKEN=$(cat "$APIKEY_FILE")
        if [ -n "$TOKEN" ]; then
            return 0
        fi
    fi

    # Then check for temporary OAuth token
    if [ -f "$TOKEN_FILE" ]; then
        # Validate JSON before parsing
        if ! jq -e . "$TOKEN_FILE" >/dev/null 2>&1; then
            # Invalid JSON, remove corrupt file
            rm -f "$TOKEN_FILE"
            return 1
        fi
        local expires_at=$(jq -r '.expires_at // empty' "$TOKEN_FILE" 2>/dev/null)
        if [ -n "$expires_at" ]; then
            local expires_ts=$(date -d "$expires_at" +%s 2>/dev/null || echo 0)
            local now_ts=$(date +%s)
            if [ $expires_ts -gt $now_ts ]; then
                TOKEN=$(jq -r '.access_token' "$TOKEN_FILE")
                return 0
            else
                print_color $YELLOW "Token verlopen, login opnieuw met: ./mcp-client.sh login"
            fi
        fi
    fi
    return 1
}

save_token() {
    local access_token=$1
    local expires_in=${2:-3600}
    local expires_at=$(date -d "+${expires_in} seconds" --iso-8601=seconds)

    cat > "$TOKEN_FILE" << EOF
{
  "access_token": "$access_token",
  "expires_at": "$expires_at"
}
EOF
    chmod 600 "$TOKEN_FILE"
}

remove_token() {
    rm -f "$TOKEN_FILE"
}

# ============================================
# MCP REQUESTS
# ============================================

mcp_request() {
    local method=$1
    local params=${2:-\{\}}

    local headers=(-H "Content-Type: application/json" -H "Accept: text/event-stream, application/json")
    if [ -n "$TOKEN" ]; then
        headers+=(-H "Authorization: Bearer $TOKEN")
    fi

    local body=$(cat << EOF
{
  "jsonrpc": "2.0",
  "id": $(date +%s),
  "method": "$method",
  "params": $params
}
EOF
)

    local response=$(curl -s -X POST "$MCP_URL/mcp" "${headers[@]}" -d "$body" 2>&1)

    # Check for auth error
    if echo "$response" | grep -q "Unauthorized"; then
        echo ""
        print_color $YELLOW "  Niet ingelogd - authenticatie vereist"
        echo ""
        echo "  Gebruik eerst:"
        print_color $CYAN "    ./mcp-client.sh login"
        echo ""
        echo "  Dit opent je browser voor Authentik SSO login."
        echo ""
        return 1
    fi

    # Parse SSE response
    if echo "$response" | grep -q "^data:"; then
        echo "$response" | grep "^data:" | sed 's/^data: //'
    else
        echo "$response"
    fi
}

call_tool() {
    local tool_name=$1
    local args=${2:-\{\}}

    # Check if logged in
    if [ -z "$TOKEN" ]; then
        echo "" >&2
        print_color $YELLOW "  Niet ingelogd - authenticatie vereist" >&2
        echo "" >&2
        echo "  Gebruik eerst:" >&2
        print_color $CYAN "    ./mcp-client.sh login" >&2
        echo "" >&2
        return 1
    fi

    # Initialize session first
    mcp_request "initialize" '{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"mcp-client-bash","version":"1.0"}}' > /dev/null 2>&1

    local result=$(mcp_request "tools/call" "{\"name\":\"$tool_name\",\"arguments\":$args}")

    if [ $? -ne 0 ]; then
        return 1
    fi

    # Extract tool result
    echo "$result" | jq -r '.result.content[0].text // empty' 2>/dev/null
}

# ============================================
# UPDATE FUNCTIONS
# ============================================

version_gt() {
    # Returns 0 if $1 > $2 (semver comparison)
    [ "$(printf '%s\n' "$1" "$2" | sort -V | tail -n1)" = "$1" ] && [ "$1" != "$2" ]
}

check_for_update() {
    local version_response=$(curl -s --connect-timeout 2 "$MCP_URL/version?format=json" 2>/dev/null)
    # Validate JSON before parsing
    if ! echo "$version_response" | jq -e . >/dev/null 2>&1; then
        return 0  # Skip update check if response is invalid
    fi
    local remote_version=$(echo "$version_response" | jq -r '.client_version // empty')
    # Only show update message if remote is actually newer
    if [ -n "$remote_version" ] && version_gt "$remote_version" "$VERSION"; then
        echo ""
        print_color $YELLOW "  Nieuwe versie beschikbaar: $remote_version (huidige: $VERSION)"
        echo "  Update met: ./mcp-client.sh update"
        echo ""
    fi
}

do_update() {
    print_color $CYAN "\n[Update]"
    echo "  Huidige versie: $VERSION"
    echo "  Downloaden van: $MCP_URL/client.sh"

    local script_path="${BASH_SOURCE[0]}"
    local new_script=$(curl -sL "$MCP_URL/client.sh")

    if [ -z "$new_script" ]; then
        print_color $RED "  Download mislukt"
        return 1
    fi

    local new_version=$(echo "$new_script" | grep '^VERSION=' | cut -d'"' -f2)
    echo "  Nieuwe versie:  $new_version"

    if [ "$new_version" = "$VERSION" ]; then
        print_color $GREEN "\n  Je hebt al de nieuwste versie!"
        return 0
    fi

    echo "$new_script" > "$script_path"
    chmod +x "$script_path"

    print_color $GREEN "\n  Update succesvol!"
    echo "  Herstart het script om de nieuwe versie te gebruiken."
    echo ""
}

# ============================================
# OAUTH LOGIN - Smart Detection
# ============================================

# Get saved login method preference
get_login_method() {
    if [ -f "$CONFIG_FILE" ]; then
        # Validate JSON before parsing
        if ! jq -e . "$CONFIG_FILE" >/dev/null 2>&1; then
            rm -f "$CONFIG_FILE"
            echo "auto"
            return
        fi
        jq -r '.login_method // "auto"' "$CONFIG_FILE" 2>/dev/null || echo "auto"
    else
        echo "auto"
    fi
}

# Save login method preference
save_login_method() {
    local method=$1
    if [ -f "$CONFIG_FILE" ] && jq -e . "$CONFIG_FILE" >/dev/null 2>&1; then
        local tmp=$(mktemp)
        jq --arg m "$method" '.login_method = $m' "$CONFIG_FILE" > "$tmp" && mv "$tmp" "$CONFIG_FILE"
    else
        echo "{\"login_method\": \"$method\"}" > "$CONFIG_FILE"
    fi
}

# Main login function - smart routing
do_login() {
    local force_method=""

    # Parse arguments
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --manual|-m) force_method="manual" ;;
            --auto|-a) force_method="auto" ;;
            --reset|-r)
                rm -f "$CONFIG_FILE"
                print_color $GREEN "  Login voorkeuren gereset"
                force_method="detect"
                ;;
            *) ;;
        esac
        shift
    done

    print_color $CYAN "\n[OAuth Login] (v$VERSION)"

    # Check if permanent API key already exists
    if [ -f "$APIKEY_FILE" ]; then
        print_color $GREEN "  Je hebt al een permanente API key!"
        echo "  Bestand: $APIKEY_FILE"
        echo ""
        return 0
    fi

    # Check if we already have a valid temp token
    if load_token 2>/dev/null; then
        print_color $GREEN "  Je bent al ingelogd!"
        echo ""
        return 0
    fi

    # Get OAuth config from server
    local config=$(curl -s --connect-timeout 10 "$MCP_URL/oauth/config?format=json" 2>&1)

    # Check if response is valid JSON
    if ! echo "$config" | jq -e . >/dev/null 2>&1; then
        print_color $RED "  Fout bij ophalen OAuth config van server"
        echo "  URL: $MCP_URL/oauth/config?format=json"
        echo "  Response: ${config:0:200}"
        echo ""
        echo "  Mogelijke oorzaken:"
        echo "  - Server niet bereikbaar (check netwerk/DNS)"
        echo "  - SSL/TLS probleem (probeer: curl -v \$URL)"
        return 1
    fi

    local enabled=$(echo "$config" | jq -r '.enabled // false')

    if [ "$enabled" != "true" ]; then
        print_color $YELLOW "  OAuth is niet ingeschakeld op de MCP server"
        return 1
    fi

    # Determine which method to use
    local method=""
    if [ -n "$force_method" ]; then
        method="$force_method"
    else
        method=$(get_login_method)
    fi

    if [ "$method" = "manual" ]; then
        echo "  Login methode: manual (WSL2/remote - gebruik --reset voor auto)"
    else
        echo "  Login methode: $method"
    fi

    case "$method" in
        manual)
            do_login_manual_impl
            return $?
            ;;
        *)
            # Try automatic first - it will auto-fallback to manual if needed
            do_login_auto_impl
            return $?
            ;;
    esac
}

# Automatic login with local callback server
do_login_auto_impl() {
    local config=$(curl -s --connect-timeout 10 "$MCP_URL/oauth/config?format=json" 2>&1)
    if ! echo "$config" | jq -e . >/dev/null 2>&1; then
        print_color $RED "  Fout bij ophalen OAuth config"
        return 1
    fi
    local authorize_url=$(echo "$config" | jq -r '.authorize_url')
    local token_url=$(echo "$config" | jq -r '.token_url')
    local client_id=$(echo "$config" | jq -r '.client_id')
    local scopes=$(echo "$config" | jq -r '.scopes')
    local state=$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid)

    # Find available port
    local port=0
    for p in $(seq 8400 8500); do
        if ! ss -tuln 2>/dev/null | grep -q ":$p " && ! netstat -tuln 2>/dev/null | grep -q ":$p "; then
            port=$p
            break
        fi
    done

    if [ "$port" -eq 0 ]; then
        print_color $RED "  Kon geen vrije poort vinden"
        echo "  Schakel over naar handmatige modus..."
        save_login_method "manual"
        do_login_manual_impl
        return $?
    fi

    local redirect_uri="http://localhost:$port/"
    local encoded_redirect=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$redirect_uri', safe=''))" 2>/dev/null || echo "$redirect_uri")
    local encoded_scopes=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$scopes', safe=''))" 2>/dev/null || echo "$scopes")

    local auth_url="${authorize_url}?client_id=${client_id}&response_type=code&redirect_uri=${encoded_redirect}&scope=${encoded_scopes}&state=${state}"

    echo ""
    print_color $YELLOW "  Automatische OAuth flow..."
    echo "  Callback listener op poort $port"

    # Create temp files
    local server_script=$(mktemp)
    local result_file=$(mktemp)

    # Python HTTP server
    cat > "$server_script" << PYEOF
import http.server
import socketserver
import urllib.parse

PORT = $port
EXPECTED_STATE = "$state"
RESULT_FILE = "$result_file"

class CallbackHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def do_GET(self):
        query = urllib.parse.urlparse(self.path).query
        params = urllib.parse.parse_qs(query)

        code = params.get('code', [None])[0]
        state = params.get('state', [None])[0]
        error = params.get('error', [None])[0]

        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.end_headers()

        with open(RESULT_FILE, 'w') as f:
            if error:
                self.wfile.write(f'<html><body><h1>Login Error</h1><p>{error}</p></body></html>'.encode())
                f.write(f"ERROR:{error}")
            elif code and state == EXPECTED_STATE:
                self.wfile.write('<html><body><h1>Login Succesvol!</h1><p>Je kunt dit venster sluiten.</p></body></html>'.encode())
                f.write(f"CODE:{code}")
            else:
                self.wfile.write('<html><body><h1>Invalid Request</h1></body></html>'.encode())
                f.write("ERROR:invalid_request")

with socketserver.TCPServer(("", PORT), CallbackHandler) as httpd:
    httpd.handle_request()
PYEOF

    # Start server
    python3 "$server_script" 2>/dev/null &
    local server_pid=$!
    sleep 0.5

    if ! kill -0 $server_pid 2>/dev/null; then
        print_color $RED "  Kon callback server niet starten"
        rm -f "$server_script" "$result_file"
        echo "  Schakel over naar handmatige modus..."
        save_login_method "manual"
        do_login_manual_impl
        return $?
    fi

    # Open browser (non-blocking)
    echo "  Browser openen..."
    local browser_opened=false
    if command -v wslview &> /dev/null; then
        wslview "$auth_url" 2>/dev/null &
        browser_opened=true
    elif [ -n "$DISPLAY" ] && command -v xdg-open &> /dev/null; then
        timeout 2 xdg-open "$auth_url" >/dev/null 2>&1 &
        browser_opened=true
    elif command -v open &> /dev/null; then
        open "$auth_url" 2>/dev/null &
        browser_opened=true
    fi

    if [ "$browser_opened" = false ]; then
        echo ""
        echo "  Open deze URL in je browser:"
        print_color $CYAN "  $auth_url"
    fi

    echo "  Wachten op callback... (10 sec, daarna fallback)"

    # Quick wait - if browser can reach us, it happens fast
    local quick_timeout=10
    local elapsed=0
    while [ $elapsed -lt $quick_timeout ]; do
        if [ -s "$result_file" ]; then
            break
        fi
        if ! kill -0 $server_pid 2>/dev/null; then
            break
        fi
        sleep 1
        ((elapsed++))
        # Show countdown
        printf "\r  Wachten... %d sec " $((quick_timeout - elapsed))
    done
    printf "\r                      \r"

    # Check if we got a result
    local result=""
    [ -f "$result_file" ] && result=$(cat "$result_file")

    if [[ "$result" == CODE:* ]]; then
        # Success! Process the code
        kill $server_pid 2>/dev/null
        wait $server_pid 2>/dev/null
        rm -f "$server_script" "$result_file"

        local code="${result#CODE:}"
        echo "  Callback ontvangen, token ophalen..."

        local token_response=$(curl -s -X POST "$token_url" \
            -H "Content-Type: application/x-www-form-urlencoded" \
            -d "grant_type=authorization_code" \
            -d "client_id=$client_id" \
            -d "code=$code" \
            -d "redirect_uri=$redirect_uri")

        local access_token=$(echo "$token_response" | jq -r '.access_token // empty')
        local expires_in=$(echo "$token_response" | jq -r '.expires_in // 3600')

        if [ -z "$access_token" ]; then
            local error=$(echo "$token_response" | jq -r '.error // "unknown"')
            print_color $RED "\n  Token exchange mislukt: $error"
            return 1
        fi

        save_token "$access_token" "$expires_in"
        TOKEN="$access_token"

        print_color $GREEN "\n  Login succesvol!"
        echo "  Token opgeslagen in: $TOKEN_FILE"
        echo ""

        # Ask if user wants to generate permanent API key (only if none exists)
        if [ ! -f "$APIKEY_FILE" ]; then
            read -p "  Wil je een permanente API key genereren voor Claude Desktop? (j/n): " generate_key
            if [[ "$generate_key" =~ ^[jJyY]$ ]]; then
                do_apikey
            else
                echo ""
                print_color $YELLOW "  Tip: Je kunt later alsnog een API key genereren met:"
                echo "    ./mcp-client.sh api-key"
                echo ""
            fi
        fi
        return 0
    elif [[ "$result" == ERROR:* ]]; then
        kill $server_pid 2>/dev/null
        wait $server_pid 2>/dev/null
        rm -f "$server_script" "$result_file"

        local error_msg="${result#ERROR:}"
        print_color $RED "\n  Login mislukt: $error_msg"
        return 1
    else
        # No callback received - automatic fallback to manual
        kill $server_pid 2>/dev/null
        wait $server_pid 2>/dev/null
        rm -f "$server_script" "$result_file"

        print_color $YELLOW "\n  Geen callback ontvangen - WSL2 netwerk issue gedetecteerd"
        echo "  Automatisch overschakelen naar handmatige modus..."
        echo ""
        save_login_method "manual"
        do_login_manual_impl
        return $?
    fi
}

# Manual login with token copy
do_login_manual_impl() {
    print_color $YELLOW "\n  Handmatige login modus"

    local config=$(curl -s --connect-timeout 10 "$MCP_URL/oauth/config?format=json" 2>&1)
    if ! echo "$config" | jq -e . >/dev/null 2>&1; then
        print_color $RED "  Fout bij ophalen OAuth config"
        echo "  Response: ${config:0:200}"
        return 1
    fi
    local authorize_url=$(echo "$config" | jq -r '.authorize_url')
    local client_id=$(echo "$config" | jq -r '.client_id')
    local redirect_uri=$(echo "$config" | jq -r '.redirect_uri')
    local scopes=$(echo "$config" | jq -r '.scopes')
    local state=$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid)

    local encoded_redirect=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$redirect_uri', safe=''))" 2>/dev/null || echo "$redirect_uri")
    local encoded_scopes=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$scopes', safe=''))" 2>/dev/null || echo "$scopes")

    local auth_url="${authorize_url}?client_id=${client_id}&response_type=code&redirect_uri=${encoded_redirect}&scope=${encoded_scopes}&state=${state}"

    echo ""
    echo "  1. Open deze URL in je browser:"
    echo ""
    print_color $CYAN "  $auth_url"
    echo ""

    # Try to open browser (non-blocking, skip on headless)
    if command -v wslview &> /dev/null; then
        wslview "$auth_url" 2>/dev/null &
        echo "  (Browser geopend)"
    elif [ -n "$DISPLAY" ] && command -v xdg-open &> /dev/null; then
        timeout 2 xdg-open "$auth_url" >/dev/null 2>&1 &
        echo "  (Browser geopend)"
    fi

    echo ""
    echo "  2. Log in met je Authentik account"
    echo "  3. Kopieer de token van de success pagina"
    echo ""

    read -p "  Plak je token hier: " token

    if [ -z "$token" ]; then
        print_color $RED "  Geen token ingevoerd, login afgebroken"
        return 1
    fi

    if [[ ! "$token" =~ ^eyJ ]]; then
        print_color $YELLOW "  Dit lijkt geen geldige token (moet beginnen met 'eyJ')"
        read -p "  Toch opslaan? (j/n): " confirm
        if [ "$confirm" != "j" ]; then
            print_color $RED "  Login afgebroken"
            return 1
        fi
    fi

    save_token "$token" 3600
    TOKEN="$token"

    print_color $GREEN "\n  Login succesvol!"
    echo "  Token opgeslagen in: $TOKEN_FILE"
    echo ""

    # Ask if user wants to generate permanent API key (only if none exists)
    if [ ! -f "$APIKEY_FILE" ]; then
        read -p "  Wil je een permanente API key genereren voor Claude Desktop? (j/n): " generate_key
        if [[ "$generate_key" =~ ^[jJyY]$ ]]; then
            do_apikey
        else
            echo ""
            print_color $YELLOW "  Tip: Je kunt later alsnog een API key genereren met:"
            echo "    ./mcp-client.sh api-key"
            echo ""
        fi
    fi
}

# Manual login wrapper (saves login method preference)
do_login_manual() {
    save_login_method "manual"
    do_login_manual_impl
}

do_logout() {
    print_color $CYAN "\n[Logout]"

    if [ -f "$TOKEN_FILE" ]; then
        remove_token
        print_color $GREEN "  Sessie beeindigd (tijdelijke token verwijderd)"
    else
        echo "  Geen actieve sessie"
    fi
    echo ""
}

# ============================================
# API KEY GENERATION
# ============================================

do_apikey() {
    print_color $CYAN "\n[API Key Genereren]"

    # Check if logged in
    if ! load_token; then
        print_color $YELLOW "  Je moet eerst inloggen om een API key te genereren."
        echo ""
        echo "  Stappen:"
        echo "    1. ./mcp-client.sh login"
        echo "    2. ./mcp-client.sh api-key"
        echo ""
        return 1
    fi

    echo "  OAuth token gevonden, API key aanvragen..."

    # Call the /api-key endpoint
    local response=$(curl -s -X POST "$MCP_URL/api-key" \
        -H "Authorization: Bearer $TOKEN" \
        -H "Content-Type: application/json")

    local api_key=$(echo "$response" | jq -r '.api_key // empty')
    local error=$(echo "$response" | jq -r '.error // empty')

    if [ -n "$error" ]; then
        print_color $RED "  Fout: $error"
        return 1
    fi

    if [ -z "$api_key" ]; then
        print_color $RED "  Geen API key ontvangen van server"
        echo "  Response: $response"
        return 1
    fi

    # Save API key
    echo "$api_key" > "$APIKEY_FILE"
    chmod 600 "$APIKEY_FILE"

    # Remove temp token - no longer needed
    if [ -f "$TOKEN_FILE" ]; then
        remove_token
    fi

    local expires=$(echo "$response" | jq -r '.expires_at // "onbekend"')
    local user=$(echo "$response" | jq -r '.user.email // "onbekend"')

    print_color $GREEN "\n  API Key succesvol gegenereerd!"
    echo ""
    echo "  Gebruiker:  $user"
    echo "  Geldig tot: $expires"
    echo "  Opgeslagen: $APIKEY_FILE"
    echo ""
    print_color $YELLOW "  Claude Desktop configuratie:"
    echo ""
    echo "  {"
    echo "    \"mcpServers\": {"
    echo "      \"mcp-server\": {"
    echo "        \"command\": \"npx\","
    echo "        \"args\": [\"-y\", \"@anthropic-ai/mcp-remote\", \"$MCP_URL/mcp\"],"
    echo "        \"env\": {"
    echo "          \"MCP_API_KEY\": \"$(cat $APIKEY_FILE)\""
    echo "        }"
    echo "      }"
    echo "    }"
    echo "  }"
    echo ""
}

show_apikey() {
    print_color $CYAN "\n[API Key Status]"

    if [ -f "$APIKEY_FILE" ]; then
        local key=$(cat "$APIKEY_FILE")
        local key_preview="${key:0:20}...${key: -10}"

        print_color $GREEN "  Status:    API key geconfigureerd"
        echo "  Bestand:   $APIKEY_FILE"
        echo "  Key:       $key_preview"
        echo ""
        echo "  Gebruik:   MCP_API_KEY=\"\$(cat $APIKEY_FILE)\""
        echo ""

        # Validate key
        local result=$(curl -s "$MCP_URL/health" -H "Authorization: Bearer $key")
        if echo "$result" | jq -e '.status == "healthy"' > /dev/null 2>&1; then
            print_color $GREEN "  Validatie: Key is geldig ✓"
        else
            print_color $YELLOW "  Validatie: Kon key niet valideren"
        fi
    else
        print_color $YELLOW "  Geen API key gevonden"
        echo ""
        echo "  Genereer met: ./mcp-client.sh api-key"
    fi
    echo ""
}

do_whoami() {
    print_color $CYAN "\n[Login Status]"
    if load_token; then
        print_color $GREEN "  Status: Ingelogd"
        echo "  Token file: $TOKEN_FILE"
        local expires_at=$(jq -r '.expires_at' "$TOKEN_FILE")
        echo "  Geldig tot: $expires_at"
    else
        print_color $YELLOW "  Niet ingelogd"
        echo "  Gebruik: ./mcp-client.sh login"
    fi
    echo ""
}

# ============================================
# COMMANDS
# ============================================

show_help() {
    print_color $CYAN "\n╔══════════════════════════════════════════════════════════════╗"
    print_color $CYAN "║              MCP Client - Bash                               ║"
    print_color $CYAN "╚══════════════════════════════════════════════════════════════╝"

    print_color $YELLOW "\nGEBRUIK:"
    echo "  ./mcp-client.sh <command> [opties]"

    print_color $YELLOW "\nCOMMANDO'S:"

    echo -e "\n  ${NC}Authenticatie:${NC}"
    echo "    login             Login (detecteert beste methode automatisch)"
    echo "    login --manual    Forceer handmatige login (token copy)"
    echo "    login --auto      Forceer automatische login (callback)"
    echo "    login --reset     Reset login voorkeur en detecteer opnieuw"
    echo "    logout            Verwijder opgeslagen token"
    echo "    whoami            Toon login status"
    echo "    api-key           Genereer permanente API key (na login)"
    echo "    api-key status    Toon huidige API key status"

    echo -e "\n  ${NC}Updates:${NC}"
    echo "    update      Download nieuwste versie"
    echo "    version     Toon huidige versie ($VERSION)"

    echo -e "\n  ${NC}Informatie:${NC}"
    echo "    help        Toon deze hulp"
    echo "    health      Check MCP server status"
    echo "    tools       Lijst beschikbare tools"

    echo -e "\n  ${NC}Packages:${NC}"
    echo "    packages              Lijst alle packages"
    echo "    package <naam>        Package details"
    echo "    search <query>        Zoek packages"

    echo -e "\n  ${NC}Services:${NC}"
    echo "    status <naam>         Service status"
    echo "    logs <naam> [lines]   Service logs"
    echo "    ecosystem             Overzicht services"

    echo -e "\n  ${NC}Redmine:${NC}"
    echo "    epics [status]        Lijst epics (open/closed/all)"
    echo "    issues [query]        Zoek issues"
    echo "    issue <id>            Issue details"

    print_color $YELLOW "\nVOORBEELDEN:"
    echo "  ./mcp-client.sh packages"
    echo "  ./mcp-client.sh status <service>"
    echo "  ./mcp-client.sh issue <id>"
    echo ""
}

show_health() {
    print_color $CYAN "\n[Health Check]"
    local health=$(curl -s "$MCP_URL/health")
    local status=$(echo "$health" | jq -r '.status // "unknown"')
    local version=$(echo "$health" | jq -r '.version // "?"')

    if [ "$status" = "healthy" ]; then
        print_color $GREEN "  Status:  $status"
    else
        print_color $RED "  Status:  $status"
    fi
    echo "  Version: $version"
    echo ""
}

show_tools() {
    print_color $CYAN "\n[Beschikbare Tools]"
    load_token

    local result=$(mcp_request "tools/list" "{}")
    if [ $? -ne 0 ]; then return 1; fi

    echo "$result" | jq -r '.result.tools[] | "  \(.name) - \(.description)"' 2>/dev/null
    echo ""
}

show_packages() {
    print_color $CYAN "\n[Packages]"
    load_token

    local data=$(call_tool "package_list")
    if [ -z "$data" ]; then return 1; fi

    echo ""
    print_color $GREEN "  Running:"
    echo "$data" | jq -r '.packages[] | select(.status=="running") | "    - \(.name): \(.description)"' 2>/dev/null

    print_color $YELLOW "\n  Stopped:"
    echo "$data" | jq -r '.packages[] | select(.status=="stopped") | "    - \(.name): \(.description)"' 2>/dev/null

    local available=$(echo "$data" | jq '.packages | map(select(.status=="available")) | length')
    echo -e "\n  Available: $available packages"
    echo ""
}

show_package() {
    local name=$1
    if [ -z "$name" ]; then
        print_color $YELLOW "  Gebruik: ./mcp-client.sh package <naam>"
        return 1
    fi

    print_color $CYAN "\n[Package: $name]"
    load_token

    local data=$(call_tool "package_info" "{\"name\":\"$name\"}")
    if [ -z "$data" ]; then return 1; fi

    local error=$(echo "$data" | jq -r '.error // empty')
    if [ -n "$error" ]; then
        print_color $RED "  $error"
        return 1
    fi

    echo "  Name:        $(echo "$data" | jq -r '.manifest.display_name // .name')"
    echo "  Category:    $(echo "$data" | jq -r '.manifest.category // "?"')"
    echo "  Description: $(echo "$data" | jq -r '.manifest.description // "?"')"
    echo "  Status:      $(echo "$data" | jq -r '.status')"
    echo ""
}

show_status() {
    local name=$1
    if [ -z "$name" ]; then
        print_color $YELLOW "  Gebruik: ./mcp-client.sh status <naam>"
        return 1
    fi

    print_color $CYAN "\n[Service: $name]"
    load_token

    local data=$(call_tool "service_status" "{\"name\":\"$name\"}")
    if [ -z "$data" ]; then return 1; fi

    local status=$(echo "$data" | jq -r '.status')
    echo "  Name:   $(echo "$data" | jq -r '.name')"
    if [ "$status" = "running" ]; then
        print_color $GREEN "  Status: $status"
    else
        print_color $YELLOW "  Status: $status"
    fi

    local uptime=$(echo "$data" | jq -r '.uptime // empty')
    [ -n "$uptime" ] && echo "  Uptime: $uptime"

    local port=$(echo "$data" | jq -r '.port // empty')
    [ -n "$port" ] && echo "  Port:   $port"
    echo ""
}

show_logs() {
    local name=$1
    local lines=${2:-50}

    if [ -z "$name" ]; then
        print_color $YELLOW "  Gebruik: ./mcp-client.sh logs <naam> [lines]"
        return 1
    fi

    print_color $CYAN "\n[Logs: $name (laatste $lines regels)]"
    load_token

    local data=$(call_tool "service_logs" "{\"name\":\"$name\",\"lines\":$lines}")
    if [ -z "$data" ]; then return 1; fi

    echo "$data" | jq -r '.logs[]? // empty' 2>/dev/null | while read line; do
        echo "  $line"
    done
    echo ""
}

show_ecosystem() {
    print_color $CYAN "\n[Ecosystem Health]"
    load_token

    local data=$(call_tool "ecosystem_health")
    if [ -z "$data" ]; then return 1; fi

    print_color $GREEN "  Running:   $(echo "$data" | jq -r '.summary.running')"
    print_color $YELLOW "  Stopped:   $(echo "$data" | jq -r '.summary.stopped')"
    echo "  Available: $(echo "$data" | jq -r '.summary.available')"
    echo "  ─────────────────"
    echo "  Total:     $(echo "$data" | jq -r '.summary.total_packages')"
    echo ""
}

show_epics() {
    local status=${1:-open}

    print_color $CYAN "\n[Redmine Epics - $status]"
    load_token

    local data=$(call_tool "redmine_epics" "{\"status\":\"$status\"}")
    if [ -z "$data" ]; then return 1; fi

    echo "  Total: $(echo "$data" | jq -r '.total') epics"
    echo ""

    echo "$data" | jq -r '.epics[] | "  #\(.id) [\(.status)] \(.subject)"' 2>/dev/null
    echo ""
}

show_issues() {
    local query=$1

    print_color $CYAN "\n[Redmine Issues]"
    load_token

    local args="{}"
    if [ -n "$query" ]; then
        args="{\"query\":\"$query\"}"
    fi

    local data=$(call_tool "redmine_issues" "$args")
    if [ -z "$data" ]; then return 1; fi

    echo "  Total: $(echo "$data" | jq -r '.total') issues"
    echo ""

    echo "$data" | jq -r '.issues[] | "  #\(.id) [\(.tracker)] \(.subject) - \(.status)"' 2>/dev/null
    echo ""
}

show_issue() {
    local id=$1

    if [ -z "$id" ]; then
        print_color $YELLOW "  Gebruik: ./mcp-client.sh issue <id>"
        return 1
    fi

    print_color $CYAN "\n[Issue #$id]"
    load_token

    local data=$(call_tool "redmine_issue" "{\"id\":$id}")
    if [ -z "$data" ]; then return 1; fi

    local error=$(echo "$data" | jq -r '.error // empty')
    if [ -n "$error" ]; then
        print_color $RED "  $error"
        return 1
    fi

    echo "  Subject:     $(echo "$data" | jq -r '.subject')"
    echo "  Tracker:     $(echo "$data" | jq -r '.tracker')"
    echo "  Status:      $(echo "$data" | jq -r '.status')"
    echo "  Priority:    $(echo "$data" | jq -r '.priority')"
    echo "  Author:      $(echo "$data" | jq -r '.author')"
    echo "  Assigned to: $(echo "$data" | jq -r '.assigned_to // "?"')"
    echo "  Created:     $(echo "$data" | jq -r '.created_on')"
    echo ""
}

# ============================================
# MAIN
# ============================================

check_dependencies

# Load token
load_token 2>/dev/null

# Check for updates (except for certain commands)
case "$1" in
    update|version|help|"") ;;
    *) check_for_update ;;
esac

# Route command
case "$1" in
    login)     do_login "$2" "$3" ;;
    logout)    do_logout ;;
    whoami)    do_whoami ;;
    api-key)
        case "$2" in
            status) show_apikey ;;
            *)      do_apikey ;;
        esac
        ;;
    update)    do_update ;;
    version)   echo "MCP Client v$VERSION" ;;
    help|"")   show_help ;;
    health)    show_health ;;
    tools)     show_tools ;;
    packages)  show_packages ;;
    package)   show_package "$2" ;;
    search)    call_tool "package_search" "{\"query\":\"$2\"}" | jq '.' ;;
    status)    show_status "$2" ;;
    logs)      show_logs "$2" "$3" ;;
    ecosystem) show_ecosystem ;;
    epics)     show_epics "$2" ;;
    issues)    show_issues "$2" ;;
    issue)     show_issue "$2" ;;
    *)
        print_color $RED "Onbekend commando: $1"
        echo "Gebruik: ./mcp-client.sh help"
        exit 1
        ;;
esac
