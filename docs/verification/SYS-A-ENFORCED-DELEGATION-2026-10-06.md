# [SYS-A] Enforced delegation contract — October 6, 2026

Status: **implemented and locally tested; not committed, published or deployed**.

## Outcome

The next bounded implementation slice now enforces caller delegation authority
in code rather than relying on task prose. New tasks default to protocol 1.1
with no peer delegation; bounded peer work requires explicit positive depth.
The coordinator rejects a prohibited model request before creating a nested
outbox task and rechecks waiting-peer recovery. Approved local evidence work
still completes.

This addresses the recorded legacy probe that sent a nested task against its
no-delegation instruction. It does not restore service supervision or a stopped
SYS-B dispatcher, provide chat wake-up, or certify 80% maturity.

## Implemented contract

- `CoordinationRequestSchema` distinguishes legacy 1.0 from 1.1. The new
  version requires `delegation: {mode: none}` or
  `{mode: bounded, max_depth: 1..4}`. Unknown versions/policy smuggling reject.
- `askAgent` defaults to 1.1 none; MCP exposes validated explicit delegation.
  Idempotent reuse with different policy conflicts. Continuation retains
  caller-declared authority; the receiver reapplies local/context limits.
- Context cannot exceed explicit authority. Zero depth represents none.
- Effective policy is stored in consultation JSON. Historical missing policy
  decodes as none. Run identity/version fencing prevents policy changes.
- The child prompt offers peer-request forms only when permitted. Runtime
  enforcement remains authoritative if model output ignores the prompt.
- Disallowed peer output fails with
  `CONSULTATION_DELEGATION_PROHIBITED` and zero nested request creation.
  Explicit bounded work respects the minimum local/caller/parent limit.
- Waiting-peer recovery rechecks policy before enqueue. Missing legacy
  authority cannot revive nested work. Existing completed legacy results may
  still settle; pending legacy nested work needs cutover disposition.
- Nested 1.1 requests carry effective policy/context. Results preserve the
  original request protocol. A 1.0 result cannot be used as a 1.1 caller
  completion or incorporated as nested peer evidence.
- No new SQLite table or production migration is introduced by this slice.

## Fresh checks

Ordered local application tiers on Windows x64, Node 22.14.0, npm 10.9.2:

| Tier | Result |
| --- | ---: |
| Foundation | 216 passed, 1 platform skip |
| Component | 162 passed |
| Integration | 58 passed |
| Workflow | 7 passed |
| Recovery | 35 passed |
| Security | 68 passed |
| **Application total** | **546 passed, 1 skipped** |
| Tooling | 12 passed |

The security tier first failed because one existing positive fixture replied
with 1.0 to a new 1.1 caller. The fixture was updated to matching version,
preserving the separate wrong-version negative, and the same tier reran green.
Independent review identified a nested-result version check missing before
peer evidence incorporation. A red regression reproduced it; the guard and
security negative passed afterward. No failure was bypassed.

Typecheck/build, 13-tool compiled MCP smoke, package-content checks and diff
whitespace passed. Configured history secret scan: 255 files, zero findings.
Production dependency audit: zero findings at this run. Those are bounded
scanner results, not universal absence of unknown vulnerabilities.

The actual old operating decoder was tested with a synthetic 1.1 request and
rejected it, without persistence or send. Compatibility is fail-closed, not
legacy reinterpretation.

Installed-consumer smoke first failed **ENOSPC on C:**. The failure and npm
cleanup warnings were preserved. Capacity was checked; C: had about 404 MB
free and D: about 31 GB. The same verifier was explicitly rerun offline with
run-owned D: temporary storage and the existing project cache. It passed:
disposable empty npm project, valid production tree, packaged CLI/demo/local
administration. `global_codex_isolation=not-required`; a cold-cache or two-OS
qualification is not claimed.

After the owner reported restored disk space, the original C: temporary-path
offline verifier was explicitly retried. It passed with the same package
SHA-1/integrity, valid production dependency tree and disposable consumer.
The C: ENOSPC failure remains recorded; no unrelated files were deleted.
Both D: and C: successful runs are same-host installed-package evidence.
Retry log: `tmp/delegation-contract-20261006/installed-package-c-temp-retry.log`.

