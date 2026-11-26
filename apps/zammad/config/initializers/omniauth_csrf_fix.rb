# Custom initializer to fix SAML CSRF issues and HTTPS redirect issues
# Zammad has custom CSRF verification in ApplicationController::PreventsCsrf
# This patches that module to allow OmniAuth/SAML callbacks
#
# Also forces HTTPS for all redirects when behind a reverse proxy
# because Zammad's nginx overwrites X-Forwarded-Proto with $scheme (http)

Rails.logger.info "=== Loading OmniAuth CSRF fix ==="

# Middleware to force HTTPS scheme in request
# This makes request.base_url return https:// instead of http://
class ForceHttpsScheme
  def initialize(app)
    @app = app
  end

  def call(env)
    # Force HTTPS scheme for all requests
    env['rack.url_scheme'] = 'https'
    env['HTTPS'] = 'on'
    env['HTTP_X_FORWARDED_PROTO'] = 'https'
    env['HTTP_X_FORWARDED_SSL'] = 'on'
    @app.call(env)
  end
end

# Insert middleware at the beginning of the stack
Rails.application.config.middleware.insert_before 0, ForceHttpsScheme
Rails.logger.info "=== ForceHttpsScheme middleware inserted ==="

# Allow both GET and POST for OmniAuth request phase
OmniAuth.config.allowed_request_methods = [:get, :post]

# CRITICAL: Disable OmniAuth's built-in origin/CSRF validation
# Required for SAML IdP callbacks which come from external domain (Authentik)
# without a Rails CSRF token. The IdP POST is legitimate - it's the SAML response.
OmniAuth.config.request_validation_phase = nil

# Silence GET warning since we explicitly allow it
OmniAuth.config.silence_get_warning = true

Rails.logger.info "=== OmniAuth request_validation_phase disabled for IdP callbacks ==="

# Custom error handler for better debugging
OmniAuth.config.on_failure = Proc.new do |env|
  message = env['omniauth.error']
  error_type = env['omniauth.error.type']
  strategy = env['omniauth.error.strategy']
  Rails.logger.error "OmniAuth Error: #{error_type} - #{message} (Strategy: #{strategy&.name})"
  OmniAuth::FailureEndpoint.new(env).redirect_to_failure
end

# Patch Zammad's custom CSRF verification to allow OmniAuth routes
Rails.application.config.after_initialize do
  Rails.logger.info "=== Patching ApplicationController::PreventsCsrf ==="

  ApplicationController::PreventsCsrf.module_eval do
    # Store original method
    alias_method :original_verify_csrf_token, :verify_csrf_token

    # Override with OmniAuth check
    def verify_csrf_token
      # Skip CSRF for OmniAuth routes (SAML callbacks come from external IdP)
      if request.path.start_with?('/auth/')
        Rails.logger.info "=== CSRF skipped for OmniAuth route: #{request.path} ==="
        return true
      end

      # Call original for all other routes
      original_verify_csrf_token
    end
  end

  Rails.logger.info "=== ApplicationController::PreventsCsrf patched successfully ==="
end

Rails.logger.info "=== OmniAuth CSRF fix registered ==="

# Force HTTPS for OmniAuth redirects when behind reverse proxy
# NOTE: Zammad's nginx overwrites X-Forwarded-Proto with $scheme (http),
# so we MUST ignore it and always use https
OmniAuth.config.full_host = lambda do |env|
  host = env['HTTP_X_FORWARDED_HOST'] || env['HTTP_HOST'] || Setting.get('fqdn')
  "https://#{host}"  # Always HTTPS - nginx overwrites X-Forwarded-Proto
end

Rails.logger.info "=== OmniAuth full_host configured for HTTPS ==="

# Force HTTPS for all Rails URL helpers (redirect_to root_url, etc.)
# This ensures post-login redirects use https:// not http://
Rails.application.config.after_initialize do
  Rails.logger.info "=== Forcing HTTPS for all URL helpers ==="

  # Set default URL options to use HTTPS
  Rails.application.routes.default_url_options[:protocol] = 'https'

  # Also set for ActionMailer if used
  if defined?(ActionMailer::Base)
    ActionMailer::Base.default_url_options[:protocol] = 'https'
  end

  Rails.logger.info "=== HTTPS default URL options configured ==="
end
