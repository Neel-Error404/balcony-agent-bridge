# [SYS-A] Batch 5 Updater P1 Fix Candidate — 2026-08-20

## Source Review

SYS-B durably returned review message
`15a2306a-790d-497c-9bfd-37bf22e8c0e5` in conversation
`af921994-72f8-4e28-bc00-562cc7154a78`. Its clean exact-SHA review passed the
original `185/185` ladder but reproduced two P1 defects during a live
`Update-DispatcherService.ps1 -WhatIf`:

1. The lexical `GetRelativePath` check rejected a valid machine-local registry
   on another Windows volume.
2. Preflight required the live registry to pin the undeployed candidate rather
   than validating its current deployed path and revision separately from the
   desired release.

Candidate branch: `codex/sys-a-batch5-codex-bundle`

Candidate parent: `1bf89d44857f1341d9e94288eb4aaba4abd0d96a`

## Corrections

- Separator-aware canonical containment now rejects only a registry at or
  inside the candidate repository. Cross-volume and prefix-sibling paths are
  accepted.
- Preflight resolves the current bridge entry, verifies its exact Git revision
  and clean checkout, and computes the desired candidate registry in memory.
- `-WhatIf` exercises all validation without writing the registry.
- A real upgrade backs up the exact registry bytes before stopping the
  dispatcher.
- Atomic same-directory replacement updates only the
  `balcony-agent-bridge` path and revision while preserving unrelated entries
  and the existing registry ACL.
- Failure recovery atomically restores the original registry bytes before the
  prior service running state is restored.

## Executable Regression Evidence

- Cross-volume external-registry acceptance: passed.
- Repository-contained and prefix-sibling containment cases: passed.
- Current-to-candidate bridge-pin migration: passed.
- Unrelated project and top-level metadata preservation: passed.
- Current-pin mismatch rejection: passed.
- `-WhatIf` registry non-mutation: passed.
- Exact-byte registry rollback, including an original UTF-8 BOM: passed.

## Verification

| Level | Result |
|---|---:|
| Foundation | 54/54 |
| Component | 67/67 |
| Integration | 23/23 |
| Workflow | 3/3 |
| Recovery | 12/12 |
| Security | 33/33 |
| **Total** | **192/192** |

Additional verification:

- Typecheck: passed.
- Production build: passed.
- Compiled MCP smoke: connected, 13 tools, status successful.
- Production audit: zero reported vulnerabilities.
- Focused regression suite: 16/16 passed after first reproducing all requested
  seams as failures.

## Runtime Boundary

No dispatcher, bridge, MCP process, ProgramData file, machine-local registry,
DLQ message, Azure resource, RBAC assignment, network rule, credential, or
authentication state was changed. This is a source candidate only.

## Remaining Gates

1. Publish the candidate branch and record its exact remote SHA.
2. Have SYS-B run the complete current `192/192` ladder and a live
   cross-volume `-WhatIf` against its unchanged deployed registry.
3. Reconcile an owner-approved exact release on `main` only after SYS-B returns
   `READY_FOR_MAIN_RECONCILIATION`.
4. Upgrade SYS-A and SYS-B one at a time under separate deployment approvals.
