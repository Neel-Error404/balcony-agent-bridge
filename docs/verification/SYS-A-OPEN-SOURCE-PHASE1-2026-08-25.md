# [SYS-A] Open-Source Phase 1 Verification - 2026-08-25

## Claim Boundary

This record verifies the local public-safety and npm-package implementation on
branch `codex/open-source-v0.1` starting from accepted commit
`9468ab9ba82a57e67cda451c19b8c1c3e5a2a4f3`.

It does not prove a public registry installation, a clean public Git history,
an Azure deployment, or live runtime state. Apache-2.0 was subsequently
approved and added as recorded below.

## Implemented

- Added an explicit npm allowlist for compiled runtime files, sanitized config
  examples, `README.md`, `SECURITY.md`, and package metadata.
- Added supported `balcony-agent-bridge` and
  `balcony-agent-bridge-mcp` executable mappings with portable Node shebangs.
- Kept the package `private`; it was initially `UNLICENSED` pending owner
  approval and now declares the approved Apache-2.0 license.
- Added a package manifest verifier that rejects source, tests, internal docs,
  infrastructure, service scripts, and other files outside the allowlist.
- Added an offline-cache tarball install smoke that runs the installed CLI shim
  for help, status, and invalid-command behavior.
- Added current-tree and reachable-history checks for high-confidence secret
  formats and forbidden credential/database filenames. Known negative-test
  fixtures use narrow file-and-rule allowances rather than a directory bypass.
- Replaced machine-specific example paths with explicit generic placeholders.
- Added contributor, security-reporting, and public-source-boundary guidance.
- Replaced live machine/service status in the packaged README with generic
  implemented capabilities.

## Final Verification

| Level | Result |
| --- | --- |
| Foundation | 56 passed |
| Component | 68 passed |
| Integration | 24 passed |
| Workflow | 3 passed |
| Recovery | 22 passed |
| Security | 38 passed |
| Type checking | passed |
| Build | passed |
| MCP smoke | connected; 13 tools; status succeeded |
| Current/history safety check | 145 files scanned; 0 findings |
| npm package manifest | 86 files; allowlist passed |
| Tarball install smoke | passed using the existing offline npm cache |
| Production dependency audit | 0 vulnerabilities |

Total tests in the final ordered run: 211.

The package contains only `dist/`, two sanitized files under `config/`,
`README.md`, `SECURITY.md`, and npm-required package metadata. It excludes
source, tests, infrastructure, operational handoffs, verification records,
internal plans, and service-management scripts.

## Corrected Findings

- An audit initially classified ARM template `contentVersion: 1.0.0.0` as a
  public IP address. Direct inspection proved this was a false positive; the
  template was not changed for that reason.
- The first installed-shim implementation used incorrect Windows command
  quoting. The smoke test failed closed, the invocation was corrected, and the
  same smoke test passed.
- A strict TypeScript index-signature error in the new package contract test
  was corrected and typecheck passed on rerun.

## Remaining Owner Gates

1. Create the eventual public repository from a reviewed clean export or
   sanitized history. The current private repository history contains internal
   operational paths and records even though no high-confidence credential was
   detected.
2. Run a clean-cache installation against the public registry or authorized
   CI network before claiming clean-machine installability. The current smoke
   proves installation only from the existing local npm cache.

## License Decision Addendum

The owner selected Apache-2.0 on 2026-08-25. The license and package metadata
were updated locally while `private: true` remained in place to preserve the
separate publication approval gate.

## Next Slice

Phase 2 subsequently implemented the generic node-identifier, explicit-routing,
durable migration, and static three-node infrastructure contracts. See
`SYS-A-OPEN-SOURCE-PHASE2-2026-08-25.md`.
