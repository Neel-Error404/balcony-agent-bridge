# [SYS-A] Open-Source Phase 3 Verification — 2026-08-25

## Scope

Phase 3 adds the smallest local onboarding surface needed for another operator:

- one idempotent `setup` command;
- one deterministic three-node demo with no Azure dependency;
- one read-only, secret-safe `doctor` command;
- explicit `--config` loading for both the CLI and stdio MCP server;
- an installed-tarball smoke test for the documented path.

Azure provisioning, RBAC mutation, service installation, registry publication,
and live multi-machine validation were not authorized and were not performed.

## Implemented Contract

- `balcony-agent-bridge demo` proves direct A-to-C routing, wrong-target
  rejection at B, duplicate suppression at C, and a causal C-to-A reply using
  only in-memory databases and the fake transport.
- `balcony-agent-bridge setup --node-id <id> --authorized-node <id>` creates a
  local JSON profile and schema-v5 SQLite database, then emits the MCP
  registration using an absolute `--config` path.
- Exact setup reruns are idempotent. Conflicting profiles, orphan databases,
  invalid identities, and relative explicit paths fail closed without
  overwrite.
- Database creation is exclusively reserved; cleanup removes only database
  files reserved by the current setup invocation.
- `balcony-agent-bridge doctor --config <absolute-path>` validates Node.js,
  runtime files, parsed configuration, identity prerequisites, SQLite
  integrity/schema, and optionally a non-message-sending Service Bus sender
  link.
- Managed identity supports both system-assigned and explicit user-assigned
  identities. Certificate mode requires tenant ID, client ID, and an existing
  absolute certificate path. No client secrets or connection strings are
  accepted.

## Verification Results

All commands ran in `D:\Work_Projects\balcony-agent-bridge-open-source` on
`[SYS-A]`.

| Check | Result |
|---|---:|
| `npm run test:foundation` | 13 files, 66 tests passed |
| `npm run test:component` | 16 files, 82 tests passed |
| `npm run test:integration` | 6 files, 26 tests passed |
| `npm run test:workflow` | 3 files, 4 tests passed |
| `npm run test:recovery` | 6 files, 22 tests passed |
| `npm run test:security` | 9 files, 39 tests passed |
| Total | 53 files, 239 tests passed |
| `npm run typecheck` | passed |
| `npm run build` | passed |
| `npm run smoke:mcp` | connected; 13 tools; status succeeded |
| `npm run smoke:package` | 96 files; 104070 bytes packed; installed offline; setup/doctor/demo/status passed |
| `npm run check:secrets` | 158 files plus Git history; 0 findings |
| `npm audit --omit=dev --audit-level=high` | 0 vulnerabilities |
| `git diff --check` | passed; line-ending notices only |

The integration tier is intentionally serialized with `--maxWorkers=1` because
its Windows process fixtures contend and time out under unrestricted parallel
execution. The same tier passed after serialization; this is a test-runner
constraint, not a product fallback.

During the final standard integration run, the existing concurrent-migration
test exposed an intermittent `SQLITE_BUSY` while enabling WAL mode. The
database now sets its busy timeout before the WAL pragma. The focused race was
then run five consecutive times successfully, followed by a clean full
integration tier.

## Independent Review

Three read-only reviews covered correctness, security, and package/DevEx.
They initially found a concurrent-setup cleanup race and a system-assigned
managed-identity mismatch. Both were corrected and regression-tested. The
correctness and security reviewers then rechecked those fixes and reported no
remaining blocker. No credential leakage, MCP stdout contamination, Azure
mutation, Git mutation, or transport message send was observed.

## Exit Decision

Phase 3 is complete locally: a new operator can run the offline demo, create an
authorized local node, copy its MCP registration, inspect status, and diagnose
local or optional transport failures using the README happy path.

This is not a public-release approval. `private: true` remains set, and Phase 4
multi-node security work plus owner-gated release operations remain pending.
