# Hermes integration boundary

Workbench extends Hermes through its Dashboard SDK, plugin assets and an
independent sidecar. It does not require personal deployment paths, a specific
identity provider, or edits to the Hermes source tree.

- Hermes core comes from [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent).
- Browser source is maintained in `dashboard/src/`; installed assets are derived from a verified release.
- Sidecar APIs use the trusted-proxy authentication contract described in `deploy/README.md`.
- Optional integrations resolve the configured Hermes source and per-instance data paths.
- Other plugins and personal automation are managed separately.

Upgrade Hermes using its own supported procedure. Workbench does not reset the
host's repository, migrate unrelated settings, or restart the host gateway.
Back up instance data and test SDK/API compatibility before changing either component.
