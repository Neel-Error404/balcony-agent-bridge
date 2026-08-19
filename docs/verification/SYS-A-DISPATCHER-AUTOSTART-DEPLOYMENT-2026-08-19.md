# [SYS-A] Dispatcher Autostart Deployment - 2026-08-19

## Outcome

SYS-A now runs the transport and read-only Codex dispatcher as separate
automatic Windows services. `BalconyAgentDispatcher` uses delayed automatic
startup, the low-privilege `LocalService` logon, and its unrestricted unique
service SID for resource ACL isolation.

The dispatcher is deployed from the clean detached release checkout
`D:/Work_Projects/balcony-agent-bridge-release-4721251` at exact revision
`4721251cec833faf0e3e9ea36dc13e16bb6445b6`. The machine-local schema 1.2
registry enables only `balcony-agent-bridge`, pins that same revision, and
remains outside Git.

## Root cause and release correction

SYS-A's Azure transport service was already operational and receiving SYS-B
messages. The missing execution layer was a persistent dispatcher process.
The first successful service-mode request/result proof then exposed one
bounded defect: the sandboxed Codex child correctly lacked ambient machine
variables and returned `system_id=UNKNOWN`.

Revision `4721251` supplies the already validated dispatcher `systemId` in the
read-only prompt. It does not pass ambient environment variables into the
child or weaken the sandbox. A component regression asserts the exact
receiving identity.

## Verification

The source worktree and clean release checkout each passed:

| Level | Result |
|---|---:|
| Foundation | 47 passed |
| Component | 67 passed |
| Integration | 16 passed |
| Workflow | 3 passed |
| Recovery | 8 passed |
| Security | 29 passed |
| Total | 170 passed |

TypeScript typecheck and production build also passed. The clean release
worktree remained unmodified and `origin/main`, the release branch, and the
reviewed source commit were read back at the exact revision before deployment.

## Runtime proof

The first real SYS-B request was
`94d983e0-48fb-43ce-81e1-da11c3943346`. The service automatically claimed it
and produced causally linked result
`02d59ae0-30c7-48bd-9155-67e3047b74e7` with the requested nonce and
`automatic=yes`; its `system_id=UNKNOWN` field triggered the release
correction above. The non-allowlisted Personal Authoring Lab request was
automatically rejected without project inspection, as designed.

After installing `4721251`, runtime safety passed in Manual acceptance mode:

- service state `Running`;
- account `NT AUTHORITY\LocalService`;
- unrestricted unique service SID;
- exactly one service-owned Node child;
- dedicated ProgramData Codex home authenticated with ChatGPT;
- no Azure variables in dispatcher service configuration;
- healthy dispatcher heartbeat and no pending outbox work.

The owner-approved activation then set delayed automatic startup. A controlled
service stop/start completed and the automatic-mode safety check passed with
`StartMode=Auto`, registry `DelayedAutoStart=1`, the same restricted identity,
and exactly one replacement Node child. The canonical `BalconyAgentBridge`
service simultaneously remained running in automatic mode with exactly one
service-owned child.

## Remaining external confirmation

SYS-A broker-sent probe notice
`41d3791c-5c7a-480c-8d3f-b999fa90c287` and consultation task
`7ca66ddc-fb7c-4fe6-92b6-02b5a70a8a75` to request a fresh SYS-B-originated
identity nonce. Both reached local delivery state `sent`, but SYS-B had not
returned the fresh request at the time this deployment record was written.
This is a pending cross-machine confirmation, not a SYS-A service-start
blocker.

A full operating-system reboot was not performed. Windows delayed-start
configuration and service restart recovery are proven; the next maintenance
window should add a reboot-originated request/result proof without changing
the allowlist or replaying historical inbox work.
