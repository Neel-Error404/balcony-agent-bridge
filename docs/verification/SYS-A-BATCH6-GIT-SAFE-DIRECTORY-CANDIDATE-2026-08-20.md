# [SYS-A] Batch 6 Command-Scoped Git Trust Candidate - 2026-08-20

## Scope

Repair the demonstrated `LocalService` Git dubious-ownership failure without
writing global or system Git configuration, changing repository ownership, or
broadening trust beyond the already canonicalized allowlisted project root.

This candidate was verified in isolation and subsequently published under
separate owner approval. It is not deployed.

## Candidate Identity

- Base revision: `77d60f4dce2d8bf1f2e3e1d8c6df667d4f6c109b`.
- Branch: `codex/sys-a-batch6-git-safe-directory`.
- Worktree: `D:/Work_Projects/balcony-agent-bridge-batch6-safe-directory`.
- Modified implementation:
  `src/evidence/pinned-git-evidence-provider.ts`.
- Added regression:
  `tests/component/pinned-git-evidence-provider.test.ts`.
- Candidate state: verified before publication with no staged files; the exact
  published SHA is the owner-approved branch head recorded by the remote ref.

## Implementation

Every pinned-Git subprocess now uses one shared argument builder that places
the following command-scoped configuration before `-C`:

```text
-c safe.directory=<canonical allowlisted project root>
```

The value is the same canonical root already used for containment, repository
root equality, clean-worktree, and exact-revision checks. The helper rejects
Git safe-directory wildcard syntax. Both mandatory Git reads and the optional
branch lookup use the helper. No `git config` command or persistent config
write exists in the candidate.

## Regression Proof

The new component test isolates Git from system and global configuration,
forces `GIT_TEST_ASSUME_DIFFERENT_OWNER=1`, and first proves ordinary Git fails
with `detected dubious ownership`. It then requires the provider to retrieve
the exact committed `README.md` blob and verifies that the isolated global
config remains zero bytes.

Before the implementation, the focused file produced seven passes and one
failure at `Git could not read repository root`. After the implementation, the
same focused file passed `8/8`.

The compiled candidate was also exercised against the actual standalone SYS-A
runtime clone while the different-owner condition was forced:

- Provider outcome: pass.
- Evidence source: `pinned_git`.
- Git commit:
  `77d60f4dce2d8bf1f2e3e1d8c6df667d4f6c109b`.
- Evidence path: `README.md`.
- Evidence bytes: `6736`.
- Isolated global Git config bytes after collection: `0`.

## Verification Ladder

| Level | Result |
|---|---:|
| Foundation | 54/54 |
| Component | 68/68 |
| Integration | 24/24 |
| Workflow | 3/3 |
| Recovery | 12/12 |
| Security | 33/33 |
| **Total** | **194/194** |

The first full integration invocation reported `22/24` because the MCP stdio
and simultaneous migration child-process tests both crossed their existing
five-second timeout. Each passed independently (`1/1`), and the unchanged full
integration level then passed `24/24`. No unrelated timeout or test-production
code was changed.

Additional gates:

- TypeScript typecheck: pass.
- Production build: pass.
- MCP smoke: connected, thirteen tools, status successful.
- Production dependency audit: zero vulnerabilities.
- `git diff --check`: pass.
- Candidate HEAD remains exact base revision and only the reviewed source and
  test files are modified before this evidence file.

## Non-Mutation Boundary

- No service or runtime registry was changed.
- No Batch 6 command invoked a dispatcher or bridge restart.
- No Git global or system configuration was written.
- No repository ownership or ACL was changed.
- No Azure, RBAC, networking, authentication, DLQ, or message state changed.
- Candidate construction performed no staging, commit, or push. Publication
  was separately owner-approved and is recorded by the branch head.

The final read-only runtime check observed newer bridge and dispatcher wrapper
PIDs than the pre-candidate snapshot. Their process creation times predated the
final check, and no command in this candidate workflow targeted either service.
Both canonical runtime-safety scripts pass with one service-owned child, and
the dispatcher registry remains pinned to the deployed standalone `77d60f4`
runtime clone. This is recorded as external runtime drift, not deployment or
acceptance of the published Batch 6 candidate.

The next gate is independent SYS-B verification of the exact published branch
SHA. Merge to `main`, deployment, and live nested acceptance each require
separate approval.
