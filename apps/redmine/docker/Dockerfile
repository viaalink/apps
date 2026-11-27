# Redmine with OAuth/OIDC SSO support
# Custom image with redmine_oauth plugin pre-installed
#
# This Dockerfile adds:
# - Build dependencies for native gem extensions
# - redmine_oauth plugin from kontron/redmine_oauth
# - oauth2 and jwt gems pre-configured
#
# SSO Configuration after deployment:
# 1. Go to Administration > Plugins > Redmine OAuth plugin > Configure
# 2. Enter Authentik OAuth2 credentials
# 3. Enable "Allow OAuth authentication"

ARG REDMINE_VERSION=6.1
FROM redmine:${REDMINE_VERSION}

# Install build dependencies for native gem extensions
# These are required to compile oauth2 and jwt gems
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    git \
    libyaml-dev \
    && rm -rf /var/lib/apt/lists/*

# Clone the OAuth plugin
# Using kontron/redmine_oauth - actively maintained fork
RUN cd /usr/src/redmine/plugins && \
    git clone --depth 1 https://github.com/kontron/redmine_oauth.git

# Clone the Kanban plugin
# Using happy-se-life/kanban - open-source Kanban board for Redmine
# Re-added after container rebuild
RUN cd /usr/src/redmine/plugins && \
    git clone --depth 1 https://github.com/happy-se-life/kanban.git

# Clone the Dashboard plugin for drag & drop issue management
# Using jgraichen/redmine_dashboard - open source, Redmine 6.0 compatible
# Added for planning/roadmap functionality
RUN cd /usr/src/redmine/plugins && \
    git clone --depth 1 https://github.com/jgraichen/redmine_dashboard.git

# Add custom top menu plugin (Issues, Gantt, Calendar, Epics, Kanban, Dashboard)
COPY redmine_top_menu_issues_init.rb /usr/src/redmine/plugins/redmine_top_menu_issues/init.rb

# NOTE: Webhook plugins (suer/redmine_webhook, phanan/redmine_webhook) are
# incompatible with Redmine 6.1/Rails 7 due to deprecated 'unloadable' method.
# Alternative approaches:
# 1. Use Redmine Activity Feed (Atom) for polling (current approach)
# 2. Custom Rails middleware for webhooks (requires development)
# 3. External monitoring of Redmine API

# Pre-install the oauth2 and jwt gems (plugin dependencies)
# This ensures the entrypoint doesn't need to compile them
WORKDIR /usr/src/redmine
RUN echo 'gem "oauth2"' >> Gemfile.local && \
    echo 'gem "jwt"' >> Gemfile.local

# Ensure proper permissions for redmine user
# Note: db/schema.rb must be writable for plugin migrations
RUN mkdir -p /home/redmine/.bundle && \
    chown -R redmine:redmine /home/redmine/.bundle && \
    chown -R redmine:redmine /usr/src/redmine/plugins/redmine_oauth && \
    chown -R redmine:redmine /usr/src/redmine/plugins/redmine_top_menu_issues && \
    chown -R redmine:redmine /usr/src/redmine/plugins/kanban && \
    chown -R redmine:redmine /usr/src/redmine/plugins/redmine_dashboard && \
    chown -R redmine:redmine /usr/src/redmine/db

# Install gems as redmine user
USER redmine
RUN bundle install --without development test

USER root
