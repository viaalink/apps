# Viaalink Apps

Self-hosted apps you install and run with the [Viaalink CLI](https://github.com/viaalink/cli): one
command installs an app into your project, one starts it, and one sets it up, down to the first
administrator and, when Authentik runs next to it, single sign-on.

**Alpha.** `via app` is in the nightly build of the CLI, not in a release yet.

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
| `adminer` | [Adminer](https://www.adminer.org) | Database client in the browser for PostgreSQL, MySQL, SQLite and more. No login of its own: you sign in with a database's own user and password. | Apache-2.0 |  |
| `affine` | [AFFiNE](https://affine.pro) | Workspace for documents, whiteboards and databases: write, draw and plan together in one place. | MIT | yes |
| `alloy` | [Alloy](https://grafana.com/oss/alloy-opentelemetry-collector/) | Log collector: reads the logs of every container on this machine and sends them to Loki. No login of its own; reachable from this machine only. | Apache-2.0 |  |
| `authentik` | [Authentik](https://goauthentik.io) | Single sign-on for your apps: one login, with OIDC, SAML and LDAP. | MIT | provides it |
| `dagu` | [Dagu](https://dagu.sh) | Workflow engine with a web UI: scheduled jobs and pipelines written as YAML files. One admin account, made at the first start. | GPL-3.0-or-later |  |
| `erpnext` | [ERPNext](https://erpnext.com) | Business software in one: accounting, sales, purchasing, stock, projects and HR. The administrator finishes ERPNext's own setup (company, country, currency) at the first sign-in. | GPL-3.0-only | yes |
| `espocrm` | [EspoCRM](https://www.espocrm.com) | Customer relationship management: accounts, contacts, leads, opportunities, e-mail and reports. Connects its sign-in to Authentik when that runs in the project. | AGPL-3.0 | yes |
| `excalidraw` | [Excalidraw](https://excalidraw.com) | Whiteboard for hand-drawn style diagrams. No login of its own; drawings stay in your browser, nothing is stored on the server. | MIT |  |
| `firecrawl` | [Firecrawl](https://www.firecrawl.dev) | Web scraping and crawling API that turns pages into clean Markdown for agents and language models. No login of its own: who reaches its port can use the API. | AGPL-3.0-only |  |
| `gitea` | [Gitea](https://about.gitea.com) | Git hosting with pull requests, issues and a container registry. | MIT |  |
| `grafana` | [Grafana](https://grafana.com/oss/grafana/) | Dashboards and alerts for your metrics and logs. Finds the Prometheus and Loki apps of the same project by itself. | AGPL-3.0-only | yes |
| `homepage` | [Homepage](https://gethomepage.dev) | Start page for your services, with bookmarks and status widgets, configured in YAML files. No login of its own. | GPL-3.0-only |  |
| `it-tools` | [IT-Tools](https://it-tools.tech) | A collection of handy tools for developers: converters, generators, encoders. No login of its own; it runs in the browser and stores nothing on the server. | GPL-3.0-only |  |
| `langfuse` | [Langfuse](https://langfuse.com) | Observability for LLM applications: traces, evaluations, prompt management and cost tracking. Sign-in through Authentik needs Authentik on an https address. | MIT | yes |
| `linkding` | [linkding](https://linkding.link) | Bookmark manager with tags, search, archiving and browser extensions. One admin account, made at the first start. | MIT |  |
| `loki` | [Loki](https://grafana.com/oss/loki/) | Log store: keeps the logs of your containers and apps and answers queries from Grafana. No login of its own; reachable from this machine only. | AGPL-3.0-only |  |
| `mailpit` | [Mailpit](https://mailpit.axllent.org) | Catches the mail your apps send while you develop and shows it in a web inbox. The inbox has a login. | MIT |  |
| `mattermost` | [Mattermost](https://mattermost.com) | Team chat with channels, threads and calls. | MIT | yes |
| `mautic` | [Mautic](https://mautic.org) | Marketing automation: contacts, segments, email campaigns, forms and landing pages. | GPL-3.0-only | yes |
| `mcp-server` | MCP Server | Gives AI agents tools for the apps in this project (Redmine, n8n, Zammad) over the Model Context Protocol. Connects its sign-in to Authentik when that runs in the project. | Apache-2.0 | yes |
| `n8n` | [n8n](https://n8n.io) | Workflow automation: connect apps and services with visual workflows. | LicenseRef-Sustainable-Use | yes |
| `openproject` | [OpenProject](https://www.openproject.org) | Project management: work packages, Gantt charts, boards, time tracking and wiki. It has its own login; sign-in through an identity provider needs OpenProject's Enterprise edition. | GPL-3.0-only |  |
| `openwebui` | [Open WebUI](https://openwebui.com) | Chat with language models from your browser: your own models or any OpenAI-compatible API. | LicenseRef-Open-WebUI | yes |
| `postal` | [Postal](https://postalserver.io) | Mail server for your apps and websites: sends and receives mail, with message tracking, webhooks and an HTTP API. Sign-in through Authentik needs Authentik on an https address. | MIT | yes |
| `prometheus` | [Prometheus](https://prometheus.io) | Metrics and alerting: collects numbers from this machine, its containers and your apps. No login of its own; reachable from this machine only. | Apache-2.0 |  |
| `qdrant` | [Qdrant](https://qdrant.tech) | Vector database for semantic search and AI memory, with a web dashboard. Every request needs the API key. | Apache-2.0 |  |
| `redmine` | [Redmine](https://www.redmine.org) | Project management: issues, time tracking, wiki and Gantt charts. | GPL-2.0-only | yes |
| `s3` | [S3 storage](https://min.io) | S3-compatible object storage (MinIO), with a bucket and key ready for `via vault`. Access is by keys; a sign-in to Authentik can be traded for temporary keys. | AGPL-3.0-only | yes |
| `stirling-pdf` | [Stirling-PDF](https://www.stirlingpdf.com) | PDF toolbox in the browser: merge, split, convert, sign, compress and OCR. Its login is on, with one admin account made at the first start. | MIT AND LicenseRef-Stirling-PDF-Proprietary |  |
| `superset` | [Apache Superset](https://superset.apache.org) | Dashboards and data exploration on top of your databases. | Apache-2.0 | yes |
| `umami` | [Umami](https://umami.is) | Privacy-friendly web analytics without cookies: page views, events and visitors for your sites and apps. | MIT |  |
| `vaultwarden` | [Vaultwarden](https://github.com/dani-garcia/vaultwarden) | Password manager for teams, compatible with the Bitwarden apps. Connects its sign-in to Authentik when that runs in the project. | AGPL-3.0-only | yes |
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
| `via.yaml` | How the app is served and published: its services, with the fields of a project's `via.yaml` |
| `scripts/` | The app's own setup steps |

Names inside a package start with the app's id: a service is `<id>` or `<id>-<role>`
(`wikijs`, `wikijs-postgres`), a volume `<id>-<what>`, a setting in `tpl.env` `<ID>_<NAME>`.
Containers are named `${CONTAINER_PREFIX}<service>`; set `CONTAINER_PREFIX` in the project's `.env`
when two projects on one machine run the same app.

## How these apps are tested

This repository is generated from the app packages; nothing here is edited by hand. Before a
change is published, the registry is built from it into a folder and every app is run from that
folder with the nightly build of the CLI: `via app install`, `start`, `setup` twice (the second
run must change nothing), sign-in through Authentik for the apps that have it, and a check that
the app does not let a stranger in.

You can try a registry of your own the same way: `via app registry add mine /path/to/folder`.

There is one state of this registry, its `main` branch. Keep the CLI on the nightly build
(`via update --channel nightly`) so it reads everything an app here uses.

## Licence

The package files in this repository are licensed under Apache-2.0 (see `LICENSE`). The apps
themselves keep their upstream licences.
