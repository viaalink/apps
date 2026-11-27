# Postal behind a proxy that ends TLS and does not pass X-Forwarded-Proto on:
# Rails then sees an https Origin on an http request and refuses the form.
# With POSTAL_FORCE_PROTO=https every request counts as https. Unpublished
# (http on this machine) nothing is changed.
if ENV["POSTAL_FORCE_PROTO"] == "https"
  class ForceHttpsProto
    def initialize(app)
      @app = app
    end

    def call(env)
      env["HTTP_X_FORWARDED_PROTO"] = "https"
      @app.call(env)
    end
  end

  Rails.application.config.middleware.insert_before(0, ForceHttpsProto)
end
