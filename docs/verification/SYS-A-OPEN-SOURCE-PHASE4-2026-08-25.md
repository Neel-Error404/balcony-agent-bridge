# [SYS-A] Open-Source Phase 4 Verification

Date: 2026-08-25
Branch: `codex/open-source-v0.1`
Accepted base: `9468ab9ba82a57e67cda451c19b8c1c3e5a2a4f3`
Security snapshot: `1e02b4ad427029c8a54d5e21613d0593c42d4690f993a77ac131c20c7438a60d`

`BALCONY_SYSTEM_ID` was unset in this shell. The `[SYS-A]` tag is the documented
D-drive fallback; no claim about a running bridge identity is made.

## Outcome

Phase 4 is locally implemented and verified. Production Service Bus messages
now require a strict Ed25519 signed wire wrapper bound to the full unchanged
durable envelope, network, key ID, issue time, expiry, and broker metadata.
The fake transport remains unsigned and local-only. There is no unsigned
production fallback.

No Git staging, commit, push, repository visibility change, npm publication,
Azure change, Windows-service installation, or live multi-machine cutover was
performed.

## Implemented Boundary

- Static local membership whose peers exactly match the configured authorized
  nodes, with unique Ed25519 public keys, active/revoked state, and optional
  validity windows.
- Bridge-only private-key configuration; MCP and dispatcher configuration never
  load the signing key.
- Signed Service Bus egress and fail-closed verified ingress before SQLite.
- Broker metadata binding for message ID, session, correlation presence/value,
  subject, target property, schema version, and stream ID.
- Fixed body-free authentication dead-letter reason and description.
- Seven-day maximum wire lifetime, envelope-expiry bound, five-minute future
  clock tolerance, live replay deduplication, and expired replay rejection.
- Cross-origin message-ID collisions cannot quarantine another peer's existing
  inbox row.
- Offline `identity` CLI that produces a private PKCS8 key and public enrollment
  JSON without overwrite or private-key output.
- Windows installer validation for credential ACLs, runtime owners/writers,
  ancestor replacement paths, complete `dist`/`node_modules` trees, and final
  service artifacts.
- Public threat model plus enrollment, cutover, rotation, revocation, replay,
  and incident-response guidance.

The durable `BridgeEnvelope`, SQLite schema, MCP tool contract, dispatcher
boundary, and fake/local demo protocol were not expanded.

## Verification

The levels were run separately in the required order:

| Level | Command | Result |
|---|---|---|
| Foundation | `npm run test:foundation` | 15 files, 90 tests passed |
| Component | `npm run test:component` | 16 files, 83 tests passed |
| Integration | `npm run test:integration` | 7 files, 27 tests passed |
| Workflow | `npm run test:workflow` | 3 files, 4 tests passed |
| Recovery | `npm run test:recovery` | 6 files, 22 tests passed |
| Security | `npm run test:security` | 11 files, 43 tests passed |

Total: 58 test files and 269 tests passed.

Additional checks:

| Check | Result |
|---|---|
| `npm run typecheck` | Passed |
| `npm run build` | Passed |
| `npm run smoke:mcp` | Connected, 13 tools, status succeeded |
| `npm run smoke:package` | 102 files; 114,324-byte package; 584,050 bytes unpacked; offline installed-package smoke passed, including identity generation |
| `npm run check:secrets` | 170 files plus reachable history scanned; 0 findings |
| `npm audit --omit=dev --audit-level=low` | 0 vulnerabilities |
| Windows ACL behavioral proof | `ACL_BEHAVIORAL_PROOF_PASS` |
| PowerShell AST parse | Installer, ACL module, and behavior proof parsed with 0 errors |
| `git diff --check` | Passed; only expected LF-to-CRLF checkout warnings |

An independent fresh-context security review initially found shared key reuse,
pre-activation replay, cross-origin collision quarantine, and Windows ACL
gaps. Corrections were implemented and retested. The final review reported no
remaining P0, P1, or P2 finding in the Phase 4 scope.

The vault project summary was updated after a read-only fetch and local project
discovery. Vault freshness reported only the two already-known unrelated
timestamp mismatches for `ai-career-portfolio` and `personal-authoring-lab`.
The broader vault Pester run passed 43 of 50 tests; seven discovery tests failed
inside pre-existing modified vault scripts/tests and were not changed as part
of Agent Bridge Phase 4.

## Residual Risks And Deferred Work

- A stolen authorized key remains valid until every receiver receives and
  activates the revocation policy.
- An authorized peer can send harmful but correctly signed content and can
  access every dispatcher project marked `peer_readable`; v0.1 has no
  per-origin project ACL.
- An exact unexpired replay can be accepted after SQLite loss or rebuild;
  consumers must remain idempotent by `message_id`.
- Azure DLQ retains rejected broker bodies and a topic sender can still create
  broker/DLQ load. RBAC, monitoring, and retention remain operator controls.
- Verified key ID/signature are not persisted with the unchanged SQLite
  envelope.
- File validation has a validation/use race. Local administrators and the
  bridge service account remain inside the host trust boundary.
- Static membership distribution and revocation are manual and require a
  coordinated service restart.

Hosted discovery/pairing, a control plane, dynamic membership, per-origin
project ACLs, live Azure/RBAC changes, service rollout, public publication, and
Git delivery remain deferred or owner-gated.
