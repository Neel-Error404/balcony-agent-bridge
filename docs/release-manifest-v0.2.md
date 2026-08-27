# v0.2 Phase 2 Release Manifest

This manifest defines the release gate for `balcony-agent-bridge` version
`0.2.0`. The release adds the Phase 2A per-peer resource boundary and the
Phase 2B local approval workflow without changing the signed v0.1 wire format.
Publication does not authorize deployment or any live bridge, Azure, RBAC,
service, database, broker, or signing change.

## Security And Migration Contract

- Schema v9 migration is additive and preserves existing messages, resources,
  and persistent grants.
- Migration creates no implicit resource, grant, temporary approval, or
  approval decision. An upgraded node remains deny-by-default until an
  operator registers resources and explicitly grants or approves access.
- `peer_readable: true` is only local path eligibility. Authentication and
  network membership alone never authorize a peer/resource pair.
- Unauthenticated, malformed, unknown-resource, disabled-resource, revoked,
  denied, expired, duplicate, and mismatched requests fail closed without
  exposing resource data.
- Approve-once is bound to the original durable request and is consumed
  atomically. Temporary approvals are bound to one peer/resource pair and use
  strict UTC expiry across restart.
- Authorization audit records are append-only and metadata-only. The durable
  store does not retain the verified signing key ID; authenticated ingress,
  origin, request identity, and payload fingerprint are the current local
  provenance boundary.
- Operator authorization remains the machine-local OS and exact
  `BALCONY_SYSTEM_ID` process-identity boundary. Approval administration is
  CLI-only; it is not exposed through MCP or a web control plane.

## npm Artifact Boundary

The package allowlist remains `dist/**`, `README.md`, `LICENSE`, `SECURITY.md`,
`package.json`, `config/codex-mcp.example.toml`, and
`config/dispatcher-projects.example.json`. Source, tests, infrastructure,
service scripts, internal verification records, databases, credentials, and
machine-local state are excluded.

## Required Local Checks

Run in order and stop on the first unexplained failure:

```powershell
npm ci
npm run test:foundation
npm run test:component
npm run test:integration
npm run test:workflow
npm run test:recovery
npm run test:security
npm run typecheck
npm run build
npm run smoke:mcp
npm run check:secrets
npm audit --omit=dev
npm run verify:package
npm run verify:public-alpha
git diff --check
```

Also parse the PowerShell release/service scripts and locally lint/build every
Bicep entry point when the required tools are available. Record unavailable
tools as unverified; do not silently skip them. The package verification must
exercise the resource, persistent-grant, and approval administration surfaces
in addition to the v0.1 help, identity, setup, doctor, demo, and status path.

## Review, Merge, And Artifact Freeze

1. Obtain a substantive exact-head review and required CI for the release
   preparation branch, then merge it.
2. Update a clean local `main` to the exact `origin/main` merge commit and run
   the complete ladder again on that final source.
3. Run `npm pack` once into an isolated directory outside the repository and
   freeze that one `balcony-agent-bridge-0.2.0.tgz` artifact.
4. Record its source commit, filename, file count, packed and unpacked size,
   SHA-1, SHA-256, and npm integrity in the single canonical v0.2 verification
   record.
5. If evidence-only repository changes follow the freeze, confirm by repacking
   that they do not change the package bytes before tagging or publishing.

## Publication And Public Verification

- Verify `balcony-agent-bridge@0.2.0` is absent before release.
- Publish only the frozen file with
  `npm publish <absolute-tarball-path> --access public`; never use
  `npm publish .`.
- Use npm credentials through existing environment/config indirection. Never
  print or persist a token. Stop for owner input if authentication or OTP is
  required.
- Download the registry tarball through a clean npm cache and prove it is
  byte-identical to the frozen artifact.
- Install `balcony-agent-bridge@0.2.0` in a disposable empty consumer and
  verify exact version, CLI help, local demo, setup/doctor/status, resource and
  grant administration, and approval administration without live services.
- Create annotated tag `v0.2.0` at the explicitly recorded tested source
  commit and verify its peeled remote target.
- Create a GitHub prerelease for `v0.2.0`, attach the exact frozen tarball and
  canonical verification record, and verify downloaded asset size and digest.

## Deferred Operations

The release does not deploy the package or change the operational SYS-A/SYS-B
bridge. Live signed cutover, Azure and RBAC changes, Windows services,
production databases or brokers, signing configuration, a third node,
alternative transports, onboarding automation, the Obsidian adapter, and
Phase 3 remain separately authorized work.
