# [SYS-A] Return-Path Diagnostic - 2026-08-15

## Scope

Determine why SYS-B reply `229c0f31-6fef-4010-9e11-a132e28c2704`
for Dandaline request `c422d39a-92e5-4798-bf41-ac436493b0c6` did not
become visible in the canonical SYS-A inbox. The investigation was read-only
until a bounded synthetic routing probe and the removal of one stale manual
bridge process. No broker messages were settled, replayed, or deleted
manually. No Git staging, commit, push, RBAC, or Azure resource change was
performed.

## Proven Boundaries

| Boundary | Evidence | Result |
|---|---|---:|
| SYS-A durable request creation | Canonical outbox contains the Dandaline request | PASS |
| SYS-A to Azure send | Outbound attempt completed at `2026-08-14T12:02:52.828Z` | PASS |
| SYS-B receipt and execution | SYS-B returned live Dandaline evidence and a reply ID | PASS |
| SYS-B local result creation | Reply ID and conversation ID were returned by SYS-B | PASS |
| SYS-B to Azure send acknowledgement | SYS-B reported local state `sent` | PASS, broker acceptance only |
| Azure routing configuration | `sys-a` filters `bridgeTarget=SYS-A`; `sys-b` filters `bridgeTarget=SYS-B` | PASS |
| SYS-A canonical receipt of the historical reply | Exact reply absent from inbox and delivery attempts | FAIL |
| Exact historical SYS-B dead-letter reason | SYS-A identity cannot listen to the SYS-B subscription | PENDING SYS-B |

At inspection time, Azure reported zero active and zero dead-letter messages
for `sys-a`, and two dead-letter messages for `sys-b`. This does not prove that
either SYS-B dead-letter is the historical Dandaline reply.

## SYS-A Root Cause Evidence

Two SYS-A bridge workers were running against the live transport:

- the canonical automatic Windows service; and
- a stale foreground `dist/bridge/index.js` process left running since
  2026-08-13.

Before removing the stale foreground worker, synthetic SYS-A-targeted probe
`627901f3-b210-4784-9f5f-ae4f52779d7c` was accepted by Azure but did not appear
in the canonical SQLite inbox. Azure subsequently showed no queued copy.

The stale foreground process was stopped. A second unique probe,
`3801a5a0-e538-460c-bb16-2389abdf06e1`, then followed the same topic and
subscription route and was durably persisted by the canonical service at
`2026-08-14T20:01:20.682Z`.

This proves that a competing stale receiver could remove SYS-A-targeted work
from the canonical service path. It strongly explains the missing return-path
behavior, but it does not by itself prove which process consumed the historical
Dandaline reply.

## Second Live Defect

The installed service process started before the latest build and still runs
the old sequential inbound/outbound loop. A new SYS-B diagnostic task remained
pending until the old session wait returned; it was sent after approximately
34 seconds. The source candidate already separates inbound and outbound lanes,
but an elevated service restart is required before the installed process loads
that build.

The current non-elevated session could neither restart the Windows service nor
terminate its protected child process. That boundary was preserved.

## Prevention Implemented

The source candidate now acquires one machine-wide bridge-worker lock per
system before opening the database or transport. A second live worker fails
closed. A stale lock whose owning PID no longer exists is reclaimed. Graceful
shutdown releases the owned lock.

Validation after this change:

- Foundation: 21 passed.
- Component: 38 passed, including three process-lock cases.
- TypeScript typecheck: passed.
- `git diff --check`: passed.

## SYS-B Diagnostic Task

SYS-A sent read-only diagnostic task
`76fe7506-049d-4386-b0d7-0c7e1694dddb` in conversation
`699535c3-1950-42e5-ba68-d31455946310`. It requests:

1. the exact historical reply envelope and local outbox state;
2. a non-settling peek of both SYS-B dead-letter messages;
3. a SYS-B bridge-process count; and
4. secret-safe runtime routing configuration.

Azure accepted the task at `2026-08-14T20:08:44.397Z`. No automatic result
returned during the first 45 seconds. Immediately afterward the SYS-B
subscription changed from two to three dead-letter messages while active depth
remained zero. The diagnostic request was therefore rejected on the SYS-B
inbound path before it could produce a result. SYS-A's identity has management
read access for counts but correctly lacks Listen permission on the SYS-B
subscription, so the exact dead-letter reason remains a SYS-B-only check.

## Remaining Gates

1. Apply release `2f3f58f6cf8fbb33742ca855dd4ad3fffadc4934` on SYS-B and
   run the runtime safety check with the dispatcher still disabled.
