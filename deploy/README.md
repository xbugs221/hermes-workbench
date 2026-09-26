# Deployment templates

These examples describe one isolated instance. Copy `compose.example.yaml` to
`compose.yaml` and `.env.example` to `.env`, then fill every required value.
Real identities, endpoints, secrets and host paths belong only in your local
configuration. They must never be committed. Each instance needs its own data,
workspace, credentials, allowed-user list and proxy secret.

## Runtime prerequisites

`WORKBENCH_IMAGE` is an image you supply; this project does not publish a runtime
image. It must provide Python 3.13, the locked `requirements-dev.txt` dependencies,
a compatible Hermes installation at `/opt/hermes` (including its Python environment
at `/opt/hermes/.venv`), and Codex CLI at `/usr/local/bin/codex`. The supervisor can
instead use a separately installed app-server binary under
`/opt/data/bin/codex-runtime/codex`. Test that runtime before exposing the instance.

Use `scripts/install-managed-release.py` to initialize the mounted data directory
with a verified release as described in [managed releases](../docs/managed-releases.md).
The example will not start until that bootstrap is installed. Sign in with Codex
using the instance's `CODEX_HOME` before starting the combined runtime. Existing
credentials are preserved. Importing a Hermes authentication pool is optional and
requires an explicit `HERMES_WORKBENCH_CODEX_AUTH_SOURCE` path; it is never inferred
from another instance or an undocumented shared mount.

Set UID/GID to the data owner/shared group on your host. Set data and workspace
to absolute host directories and `WORKBENCH_NETWORK` to the private network of
your authenticated Dashboard proxy. No host port is published. Check the rendered
configuration with `docker compose --env-file .env -f compose.yaml config` before
starting it. Rendered configuration contains secrets; do not publish its output.

## Authenticated routing

`Caddyfile.example` is a snippet, not a complete authentication configuration.
Import `workbench_routes` inside your existing `route` after authentication and
before the Hermes fallback. Authentication must reject unauthenticated requests
and replace client-supplied `Remote-User`. Set `WORKBENCH_UPSTREAM` to the sidecar
service address (for example `workbench:8787`) and use the same proxy secret as
the sidecar. The sidecar additionally checks that the user is in its configured
allowlist. Keep the sidecar unreachable from untrusted networks.

For multiple instances, use separate authenticated routing and service names;
never point unrelated users at the same data directory. Workbench does not rewrite
your proxy configuration or install an identity provider.

## Development and forks

Developers can build from source and run `scripts/publish-dev.py dashboard
--target /path/to/plugin/dashboard --backup-root /path/to/backups` against their
own development plugin. The script refuses managed-release symlinks. Publishing
browser files does not upgrade the backend or restart a service.

Forks may set `HERMES_WORKBENCH_RELEASE_REPOSITORY=owner/repository` and
`HERMES_WORKBENCH_PLUGIN_ROOT=/path/to/plugins/workbench`. The official repository
URL is a public project identifier, not an instance identity. Releases are
manually selected by users; CI never deploys to your host.
