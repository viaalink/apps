# Mautic as upstream ships it, with what its SAML sign-in needs to work.
ARG MAUTIC_VERSION
FROM mautic/mautic:${MAUTIC_VERSION}-apache

# https behind the published address (see the file).
COPY apache/mautic-https.conf /etc/apache2/conf-enabled/mautic-https.conf

# Three files of the SAML libraries Mautic uses (javer/lightsaml, javer/sp-bundle), each the
# file of this Mautic version with one fix:
# - DefaultController.php: $this->container->getParameter() no longer exists in Symfony 6;
#   it is $this->getParameter() (https://github.com/mautic/mautic/issues/14808).
# - FlushRequestStatesAction.php, RepeatedIdValidatorAction.php: a browser that posts the SAML
#   answer twice is let in once instead of refused ("repeated ID"); the stored request ids
#   expire after two minutes instead of being removed at the first post.
# They replace the files of exactly this version: check them against the new files when
# MAUTIC_VERSION changes.
COPY --chown=www-data:www-data patches/DefaultController.php /var/www/html/vendor/javer/sp-bundle/src/LightSaml/SpBundle/Controller/DefaultController.php
COPY --chown=www-data:www-data patches/FlushRequestStatesAction.php /var/www/html/vendor/javer/lightsaml/src/LightSaml/Action/Profile/FlushRequestStatesAction.php
COPY --chown=www-data:www-data patches/RepeatedIdValidatorAction.php /var/www/html/vendor/javer/lightsaml/src/LightSaml/Action/Assertion/Inbound/RepeatedIdValidatorAction.php
