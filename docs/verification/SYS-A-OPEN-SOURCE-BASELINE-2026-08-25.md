# [SYS-A] Open-Source Branch Baseline - 2026-08-25

## Scope

This record covers local Phase 0 verification only. It does not prove a live
deployment, SYS-B state, Azure state, package publishability, or public-release
readiness.

The `BALCONY_SYSTEM_ID` process variable was unset during this run. The
`[SYS-A]` routing tag follows the active D-drive workspace convention; no
runtime identity decision was made from that missing variable.

## Source

- Branch: `codex/open-source-v0.1`
- Accepted base and verified HEAD:
  `9468ab9ba82a57e67cda451c19b8c1c3e5a2a4f3`
- Node.js: `v22.14.0`
- npm: `10.9.2`
- Dependency setup: `npm ci`
- Dependency audit reported: 0 vulnerabilities

At test start, no tracked source changes existed. The only worktree additions
were the open-source roadmap and execution contract.

## Ordered Verification

| Level | Command | Result |
| --- | --- | --- |
| Foundation | `npm run test:foundation` | 54 passed |
| Component | `npm run test:component` | 68 passed |
| Integration | `npm run test:integration` | 24 passed on controlled rerun |
| Workflow | `npm run test:workflow` | 3 passed |
| Recovery | `npm run test:recovery` | 22 passed |
| Security | `npm run test:security` | 33 passed |
| Type checking | `npm run typecheck` | passed |
| Build | `npm run build` | passed |
| MCP smoke | `npm run smoke:mcp` | connected; 13 tools; status succeeded |

Total tests passing in the final ordered baseline: 204.

## Integration Flake Record

The first integration run did not pass:

- `migration-concurrency.test.ts` timed out at 5 seconds;
- `dispatcher-registry-migration-process.test.ts` timed out at 5 seconds;
- `codex-executor-process.test.ts` timed out at 5 seconds and cleanup reported
  an `EBUSY` lock on its temporary project directory.

All three failures were process-boundary or concurrent-process tests. No code
or configuration changed before the immediate same-level rerun. That rerun
passed all 24 integration tests in 5.45 seconds, after which the remaining
levels passed.

The observed facts establish a transient baseline flake. Cold process startup
or Windows resource contention is a plausible cause, but the exact cause is
not yet verified. It should be tracked during later test work; it does not
justify changing production behavior in Phase 0.

## Phase 0 Verdict

The isolated branch reproduces the accepted source baseline and is ready for a
review checkpoint. No application, transport, database, infrastructure, or
live-runtime behavior was changed.
