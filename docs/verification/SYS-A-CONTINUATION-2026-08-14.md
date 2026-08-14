# [SYS-A] Continuation Verification - 2026-08-14

## Scope

Resume the cross-system bridge work from the completed SYS-A/SYS-B acceptance,
verify the live service, assess the uncommitted read-only dispatcher lane,
implement the provider-independent ask/result coordination surface, and deliver
a bounded continuation packet to SYS-B.

## Accepted Bridge Baseline

- Published revision: `46b17f6ccab6b567e830e350e428543276903aa4`.
- SYS-B previously returned an explicit `accept` for that exact revision.
- SYS-B reported a clean checkout, 54 passing tests, nine MCP tools, managed
  identity, a running healthy service, restart recovery, and offline recovery.
- SYS-A currently reports an automatic running Windows service and a healthy
  bridge runtime status.

## Current Working Tree

The working tree contains an unstaged and uncommitted read-only Codex dispatcher
lane plus a versioned high-level coordination API. Neither is part of the
accepted bridge revision, installed service, or SYS-B checkout.

The dispatcher remains disabled. Its read-only sandbox prevents mutation but
is not a confidentiality boundary. Activation remains blocked until it runs
under an operating-system identity and filesystem ACL boundary that can read
only explicitly approved project trees and cannot read unrelated profiles,
credentials, certificates, or machine configuration.

## Delivery Poll Hardening

The bridge loop previously relied on the Azure SDK's internal wait while
accepting the next Service Bus session. A message queued during that wait was
Azure-acknowledged 29.5 seconds after local enqueue. The source now applies a
five-second cancellable session-accept poll so outbound processing cadence is
application-controlled rather than SDK-controlled.

Three component tests cover poll timeout, parent shutdown propagation, and
timeout cancellation after successful session acceptance.

The repository build contains the fix. The installed service process still has
the prior module loaded because the current non-elevated shell was correctly
denied permission to restart the Windows service. The fix becomes active after
an administrator-approved restart. No service configuration, credential,
identity, RBAC, networking, or Azure resource was changed.

## Final Verification

Run in order on the final source snapshot:

| Level | Result |
|---|---:|
| Foundation | 21 passed |
| Component | 33 passed |
| Integration | 15 passed |
| Workflow | 2 passed |
| Recovery | 7 passed |
| Security | 17 passed |
| Total | 95 passed |

Additional checks:

- TypeScript typecheck: pass.
- Production build: pass.
- Production dependency audit: zero vulnerabilities.
- Compiled MCP smoke: pass, eleven tools.

The new tools are `agent_bridge_ask_agent` and
`agent_bridge_get_result`. Local workflow verification proves an idempotent
request, SYS-A to SYS-B transfer, read-only dispatch, causally linked result,
return transfer, and result retrieval by the original task ID.

## SYS-B Packet

SYS-A durably enqueued and Azure acknowledged task request
`c761c9e8-4335-448b-8161-2d08fb466c3a`. It contains the accepted revision,
current operational state, dispatcher security gate, validation counts, and
the exact actions SYS-B should perform after the owner triggers its agent.

After vault onboarding and final validation, SYS-A also sent status addendum
`391674d6-ccca-44f2-8902-3840a13160b8`. Azure acknowledged the addendum at
`2026-08-14T06:59:20.981Z`. SYS-B should read both messages together.

## Remaining Gates

1. Restart `BalconyAgentBridge` from an elevated PowerShell session so the
   bounded session-accept poll becomes active.
2. Keep the dispatcher disabled until restricted-account and filesystem-read
   isolation are independently reviewed and accepted.
3. Treat the new coordination tools as source-verified but not operationally
   deployed until the installed SYS-A service/MCP and SYS-B checkout use an
   owner-approved exact revision.
4. Do not stage, commit, push, or ask SYS-B to pull the dispatcher or
   coordination lane without separate owner approval and an exact published
   revision.
