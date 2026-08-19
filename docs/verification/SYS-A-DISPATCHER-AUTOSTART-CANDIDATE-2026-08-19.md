# [SYS-A] Dispatcher Autostart Candidate - 2026-08-19

## Scope

Diagnose why SYS-A receives SYS-B bridge messages but does not answer them, and
prepare a true Windows-boot startup path without weakening the transport,
project-read, credential, or release boundaries.

No Windows service, scheduled task, allowlist, inbox state, Azure resource,
Git ref, commit, or remote was changed during this candidate build.

## Live diagnosis

The `BalconyAgentBridge` transport service is running with automatic startup
and one canonical child process. The local bridge heartbeat is healthy, the
outbox has no pending messages, and SYS-B messages are arriving durably.

The missing layer is the read-only Codex dispatcher:

- dispatcher processes: `0`;
- dispatcher Windows services: `0`;
- matching scheduled tasks: `0`;
- available inbox messages: `27` at inspection time;
- claimed inbox messages: `0`.

The server is therefore not off. Transport is operational; automatic request
execution is absent.

## Current requests and backlog boundary

SYS-B request `94d983e0-48fb-43ce-81e1-da11c3943346` is an eligible legacy
read-only nonce probe for `balcony-agent-bridge`. It should be processed by the
initial legacy dispatcher after activation.

SYS-B request `6e6577b5-c528-45fe-ada0-58987e1d163f` targets
`personal-authoring-lab`, which is not in the approved one-project SYS-A
registry. Automatic handling must return a controlled policy rejection rather
than inspect that private project.

Several older unexpired bridge-project requests also remain available. The
candidate adds `BALCONY_DISPATCHER_NOT_BEFORE_UTC`; legacy claims exclude
requests created before the explicit activation cutoff. For the current
acceptance sequence, the reviewed cutoff is `2026-08-19T07:00:00.000Z`. It is
after the obsolete Batch 4 requests and before both fresh SYS-B requests.

## Candidate design

The source candidate adds a separate `BalconyAgentDispatcher` WinSW service.
It does not merge Codex execution into the Azure transport service.

Safety properties:

- manual startup after installation; no automatic activation before live
  acceptance;
- restricted `NT SERVICE\BalconyAgentDispatcher` virtual identity rather than
  `LocalSystem`;
- no Azure variables or credentials in the dispatcher service;
- exact clean release revision required;
- independently verified WinSW, native Codex, and Git SHA-256 pins;
- native Codex copied out of the interactive user profile into the restricted
  service runtime;
- machine-local registry outside Git, schema `1.2`, exactly one initial
  enabled project, exact approved revision, and exact release checkout path;
- forbidden secret-bearing filenames fail installation;
- Codex home, logs, work directory, bridge database, and project reads receive
  distinct least-privilege ACLs;
- explicit legacy or consultation mode, with legacy selected for the initial
  nonce acceptance;
- delayed automatic startup is a separate owner-approved action that requires
  the manually started service and exactly one child process;
- reusable runtime safety verification with an optional automatic-start
  requirement.

## Validation

The candidate passed the complete local ladder in order:

| Level | Result |
|---|---:|
| Foundation | 46 passed |
| Component | 67 passed |
| Integration | 16 passed |
| Workflow | 3 passed |
| Recovery | 8 passed |
| Security | 29 passed |
| Total | 169 passed |

The component total includes the previously unregistered executable-hash
mismatch test and the new activation-cutoff claim test. PowerShell parsing,
TypeScript typecheck, production build, thirteen-tool MCP smoke, production
dependency audit with zero vulnerabilities, and `git diff --check` also pass.

## Deployment gates

1. Review and owner-approve the candidate diff, commit, push, and exact release
   revision. The current candidate is intentionally uncommitted.
2. Create a clean self-contained release checkout; do not deploy from either
   dirty development worktree.
3. Build and verify the exact release, create the one-project machine-local
   registry, and run the dispatcher installer from elevated PowerShell.
4. Authenticate the dedicated ProgramData Codex home directly through the
   supported browser/device flow. Do not copy the interactive Codex home.
5. Start the dispatcher service manually and prove the current nonce result,
   the Personal Authoring Lab policy rejection, repository non-mutation, and
   one canonical transport worker.
6. Enable delayed automatic startup, rerun runtime safety with
   `-RequireAutomatic`, reboot, and prove another SYS-B request/result round
   trip.

Until these gates close, the transport remains operational but SYS-A automatic
execution remains off.
