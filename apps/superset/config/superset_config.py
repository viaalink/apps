import os
from urllib.parse import urlparse
from flask_appbuilder.security.manager import AUTH_DB, AUTH_OAUTH

# Container prefix of the project (e.g., "dev-", "prod-")
CONTAINER_PREFIX = os.environ.get("CONTAINER_PREFIX", "")

# Basic Config
SECRET_KEY = os.environ.get("SUPERSET_SECRET_KEY")
if not SECRET_KEY:
    raise RuntimeError("SUPERSET_SECRET_KEY env var must be set")
SQLALCHEMY_DATABASE_URI = os.environ.get("SQLALCHEMY_DATABASE_URI")

# Redis - derive host from REDIS_URL (always set by compose) or CONTAINER_PREFIX
_redis_url = os.environ.get("REDIS_URL", "")
if _redis_url:
    _parsed = urlparse(_redis_url)
    REDIS_HOST = _parsed.hostname or f"{CONTAINER_PREFIX}superset-redis"
else:
    REDIS_HOST = os.environ.get("REDIS_HOST", f"{CONTAINER_PREFIX}superset-redis")
REDIS_PORT = 6379

# Cache
CACHE_CONFIG = {
    "CACHE_TYPE": "RedisCache",
    "CACHE_DEFAULT_TIMEOUT": 300,
    "CACHE_KEY_PREFIX": "superset_",
    "CACHE_REDIS_HOST": REDIS_HOST,
    "CACHE_REDIS_PORT": REDIS_PORT,
    "CACHE_REDIS_DB": 1,
}

# Celery
class CeleryConfig:
    broker_url = os.environ.get("CELERY_BROKER_URL", f"redis://{REDIS_HOST}:6379/1")
    result_backend = os.environ.get("CELERY_RESULT_BACKEND", f"redis://{REDIS_HOST}:6379/2")
    worker_max_tasks_per_child = 100
    worker_max_memory_per_child = 300000

CELERY_CONFIG = CeleryConfig

# Proxy fix for reverse proxy
ENABLE_PROXY_FIX = True
PROXY_FIX_CONFIG = {"x_for": 1, "x_proto": 1, "x_host": 1, "x_port": 1, "x_prefix": 1}

def FLASK_APP_MUTATOR(app):
    """Force X-Forwarded-Proto to https before ProxyFix reads it.

    Caddy sends X-Forwarded-Proto: http (tunnel terminates SSL),
    but the public-facing URL is always https. A request that did not come
    through a proxy (http://localhost:<port> on the machine itself) keeps
    its own scheme, so sign-in returns to the address the browser is on.
    """
    inner = app.wsgi_app

    class _ForceHTTPS:
        def __init__(self, wsgi_app):
            self.wsgi_app = wsgi_app

        def __call__(self, environ, start_response):
            if environ.get("HTTP_X_FORWARDED_HOST") or environ.get("HTTP_X_FORWARDED_FOR"):
                environ["HTTP_X_FORWARDED_PROTO"] = "https"
            return self.wsgi_app(environ, start_response)

    app.wsgi_app = _ForceHTTPS(inner)

# Feature flags
FEATURE_FLAGS = {
    "ENABLE_TEMPLATE_PROCESSING": True,
}

# Public URL (read from SUPERSET_URL, which `via net apply` writes to .env)
SUPERSET_URL = os.environ.get("SUPERSET_URL", "")
WEBDRIVER_BASEURL = os.environ.get("SUPERSET_WEBDRIVER_BASEURL", SUPERSET_URL)

# Authentik URLs (read from AUTHENTIK_URL, which `via net apply` writes to .env)
AUTHENTIK_CONTAINER = os.environ.get("AUTHENTIK_CONTAINER", f"{CONTAINER_PREFIX}authentik")
AUTHENTIK_PUBLIC_URL = os.environ.get("AUTHENTIK_URL", "")

# Sign-in through Authentik when a sign-in client is set; Superset's own login otherwise.
AUTH_TYPE = AUTH_OAUTH if os.environ.get("SUPERSET_OAUTH_CLIENT_ID") and AUTHENTIK_PUBLIC_URL else AUTH_DB
AUTH_USER_REGISTRATION = True
AUTH_USER_REGISTRATION_ROLE = "Gamma"

OAUTH_PROVIDERS = [
    {
        "name": "authentik",
        "icon": "fa-key",
        "token_key": "access_token",
        "remote_app": {
            "client_id": os.environ.get("SUPERSET_OAUTH_CLIENT_ID", ""),
            "client_secret": os.environ.get("SUPERSET_OAUTH_CLIENT_SECRET"),
            # Use internal URL for server_metadata_url (container to container)
            "server_metadata_url": f"http://{AUTHENTIK_CONTAINER}:9000/application/o/superset/.well-known/openid-configuration",
            # Override authorize_url to use public URL (browser needs to reach it)
            "authorize_url": f"{AUTHENTIK_PUBLIC_URL}/application/o/authorize/",
            "client_kwargs": {
                "scope": "openid email profile",
            },
        },
    }
]
