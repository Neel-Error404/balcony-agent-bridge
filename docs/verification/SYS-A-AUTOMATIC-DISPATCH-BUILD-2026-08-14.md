# [SYS-A] Automatic Dispatch And Multi-Turn Build - 2026-08-14

## Objective

Build the shared source required for unattended SYS-A to SYS-B and SYS-B to
SYS-A read-only execution, then add bounded serialized follow-up turns without
making the transport, executor, or project-memory provider inseparable.

## SYS-B Coordination

SYS-A sent owner-approved build task
`b5efa380-d8eb-41ae-b3fc-5845ff9be3de` in conversation
`49ca4da0-8c52-4419-b7b1-ceb00a7b202e`. SYS-B owns its machine-local Dandaline
allowlist review, dedicated dispatcher Codex home, restricted identity and ACL
recommendation, and foreground acceptance. SYS-A owns the shared runtime and
conversation source changes so the machines do not independently fork the
protocol.

The task authorizes source implementation and testing. It does not authorize
Git publication, Azure or RBAC changes, ACL changes, scheduled tasks, service
installation, or automatic startup.

## Receiver Root Cause And Repair

The prior five-second abort wrapper did not bound the installed Azure SDK call.
A live probe proved both `acceptNextSession` and the receive client's `close()`
could remain unresolved beyond an independent outer deadline.

The root problem was treating Service Bus session acceptance as a short poll in
the same sequential loop as outbound work. `acceptNextSession` is a long poll.
The candidate now runs independent inbound and outbound lanes and uses separate
Service Bus clients for the sender and session receiver. An idle inbound accept
therefore cannot starve queued outbound sends or heartbeat refresh. Shutdown
has its own bounded close path and forces process termination if the SDK close
does not settle.

## Multi-Turn Contract

The MCP surface now contains thirteen tools. In addition to ask/result:

- `agent_bridge_continue_agent` creates the next turn only from the latest
  completed peer result;
- `agent_bridge_get_thread` returns a bounded ordered local discussion view.

The serialized chain is request sequence 0, result sequence 1, follow-up
sequence 2, and result sequence 3. Each result is caused by its request; each
follow-up is caused by the preceding result. The project and conversation are
derived from durable local state rather than caller input. Duplicate
continuations reuse the same turn; stale parallel or cross-project
continuations fail closed.

The dispatcher supplies at most eight prior coordination messages and 8,000
characters to the read-only worker. Prior text is explicitly treated as
discussion data, not trusted instructions or current project truth. The worker
must re-inspect allowed local evidence for current-state claims.

## Verification

| Level | Result |
|---|---:|
| Foundation | 21 passed |
| Component | 35 passed |
| Integration | 15 passed |
| Workflow | 2 passed |
| Recovery | 7 passed |
| Security | 18 passed |
| Total | 98 passed |

Additional checks:

- TypeScript typecheck: pass.
- Production build: pass.
- Production dependency audit: zero vulnerabilities.
- Compiled MCP smoke: pass, thirteen tools.
- Local fake-transport workflow: automatic request/result plus one follow-up
  request/result, ordered `0 -> 1 -> 2 -> 3`, pass.
- Live Azure deployment of this candidate: not performed.
- Automatic dispatcher service installation: not performed.
- Unattended two-machine Dandaline and approved-safe-view acceptance: pending.

## Remaining Operational Gates

1. Review the exact working-tree diff and obtain separate approval to commit
   and push an exact source revision.
2. Have SYS-B verify that revision and return secret-safe acceptance evidence.
3. Select a restricted Windows service identity and Codex authentication home
   on each machine; apply reviewed project-read and runtime-write ACLs.
4. Create an approved evidence-only context surface for private projects such
   as Personal Authoring Lab. Do not register the private whole repository.
5. Install and enable the dispatcher under the selected identities.
6. Prove one unattended Dandaline round trip, one reverse approved-safe-view
   round trip, two follow-up turns in each direction, duplicate handling, and
   restart recovery.

Until those gates pass, the honest state is **source verified, not operationally
deployed**.
