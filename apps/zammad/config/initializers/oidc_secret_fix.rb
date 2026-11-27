# Copyright (C) 2025 Viaalink
# Fix: OidcDatabase.setup does not include 'secret' in client_options.
# The omniauth_openid_connect gem (0.8.0) reads identifier and secret
# from options.client_options, but Zammad's OidcDatabase only puts
# 'identifier' in client_options, leaving 'secret' at the top level.
# This causes "invalid_client" errors on token exchange.

Rails.application.config.after_initialize do
  if defined?(OmniAuth::Strategies::OidcDatabase)
    OmniAuth::Strategies::OidcDatabase.class_eval do
      class << self
        alias_method :setup_without_secret_fix, :setup

        def setup
          opts = setup_without_secret_fix
          if opts.is_a?(Hash) && opts[:client_options].is_a?(Hash) && opts['secret'].present?
            opts[:client_options][:secret] = opts['secret']
          end
          opts
        end
      end
    end
    Rails.logger.info '=== OIDC secret fix loaded: secret now included in client_options ==='
  end
end