2. Prove that a new coordination request persists in the canonical SYS-B inbox
   instead of entering the dead-letter queue.
3. Run a foreground read-only dispatcher request/result round trip and at least
   two serialized follow-up turns before approving automatic startup.
4. Add a durable remote-receipt state so broker `sent` is never presented as
   end-to-end completion.

## Release Publication

Owner approval `APPROVE_COMMIT_AND_PUSH_BRIDGE_RELEASE_TO_MAIN` was received on
2026-08-15 IST. SYS-A committed the reviewed 101-test candidate as
`2f3f58f6cf8fbb33742ca855dd4ad3fffadc4934` and fast-forwarded both `main` and
`codex/coordination-dispatcher` to that exact revision. GitHub remote refs were
read back and matched the local SHA. The merged `main` tree then passed all 101
tests again, plus typecheck, production build, thirteen-tool MCP smoke, and a
zero-vulnerability production dependency audit.

Publication makes the compatible source installable; it does not itself deploy
SYS-B or activate either dispatcher. Automatic agent execution and multi-turn
discussion remain unaccepted until the SYS-B upgrade and foreground acceptance
sequence above completes.

## Follow-Up Activation

SYS-B subsequently confirmed the mirrored root causes:

- an orphaned manual bridge process, PID `7572`, beside the canonical service;
- installed revision `46b17f6`, which predates the coordination payload added
  in `882cc86`; and
- coordination messages rejected before inbox persistence while ordinary
  bridge messages remain compatible.

The owner instructed SYS-B to stop only the orphaned process. The canonical
service remains unchanged until an exact shared release is approved.

SYS-A rebuilt the candidate and restarted only the canonical Windows service
from an elevated PowerShell. The active service child started at
`2026-08-14T20:42:05Z` and acquired the machine-wide worker lock one second
later. Live verification then proved:

- exactly one bridge worker exists and it is the canonical service child;
- the lock owner PID matches that child;
- a second `dist/bridge/index.js` launch exits with
  `CONFIGURATION_ERROR` and does not create another receiver;
- a unique SYS-A-targeted Azure probe persisted durably; and
- an ordinary SYS-A-to-SYS-B probe reached local `sent` concurrently.

The inbound and outbound checks both completed within 1.6 seconds. Azure then
reported SYS-A at zero active and zero dead-letter messages. SYS-B remained at
three dead letters, proving the ordinary compatibility probe did not add a new
failure.

Reusable post-upgrade verification is now available at
`scripts/Test-BridgeRuntimeSafety.ps1`. It fails closed when the service is not
running, the worker count is not exactly one, the worker lock is missing, or
the lock owner does not match the canonical service child.

The exact working-tree candidate subsequently passed the complete ladder:

| Level | Result |
|---|---:|
| Foundation | 21 passed |
| Component | 38 passed |
| Integration | 15 passed |
| Workflow | 2 passed |
| Recovery | 7 passed |
| Security | 18 passed |
| Total | 101 passed |

TypeScript typecheck, production build, compiled thirteen-tool MCP smoke,
production dependency audit with zero vulnerabilities, runtime safety check,
and `git diff --check` also passed.

## Post-Fix Reverse Acceptance

SYS-B sent a fresh ordinary-message probe after its duplicate-worker diagnosis:

- message: `f049be5a-2f84-4b8f-9656-91ee4bb2c01a`;
- conversation: `aafc5d28-181b-40fa-99b5-3663119feb38`;
- SYS-B broker acknowledgement: `2026-08-14T20:57:08.717Z`; and
- SYS-A canonical persistence: `2026-08-14T20:57:09.895Z`.

SYS-A recorded one inbound attempt with outcome `inserted`, no error, and no
retry. The broker-to-durable-inbox interval was approximately 1.18 seconds.

SYS-A then sent causally linked ordinary acknowledgement
`a91a31f4-09e6-4bf1-b1d6-10b8829ce34f` in the same conversation, sequence 1,
at `2026-08-14T21:02:04.301Z`. SYS-B broker depth returned to zero active while
dead-letter depth remained unchanged at three. Exact durable SYS-B persistence
was then confirmed in its canonical inbox at `2026-08-14T21:02:05.311Z` with
state `available`, sequence 1, the expected causation, inbound outcome
`inserted`, and no error. The acknowledgement's broker-to-inbox interval was
approximately 1.01 seconds.

This closes ordinary two-way transport acceptance:

```text
SYS-B -> Azure -> canonical SYS-A inbox
SYS-A -> Azure -> canonical SYS-B inbox
```

Coordination automation remains a separate gate because SYS-B revision
`46b17f6` does not accept the newer coordination payload schema.
