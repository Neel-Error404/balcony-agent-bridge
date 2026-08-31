# v0.3 npm-first onboarding release manifest

Version `0.3.0` adds a guided, resumable npm-first setup and supported
foreground runtime surfaces. It does not deploy Azure resources, install or
change Windows services, alter operational nodes, or begin a hosted control
plane.

## Compatibility contract

- Envelope schema remains `1.0`.
- Message-authentication protocol and membership schema remain `1.0`.
- Membership contains exactly the configured remote peer set; the local node
  is rejected.
- SQLite remains schema v9. Existing delivery, recovery, resource grants, and
  approval behavior remain deny-by-default.
- Existing `demo`, `identity`, `setup`, `doctor`, `status`, `resource`, `grant`,
  `approval`, and MCP behavior remains available.
- Windows services remain a separate elevated, source-reviewed workflow.

## Required verification ladder

Run one level at a time and stop on any failure:

```powershell
npm ci
npm run typecheck
npm run test:foundation
npm run test:component
npm run test:integration
npm run test:workflow
npm run test:recovery
npm run test:security
npm run check:secrets
npm audit --audit-level=high
npm run verify:package
npm run verify:public-alpha
```

The release proof must additionally install the frozen tarball in a disposable
consumer, run the two-node onboarding exchange, register MCP in an isolated
Codex home, validate both foreground runtimes, and exercise both dispatcher
paths through the established integration/workflow suites.

The pull-request workflow installs the pinned supported Codex prerequisite and
runs `verify:public-alpha`. `verify:package` remains the deterministic package
allowlist/reference check; `verify:public-alpha` additionally requires the real
host preflight to pass before exercising the installed artifact.

## Exact artifact and publication evidence

Before publication, record one authoritative tarball's filename, file count,
packed and unpacked sizes, npm SHA-1, npm integrity, and SHA-256. Publish that
exact file with `npm publish <absolute-tarball-path>`; never publish the working
directory. Redownload `balcony-agent-bridge@0.3.0` through a fresh isolated npm
cache and prove byte identity before creating the annotated tag and GitHub
prerelease.

The final verified values and Git/GitHub references are filled in only after
those operations complete. Until then this section is a release contract, not
a publication claim.

## Deferred owner operations

- Creating or changing Azure namespaces, topics, subscriptions, filters,
  identities, certificates, or RBAC.
- Installing, upgrading, or starting Windows services.
- Touching the operational SYS-A/SYS-B bridge or either clean pilot VM.
- Any hosted discovery/control plane, writable remote execution, or broader
  Phase 3 product work.
