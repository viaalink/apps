# Viaalink Apps

Self-hosted apps you install and run with the [Viaalink CLI](https://github.com/viaalink/cli): one
command installs an app into your project, one starts it, and one sets it up, down to the first
administrator and, when Authentik runs next to it, single sign-on.

**Alpha.** `via app` is in the nightly build of the CLI, not in a release yet. Commands and the
package format (`app.yaml`, spec 1) can still change.

## Use it

Get the nightly build of the CLI (Linux and macOS):

```bash
curl -fsSL https://raw.githubusercontent.com/viaalink/cli/main/install.sh | bash
via update --channel nightly
```

Add this registry once, then install and start an app in a project folder:

```bash
via app registry add viaalink https://github.com/viaalink/apps
via app list

mkdir my-server && cd my-server
via init                 # makes this folder a project (via.yaml, .env)
via app install wikijs
via app start wikijs
via app setup wikijs
```

The app listens on this machine at the port in `.env` (for Wiki.js: `WIKIJS_PORT`); the first
administrator's name and generated password are there too.

`via app install` shows what will run (images, ports, data) and asks before it copies anything.
The app's package lands in `packages/<id>/` of your project, pinned in `apps.lock.yaml` by commit
and checksum; its settings and generated passwords land in the project's `.env`.
`via app status` shows what runs; `via app stop <id>` stops an app and keeps its data;
`via app uninstall <id>` removes its containers and package, and keeps its data too.

To reach an app from outside, publish it through a [Viaalink Relay](https://github.com/viaalink/relay):
`via relay add <invite link>`, then `via net apply --caddy --tunnel`.

### Single sign-on

Install and start `authentik` in the same project first. Every app below marked with sign-in then
connects itself to it at its next start or setup: no client to create by hand.

## Apps

| Id | App | What it is | Upstream licence | Sign-in through Authentik |
|---|---|---|---|---|
| `authentik` | [Authentik](https://goauthentik.io) | Single sign-on for your apps: one login, with OIDC, SAML and LDAP. | MIT | provides it |
| `gitea` | [Gitea](https://about.gitea.com) | Git hosting with pull requests, issues and a container registry. | MIT |  |
| `mattermost` | [Mattermost](https://mattermost.com) | Team chat with channels, threads and calls. | MIT | yes |
| `n8n` | [n8n](https://n8n.io) | Workflow automation: connect apps and services with visual workflows. | LicenseRef-Sustainable-Use | yes |
| `openwebui` | [Open WebUI](https://openwebui.com) | Chat with language models from your browser: your own models or any OpenAI-compatible API. | LicenseRef-Open-WebUI | yes |
| `redmine` | [Redmine](https://www.redmine.org) | Project management: issues, time tracking, wiki and Gantt charts. | GPL-2.0-only | yes |
| `superset` | [Apache Superset](https://superset.apache.org) | Dashboards and data exploration on top of your databases. | Apache-2.0 | yes |
| `vaultwarden` | [Vaultwarden](https://github.com/dani-garcia/vaultwarden) | Password manager for teams, compatible with the Bitwarden apps. | AGPL-3.0-only |  |
| `wikijs` | [Wiki.js](https://js.wiki) | A wiki for your team's documentation, written in Markdown or a visual editor. | AGPL-3.0-only | yes |
| `zammad` | [Zammad](https://zammad.org) | Helpdesk: support tickets from email, chat and web forms in one place. | AGPL-3.0-only | yes |

Each app runs the upstream project's own software under the upstream licence named above.
Docker and Docker Compose are needed on the machine.

## What a package is

A folder `apps/<id>/` with:

| File | What it is |
|---|---|
| `app.yaml` | Name, licence, data folders, and the `prepare` and `setup` steps |
| `docker-compose.yaml` | The containers |
| `tpl.env` | The settings the app needs; ports and passwords are generated at install |
| `net.manifest.yaml` | How the app is served and published |
| `scripts/` | The app's own setup steps |

## Licence

The package files in this repository are licensed under Apache-2.0 (see `LICENSE`). The apps
themselves keep their upstream licences.