Package verification: 156 files, 249,906 packed bytes, 1,217,540 unpacked,
SHA-1 `808c0eb0defd700a32fe2c7ecdb539482f8ee5eb`, integrity
`sha512-vDelmmap4Uzy8qpQVaiCT/TJLr+jfoV3/+sBZpY/qNJJoK5LEYGkpOZFRg55S0JvJ9VB7gHzBHpwvgSq1QyFGA==`.
This supersedes the previous local tarball; it is not a published release.

## Independent review and limitations

Independent read-only review found no remaining delegation-widening path in
the scoped caller/schema/coordinator/durable-run seams after the nested-result
fix. Review did not independently rerun the full ladder or certify deployment.

Changes to local depth policy across a paused run can fail closed on durable
identity mismatch and require explicit operator recovery; this is a known
liveness boundary. No protocol field grants new resource access or privilege.
The scope is peer-consultation authority, not all possible model side effects
or universal agent-runtime delegation.

## SYS-B coordination and source history

A bounded requirements status was sent on the ordinary diagnostic stream,
caused by SYS-B's diagnostic:

- message: `f5469f99-883f-4a59-b96f-eda87bcd68f1`;
- local state: sent at `2026-10-05T20:33:44.784Z`;
- peer receipt/action: not verified.

A tested checkpoint, including the successful original C: retry, was locally
enqueued as `1e57c5ba-c677-4a4a-9f69-5c428172aec0`, caused by the requirements
packet. Its enqueue is not verified SYS-B receipt or implementation. Neither
packet grants authority to change Git, services, credentials or deployment.

`docs/handoff/SYS-B-ENFORCED-DELEGATION-2026-10-06.md` names the companion
requirements, repo preservation, existing-fleet recovery, compatibility and
paired acceptance. A message is not authority to pull, upgrade, create keys or
mutate services. SYS-B should return a secret-safe disposition through the
diagnostic stream when the owner opens its operator session.

`docs/CHANGELOG.md` records released versions separately from local candidate,
diagnostic and implementation history. It does not invent commits or tags.
The current branch is `codex/npm-first-onboarding-v0.3.1`, committed HEAD
`fc876483b83ddebf16cc7ae5f3d3f437a845c63c`. Significant inherited onboarding
and October 5 hardening changes remain uncommitted. No stage, commit, push,
merge, tag or publication was performed.

## Git and deployment gate

The change-set manifest is prepared under
`tmp/delegation-contract-20261006/git-candidate-change-set.json`.
It inventories 93 dirty candidate files and marks 19 source/test paths changed
during this slice; it is not an approved staging set. It separates this source slice from the
larger inherited dirty candidate and records exact path/hash identities.
Stage only an explicitly approved reviewed path set; do not use `git add .`.
A scoped patch cannot silently omit its inherited candidate dependencies.

Before Git delivery: review exact diff and public safety, approve paths and
commit grouping, commit with SYS-A provenance, push the approved branch and
review the remote immutable head. Maintain the vault as source-linked summary,
not a replacement implementation log.

Before deployment: recover old fleet ownership, obtain SYS-B disposition,
clean reviewed source revision and service-capable artifact, validate actual
signing membership/credentials and service-account ACLs, account for legacy
backlog, quiesce writers and validate per-node backups/paired rollback, review
preview/what-if as applicable, then deploy compatibly to both nodes.
Do not send 1.1 to the legacy fleet or mix signed/raw production traffic.

After deployment: real local-evidence answer under none, enforced prohibited
peer negative, explicit bounded positive, restart/replay and resource-denial
checks, one-worker service ownership and exact causal acceptance both ways.
Only those observations can close the operational gate. The last 61.4/100
assessment is not automatically raised by this local patch.

No service, operating database, credential, Azure/RBAC or signed-fleet state
was changed in this implementation slice. Only the permitted diagnostic
coordination messages affected the existing bridge outbox.

## Evidence locations

- Local tier/red-green logs:
  `C:/Users/neela/AppData/Local/Temp/agent-river-delegation-contract-20261006/`.
- D: offline package retry and final manifests:
  `D:/Work_Projects/balcony-agent-bridge-open-source/tmp/delegation-contract-20261006/`.
- Plan: `docs/plans/2026-10-06-enforced-delegation-contract.md`.
- SYS-B handoff: `docs/handoff/SYS-B-ENFORCED-DELEGATION-2026-10-06.md`.
