# Contributing

Balcony Agent Bridge is preparing the public `0.3.0` beta under Apache-2.0. The npm package
contains the runtime CLI and MCP entrypoints; contributors build and test the
complete project from source.

## Local Setup

Requirements:

- Node.js 22 or later;
- npm 10 or later;
- PowerShell for the Windows service tooling;
- Azure access only when intentionally testing the production transport.

Install the pinned dependencies and verify the lowest test tier first:

```powershell
npm ci
npm run test:foundation
```

Run the remaining levels one at a time:

```powershell
npm run test:component
npm run test:integration
npm run test:workflow
npm run test:recovery
npm run test:security
npm run typecheck
npm run build
npm run smoke:mcp
```

For package changes, also run:

```powershell
npm run check:secrets
npm run verify:package
npm run smoke:package
npm run verify:public-alpha
```

`smoke:package` validates an installed tarball without requiring every machine
prerequisite to be present. `verify:public-alpha` is the release-environment
gate and requires preflight to pass with Node, npm, PowerShell 7, Git, Codex,
and the global npm bin correctly available.

Stop on the first unexplained failure, fix its root cause, and rerun that same
level before continuing.

## Change Boundaries

- Keep MCP protocol output on standard output and diagnostics on standard
  error.
- Validate external input with Zod.
- Preserve at-least-once delivery, idempotency, and durable claim behavior.
- Never add credentials, connection strings, tokens, private endpoints,
  machine-local paths, databases, logs, or certificate material.
- Use managed identity on Azure hosts. Certificate authentication for a
  physical host must remain explicit and machine-local.
- Do not introduce a hosted relay, UI, datastore, transport, or writable agent
  capability as an incidental change.

## Pull Requests

Keep changes small and explain their user-visible effect, security impact, and
verification. Include the exact commands run and any known flake or unverified
condition. Do not claim live deployment from local tests.

See `docs/ROADMAP.md`, `docs/architecture.md`, and
`docs/public-release-boundary.md` before changing a public contract.
