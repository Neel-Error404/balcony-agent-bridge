# [SYS-A inferred] PR #2 Remediation Verification — 2026-08-25

## Scope And Identity

- `BALCONY_SYSTEM_ID` was unset. `[SYS-A]` is inferred from the `D:` workspace
  path and is not a runtime identity claim.
- Branch: `codex/open-source-v0.1`.
- GitHub PR: `Neel-Error404/balcony-agent-bridge#2`.
- Reviewed PR head: `37865d135a9f4cd7684d1380aa5fb0fff7efcdf0`.
- Base: `9468ab9ba82a57e67cda451c19b8c1c3e5a2a4f3`.
- During the remediation review, the changes remained uncommitted and
  unpushed. On 2026-08-26 the owner approved the bounded Git delivery: stage
  the reviewed paths, commit and push the existing PR branch, then answer and
  resolve only the covered review threads. Merge, publication, Azure mutation,
  and service operation remain outside this approval.

## Outcome

The local working tree addresses the five live Codex review threads and the
nine findings from the immutable Code Security review of the pushed PR. A
second defensive review found and the local tree additionally closes:

- coordination-root idempotency races across database connections;
- third-node conversation-history pollution before bounded truncation;
- acceptance of databases created by a future runtime;
- incomplete secret detection in both release and runtime payload gates;
- reuse of unauthenticated legacy results as continuation authority or agent
  thread context; and
- opaque Windows identity setup failures.

The cross-origin message-ID comment is resolved locally with a stricter
authenticated-origin model than its suggested patch: the conflicting incoming
delivery is rejected and dead-lettered while the already authenticated row is
left unchanged. Quarantining the existing row would let any authorized peer
disable another peer's accepted work merely by copying its public message ID.
This behavior is stated in `docs/threat-model.md` and covered by the database
collision test.

## Code Review And Security Review

- The two-axis code review found no remaining blocking standards or
  correctness issue after remediation. It recorded non-blocking duplication
  risks around canonical JSON, route predicates, schema descriptors, and
  Windows ACL policy; these are refactoring opportunities, not release
  behavior gaps.
- Code Security scan `329124af-b4f9-4def-99a8-63e33ccab953` completed and was
  sealed against the immutable PR range. It reported nine findings (two medium,
  seven low) in the pushed commit. Every reported behavior has a local fix and
  regression coverage. The scan correctly records that local remediation is
  outside its immutable target.
- A post-scan defensive review identified runtime secret-pattern parity and
  legacy signed-ingress provenance gaps. The local tree now uses schema v7
  provenance, excludes unauthenticated inbound rows from coordination history,
  and rejects AWS, OpenAI, Slack, npm, client-secret, SAS, credentialed-URL,
  and private-key material in runtime payload strings.

## Ordered Verification

| Level | Command | Result |
|---|---|---|
| Dependency install | `npm ci` | 228 packages installed; 0 vulnerabilities |
| Foundation | `npm run test:foundation` | 16 files, 99 passed, 1 platform skip |
| Component | `npm run test:component` | 16 files, 96 passed |
| Integration | `npm run test:integration` | 7 files, 28 passed |
| Workflow | `npm run test:workflow` | 3 files, 4 passed |
| Recovery | `npm run test:recovery` | 6 files, 22 passed |
| Security | `npm run test:security` | 11 files, 58 passed |
| TypeScript | `npm run typecheck` | passed |
| Build | `npm run build` | passed |
| MCP smoke | `npm run smoke:mcp` | connected; 13 tools; status passed |
| Secret/history scan | `npm run check:secrets` | 181 files and reachable history; 0 findings |
| Production dependency audit | `npm audit --omit=dev` | 0 vulnerabilities |
| Package inspection | `npm run verify:package` | passed |
| Isolated clean-cache consumer | `npm run verify:public-alpha` | passed |
| PowerShell parse | release/service scripts | passed |
| Bicep build | all four entry points via Azure CLI Bicep 0.46.1 | passed |
| Diff hygiene | `git diff --check` | passed; line-ending warnings only |

Total tests: 307 passed and one platform-specific test skipped.

The final package evidence was:

```json
{
  "package_filename": "balcony-agent-bridge-0.1.0.tgz",
  "package_shasum": "d0079cb055a5f6e73a6b2f7e9b7bbc897c07dc2b",
  "package_integrity": "sha512-BrDQ65h2x95Ay6YOFN72td0aKcBAVtPv/euulxRXaJW8Nmnlj28fYAzdZfu/OB6EWvtWc8rg6lwdoGG+1dVuhg==",
  "package_file_count": 102,
  "package_size_bytes": 122125,
  "unpacked_size_bytes": 620169,
  "install_smoke": "isolated-cache-network",
  "consumer_environment": "disposable-empty-npm-project",
  "dependency_tree": "valid",
  "package_command": "npm-exec-offline"
}
```

## Remote PR State And Delivery Gate

At review time PR #2 was open, non-draft, and GitHub reported it mergeable with
no configured status checks or approval decision. Its head remained
`37865d135a9f4cd7684d1380aa5fb0fff7efcdf0`; all five automated inline threads
were unresolved and not outdated because this remediation had not been pushed.

The owner approved staging, commit, push, and covered-thread resolution on
2026-08-26. The delivery commit includes this record and the untracked test
helper. Its resulting Git SHA and final remote review state are authoritative
in PR #2 and the vault project summary; they cannot be self-recorded inside
the commit that creates that SHA. Public visibility, npm publication, Azure,
RBAC, service installation, live multi-machine validation, and the merge
itself remain separate owner-gated actions.
