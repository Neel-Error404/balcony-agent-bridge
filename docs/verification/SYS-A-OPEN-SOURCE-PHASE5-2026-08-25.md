# [SYS-A inferred] Open-Source Phase 5 Verification — 2026-08-25

## Scope And Identity

- `BALCONY_SYSTEM_ID` was unset. `[SYS-A]` is an explicit inference from the
  `D:` workspace path, not a runtime identity claim.
- Branch: `codex/open-source-v0.1`.
- Accepted base HEAD: `9468ab9ba82a57e67cda451c19b8c1c3e5a2a4f3`.
- The complete Phase 0-5 candidate remains an uncommitted working tree.
- No Git staging, commit, push, tag, repository visibility change, npm
  publication, Azure operation, RBAC change, or service install/start/restart
  was performed.

## Phase 5 Outcome

The repository now supplies one ordered public journey covering installation,
local demo, node configuration, owner-gated deployment, signed connection,
verification, the unsupported in-place upgrade boundary, and recovery. It also
contains a configuration reference, troubleshooting guide, three-node example,
known limitations, and exact release manifest.

The clean-environment proof is deliberately bounded to a disposable empty npm
consumer and isolated empty npm cache on this Windows host. It is not evidence
from a separate OS image, public npm registry, or live multi-node deployment.

During independent review, the setup-generated MCP command was found to be
unresolvable outside a local package's `.bin` directory. The CLI now emits an
absolute Node.js command plus absolute installed MCP entrypoint and profile
path, and the package verifier executes that exact registration from a neutral
working directory through MCP initialize, tools/list, and status.

The same review found that the Windows runtime ACL validator rejected ordinary
ancestor create/write permissions. The corrected validator still rejects all
untrusted mutation on the leaf and rejects ancestor delete, delete-child,
ownership, and DACL-control rights, while accepting non-replacement access on
normal Windows ancestors and ignoring non-applicable `InheritOnly` ACEs.

## Ordered Verification

| Level | Command | Result |
|---|---|---|
| Foundation | `npm run test:foundation` | 16 files, 95 tests passed |
| Component | `npm run test:component` | 16 files, 83 tests passed |
| Integration | `npm run test:integration` | 7 files, 27 tests passed |
| Workflow | `npm run test:workflow` | 3 files, 4 tests passed |
| Recovery | `npm run test:recovery` | 6 files, 22 tests passed |
| Security | `npm run test:security` | 11 files, 43 tests passed |
| TypeScript | `npm run typecheck` | passed |
| Build | `npm run build` | passed after cleaning `dist/` |
| MCP smoke | `npm run smoke:mcp` | connected, 13 tools, status succeeded |
| Secret/history scan | `npm run check:secrets` | 179 files plus reachable history, 0 findings |
| Production dependencies | `npm audit --omit=dev --audit-level=low` | 0 vulnerabilities |
| PowerShell parse | all `scripts/*.ps1` and `scripts/*.psm1` | 15 files, passed |
| Windows ACL behavior | `tests/foundation/bridge-service-security-behavior.ps1` | `ACL_BEHAVIORAL_PROOF_PASS` |
| Topology preflight | public three-node parameters for `node-a` | 3 nodes, passed |
| Bicep | lint and stdout build for deploy, main, routing rules, and budget | 4 files, passed with Azure CLI 2.77.0 |
| Diff hygiene | `git diff --check` | passed; checkout emitted line-ending warnings only |

Total automated tests: 274 passed.

One intermediate security run failed because the public MCP template contained
realistic absolute Windows examples outside the approved placeholder pattern.
The example now uses only `C:\path\to\...`; the same security tier was rerun and
passed 43/43. The configuration fail-closed test was also observed red before
the mixed Azure identity-mode validation was implemented.

## Clean Consumer And Package Evidence

Command: `npm run verify:public-alpha`

```json
{
  "platform": "win32",
  "architecture": "x64",
  "node_version": "v22.14.0",
  "npm_version": "10.9.2",
  "package_filename": "balcony-agent-bridge-0.1.0.tgz",
  "package_shasum": "7786824a80411fab9ea8b31b82a608c5aab80de1",
  "package_integrity": "sha512-R56Ty929HKjggM3S9Vs9FssxmI6cg/sT7BLjuHygV9O+T6Ui5zCCLrQXj6a7tvSJOiNOAejl0lZwqdcep36xJA==",
  "package_file_count": 102,
  "package_size_bytes": 116169,
  "unpacked_size_bytes": 590809,
  "install_smoke": "isolated-cache-network",
  "consumer_environment": "disposable-empty-npm-project",
  "dependency_tree": "valid",
  "package_command": "npm-exec-offline"
}
```

The verifier compared the exact installed tarball with the dry-run filename,
hashes, sizes, and file list; installed dependencies using an isolated empty
cache; validated the dependency tree; exercised both public binaries; tested
default-path and explicit setup; verified idempotency, doctor, demo, status,
and invalid-command behavior; and executed the generated absolute MCP
registration from a neutral directory.

## Independent Review

- Final documentation/package/operator-path review: no remaining P0/P1/P2
  finding after the source CLI path, Windows proof boundary, disposable
  consumer cleanup, and exact bin-verification claims were corrected.
- Package/clean-consumer review: the absolute MCP registration, isolated-cache
  install, exact manifest comparison, clean build, dependency-tree check, and
  neutral-directory MCP use are aligned.
- ACL security review: no remaining P0/P1/P2 in the corrected validator; direct
  Windows behavior and focused contract checks passed.

## Vault Handoff

- The `[SYS-A]` Agent Bridge project note records Phase 5 and links this proof.
- Local discovery completed with 78 Git repositories and 31 non-Git projects.
- Vault freshness reported two pre-existing, unrelated timestamp mismatches for
  `ai-career-portfolio` and `personal-authoring-lab`. It reported no Agent
  Bridge freshness issue; unrelated project state was not changed.

## Owner-Gated Before Public Release

- Approve the exact clean public source export/history and release diff.
- Add the canonical public repository/homepage/issue URLs to package metadata.
- Add a concrete private vulnerability-reporting channel to `SECURITY.md`.
- Decide whether to perform an additional clean OS/VM evaluation.
- Approve any commit, push, tag, repository visibility change, or npm publish.
- Approve Azure `what-if`, deployment, identity/RBAC/network/budget changes,
  service installation/start, and live signed multi-machine acceptance.

The local Phase 5 candidate is decision-ready. It is not published and makes
no claim about current live deployment state.
