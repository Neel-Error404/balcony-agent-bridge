# [SYS-A] Paired runtime controls — local implementation checkpoint

October 7, 2026. Source branch `codex/river-paired-runtime-20261007`, based on
reviewed `e1ea77b65f47fb6bc9f1837503a1576b8283d7b6`.
Candidate metadata `0.3.1-pilot.1`. Implementation remains local and uncommitted.
No production services, credentials, signing, databases or Azure state changed.

## Implemented controls

- Explicit pilot configuration projects into the actual dispatcher. It requires
  consultation mode and only the pinned River registry resource.
- Six durable reservations per approved ledger, consumed before execution.
  Failed launches count; reserved/uncertain launches prevent overlapping work
  and block restart. Missing/mismatched ledger is not auto-created or reset.
- Explicit Codex model flag and subscription-sign-in checks. Configuration
  carries an expiring operator billing attestation, not a verified dollar cap.
  Authentication-file presence does not prove valid refresh or paid-overflow
  settings; actual provider/owner proof remains mandatory before live calls.
- Execution/output bounds, two consultation rounds, depth one, five-minute
  root deadline and refusal to save a child answer returned after that deadline.
  Ledger records safe run/node/model/request/launch metadata, not prompts.
- Explicit ledger prepare/status CLI; status verifies the same configuration
  identity as runtime and cannot label another run's ledger as its own.
- Shared transactional deployment module with separate Validate, Stage,
  Activate and Rollback operations, independent manifest SHA and shared run ID.
  Both updater command surfaces support stage-only/WhatIf without starting
  services. Activation requires fresh local and opposite-node same-service
  proofs; rollback requires explicit restored pre-migration schema evidence.
- Runtime bundle plan/build/verify/archive/extract tool, exact clean-source
  gate, production dependency closure, pinned Node/Codex tools, file digests,
  external archive receipt and operator-approved archive digest.

## Verification and reviewed fixes

Pilot red/green evidence covers persistent sixth/seventh launch, metadata,
explicit model, config projection, legacy-mode refusal, budget denial settlement,
answer limits, authentication changes and causal IDs.

Independent pilot review reproduced two defects: a 300.1-second child could
publish completed output after a 300-second root deadline, and status could
report another ledger as the configured run. Both were observed red, fixed,
and rerun green. The reviewer confirmed their closure.

The service readiness fixtures initially failed on PowerShell's automatic
timestamp conversion. Proof parsing now preserves date strings; success
fixtures reach actual XML replacement/restoration and negative fixtures reach
the intended failure boundary. Tests use a fake service adapter.

Final deployment review found three additional release-path gaps. Each was
addressed before closeout: activation failure after a start attempt now keeps
the restored XML stopped pending database restoration, rather than restarting
old code over a possibly migrated database; dispatcher XML binds both bundled
Codex paths and manifest hashes; extraction requires the independently approved
archive digest and retains it through final verification. Their regressions
were observed red and passed after correction; independent source review
confirmed the changes. Actual service/database behavior remains unverified.

The integrated ordered ladder passed:

| Level | Passed | Skipped |
| --- | ---: | ---: |
| Foundation | 190 | 1 |
| Component | 202 | 0 |
| Integration | 59 | 0 |
| Workflow | 7 | 0 |
| Recovery | 56 | 0 |
| Security | 71 | 0 |
| Total | **585** | **1** |

Bundle tooling: 18 passed. Typecheck/build, MCP smoke (13 tools, status),
PowerShell parse and public-safety scan (260 files plus history, zero findings)
passed at this checkpoint. Production audit: zero findings; all-dependency audit:
two moderate development-only findings. Logs are machine-local under the
original development checkout's `tmp/paired-runtime-20261007`.

The final complete ladder and 18 tooling tests were rerun after the last
deployment corrections. Review verdict is source-level only; reviewers did not
independently execute the entire ladder. No active command or service rehearsal
is left running from these checks.

Clean-cache installed-package smoke passed in a disposable empty npm project:

- `balcony-agent-bridge-0.3.1-pilot.1.tgz`
- SHA-1 `a02c4a5d6bb7887719b068eb5b5574f34d08453a`
- Integrity `sha512-oSRKtF7bVFdyaIPQTowGH7Wj16158HS6pJ4cjyqI1hsRsDx1yBok2R3qKuMTELDKQNckgxk+YU8EzkcE7Dw0vg==`
- 158 files; 245,915 packed bytes; 1,206,316 unpacked bytes.

This is a local installed consumer, not public publication or service artifact.

## Required work still remaining

The full requested phase is **not complete**:

1. Final reviewed source revision and clean-tree approval are required before
   producing the actual runtime bundle. No real release archive was produced;
   only synthetic tooling fixtures exercised the bundle workflow.
2. Both updater roles currently use the canonical service IDs. A real
   disposable-service rehearsal with unique IDs still needs an explicitly
   reviewed harness and operator authority; module fixtures are not WinSW.
3. PowerShell proof parsing requires `-DateKind String`; use a compatible
   approved PowerShell 7 host. Windows PowerShell 5.1 support is not certified.
4. Operator proof files bind identity, freshness and hashes but do not prove
   peer authorship, restore correctness or complete fleet quiescence. Neither
   updater migrates/restores SQLite or coordinates broker disposition.
5. Six launches are enforced per protected, operator-pinned ledger. Local
   administrators can replace files; no tamper-proof physical-node/global
   quota is claimed. No uncertain-reservation recovery or allowance renewal is
   automated.
6. Actual dedicated Codex sign-in/billing verification, real descendant
   interruption, signing enrollment, backlog/migration/grant decisions,
   same-archive transfer, paired cutover/rollback and twelve-launch live matrix
   remain unperformed.
7. No 24-hour observation was scheduled or completed. No 80% maturity verdict.

Next bounded action: review this source checkpoint, authorize its exact Git
delivery if desired, then build/verify one immutable bundle and establish the
disposable-service/operator rehearsal before any production activation.

Operator contract: [paired runtime pilot](../runbooks/paired-runtime-pilot.md).
