# [SYS-A] Paired pilot source delivery — SYS-B qualification contract

October 14, 2026 (SYS-A local date). This is a **source qualification handoff**,
not production activation authority or a passing paired-runtime verdict.

## One shared baseline

Use `codex/river-paired-runtime-20261007` from the canonical project remote.
SYS-A's post-push diagnostic supplies the exact commit and tree; verify both
before working. Do not follow a moving branch without checking that notice.
Candidate metadata is `0.3.1-pilot.1`, based on reviewed `e1ea77b65f47fb6bc9f1837503a1576b8283d7b6`.

Preserve all operating and dirty checkouts. Under local owner authority, fetch
the named branch into a separate clean detached checkout. Do not pull, reset,
merge or install over the operating release. Read this checkout's `AGENTS.md`,
the paired pilot runbook and current source delivery evidence first.

## Independent local qualification

Confirm process-scoped `BALCONY_SYSTEM_ID=SYS-B` through local operator evidence,
not a drive letter. Use Windows x64 Node **22.14.0** for this phase, and record
the project-local npm and PowerShell versions without changing system defaults.

Run the exact lockfile install and repository checks in order:

```powershell
npm ci
npm run typecheck
npm run build
npm run test:foundation
npm run test:component
npm run test:integration
npm run test:workflow
npm run test:recovery
npm run test:security
npm run smoke:mcp
npm run check:secrets
npm run test:tooling
```

Stop at the first failed tier. Retain the actual command, exit code and bounded
error. Rerun the failed tier after an approved root-cause fix before advancing.
Use disposable state and isolated unauthenticated test homes. No authenticated
model call belongs to this source qualification.

SYS-A's October 14 ordinary `npm ci` fails at the native dependency's implicit
node-gyp build because the host lacks Windows SDK/MSVC prerequisites. The exact
`better-sqlite3@13.0.3` archive includes a working Windows x64 prebuild, but npm's
build path still checks the host toolchain. An explicit `--ignore-scripts`
preparation enabled isolated regression checks; **it is not an ordinary-install
pass or a substitute for this ladder**. Report the same failure if reproduced;
do not silently bypass scripts, change the lockfile, or install system tools.

Refresh production and all-dependency audits separately. Record development
findings rather than conflating them with runtime findings.

## Required response

Reply once on `benchmark80-diagnostics`, preserving the conversation and
causation ID of SYS-A's final delivery notice. A status is not an executable
task result. Include:

1. Observed UTC, system identity and authorized scope.
2. Exact source commit, tree, package version and clean-checkout status.
3. Runtime/tool versions, each check actually run, exit codes and counts.
4. First failed gate and its reproduced cause, if any.
5. Read-only current service ownership, actual entrypoints and database schema.
6. `SOURCE_QUALIFIED`, `SOURCE_QUALIFICATION_FAILED`, or
   `LOCAL_AUTHORITY_REQUIRED`; never infer deployed or 80% maturity.
7. Project-owned evidence path and safe source references.

Do not include keys, authentication files, endpoints, databases, raw logs or
private configuration. Source tests do not prove live worker authentication,
Azure delivery or service lifecycle. Local send acceptance does not prove
receipt; SYS-A will verify the reply in its durable inbox.

## Shared cadence and stop boundary

Both nodes stay on this same source gate. A newer implementation creates a new
reviewed commit; neither node silently substitutes it. Only after both qualify
the selected revision may one approved service artifact be built and the
**same archive** transferred and byte-verified on both hosts.

Then, and only under their separate approvals: disposable unique-ID service
rehearsal, restoration, signing/backlog/grants, coordinated cutover, fresh
bilateral causal tasks, rollback/recovery and 24-hour restricted observation.
No unilateral activation or old runtime opened against schema 9.

Source work uses no authenticated Codex launches. Later live acceptance has
six durable launch reservations per node, twelve total including failures,
subscription-only access and **no incremental paid execution**. Do not change
provider defaults, buy credits, widen resources or copy sign-in between nodes.

The original maturity weights remain unchanged. This handoff does not claim
80%, universal interoperability, community expansion or additional funding.
