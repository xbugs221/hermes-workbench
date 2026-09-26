# Contributing

Workbench has one canonical implementation in `dashboard/src/`. Build output
in `dashboard/dist/` is generated and must not be edited by hand. The Hermes
plugin loader and the installed `workbench.js` are deployment adapters; update
them only through the deployment scripts after a verified build.

Before opening a pull request:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm test:python
pnpm build
pnpm privacy:check
pnpm release:verify
```

Changes to the browser UI must include a focused test when behavior changes.
Do not commit credentials, generated deployment backups, or local runtime
state.

Keep host-specific deployment files outside Git. Use fictitious test identities,
parameterized paths and `.env.example` placeholders. `privacy:check` catches
common private paths, addresses and credential formats; reviewers must also
check contextual names, session IDs, screenshots and release documentation.

## Repository history migration

History was sanitized before v0.8.2. Use a fresh clone. Do not merge or force-push
from an older clone: that would restore retired data. Preserve any uncommitted
work privately, then review and apply only the required changes onto a new branch.
Keep recovery bundles outside this repository. CI requires full history and runs
`pnpm history:check` to reject accidental reintroduction of retired commits.
