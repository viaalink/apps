# Fix SAML: ensure idp_cert is always available during callback
#
# Zammad's SamlDatabase strategy loads credentials from the database during
# initialize(), which runs once at middleware build time. However, OmniAuth's
# Strategy#initialize doesn't properly merge the config hash into @options
# in all cases, causing idp_cert to be missing during callback_phase.
#
# This fix re-reads credentials via SamlDatabase.setup at callback time,
# ensuring the IdP certificate is always available for SAML response validation.
# We use setup() rather than raw DB values because setup() properly processes
# the credentials (compact_blank, merge URLs, apply_security_settings).
#
# Without this fix: "No fingerprint or certificate on settings" error.
module SamlDatabaseCertFix
  def with_settings
    config = self.class.setup
    if config.respond_to?(:each)
      config.each do |key, value|
        options[key] = value unless value.nil?
      end
    end

    super
  end
end

OmniAuth::Strategies::SAML.prepend(SamlDatabaseCertFix)

Rails.logger.info "=== SAML cert fix loaded ==="
