# [SYS-A] SYS-B enforced-delegation requirements — 2026-10-06

## Scope and status

**Status: IMPLEMENTED AND LOCALLY TESTED; NOT GIT-DELIVERED OR DEPLOYED.**
This is a public-safe requirements packet,
not a deployment command or a claim that protocol `1.1` exists in a released,
installed, or running fleet. The integrated local ladder passed 546
application tests (one skip), 12 tooling checks and offline installed-consumer
verification. SYS-B still needs a reviewed immutable source revision/artifact;
its receiving/service acceptance has not been performed.

The observed October 6 diagnostic found that a caller's prose prohibition on
nested work did not stop the legacy coordinator from sending a nested request;
the nested request then received no answer and the root request timed out.
See [the response validation evidence](../verification/SYS-A-SYS-B-RESPONSE-VALIDATION-2026-10-06.md)
and [the contract plan](../plans/2026-10-06-enforced-delegation-contract.md).

## Required protocol `1.1` behavior

- Delegation is explicit: `delegation.mode` is either `none` or `bounded`.
  `bounded` requires a positive explicit `max_depth` in the supported range.
- New caller APIs default to `none`; a continuation/replay preserves the
  original effective policy and cannot widen it.
- A legacy request has no peer-delegation authority. Historical consultation
  data missing a policy defaults to `none`.
- The effective nested limit is the most restrictive applicable limit: local
  policy, the explicit caller limit, and inherited parent context. A child
  carries that effective policy/depth unchanged.
- Under `none`, any model/worker request for a peer consultation must produce
  `CONSULTATION_DELEGATION_PROHIBITED` and **zero nested outbox requests**.
  Natural-language instructions are not authorization.
- Local evidence-to-answer execution remains permitted under `none`; only peer
  delegation is denied.
- A legacy `1.0` decoder must reject `1.1` rather than reinterpret it. Unknown
  versions fail closed. Result version remains tied to the originating request.
- Validate `1.1` context/policy consistency before persistence and re-check
  enforcement before enqueue and after durable recovery.

## SYS-B pre-delivery requirements

SYS-B must not probe an old runtime with `1.1`, deploy a partial fleet, or mix
signed and raw traffic. It must instead:

1. Preserve the known clean `9468ab9` baseline and record the current fleet's
   actual service/process/dispatcher ownership without exposing private
   configuration.
2. Prepare a separately approved elevated recovery/deployment plan for one
   worker, existing backlog disposition, restart/replay checks, and rollback.
   Do not perform that plan under this packet.
3. Receive one reviewed immutable `1.1` revision and artifact through approved
   Git delivery. Verify exact revision/artifact identity and compatibility
   before changing services.
4. Keep diagnostics on the ordinary bounded diagnostic stream. An
   acknowledgement/report is status evidence, not a coordination task result;
   it must not create an autonomous acknowledgement loop.

## Bilateral acceptance after approved delivery

Both directions must demonstrate:

1. Default `none` ignores a malicious model peer request: one deterministic
   rejection, no nested outbox entry.
2. Local source/evidence answer completes under `none` without a nested peer.
3. An explicit positive bounded policy works within its limit; restart and
   replay preserve its effective policy and do not widen it.
4. Services maintain one-worker ownership, account for backlog/rollback, and
   never create an unapproved second worker.

Passing root-local tests is necessary but not SYS-B deployment proof. Actual
two-node acceptance, signing trust, service lifecycle, and rollback evidence
remain separate gates.

## Paste-ready owner brief for SYS-B

> Protocol `1.1` is **locally tested but not Git-delivered yet**. Preserve clean `9468ab9`; do not
> send `1.1` to the legacy runtime or mix signed/raw nodes. Inventory current
> service, dispatcher and worker ownership read-only, then prepare (but do not
> execute) a separately approved elevated one-worker recovery/deployment plan
> with backlog, restart/replay and rollback evidence. After an approved Git
> delivery provides one reviewed immutable artifact, verify exact identity and
> run bilateral acceptance: default `none` yields
> `CONSULTATION_DELEGATION_PROHIBITED` with zero nested outbox requests; local
> evidence answers still work; explicitly bounded positive depth preserves its
> limit across restart/replay. Send only bounded diagnostic status reports, not
> task results or autonomous acknowledgement loops.

## Sources and boundary

- [Enforced delegation contract plan](../plans/2026-10-06-enforced-delegation-contract.md)
- [October 6 reverse-timeout diagnostic](../verification/SYS-A-SYS-B-RESPONSE-VALIDATION-2026-10-06.md)
- [Core runtime evidence](../verification/SYS-A-CORE-AUTONOMY-RUNTIME-2026-10-06.md)
- [Current diagnostic-stream handoff](SYS-B-CORE-AUTONOMY-2026-10-06.md)

No services, broker state, credentials, Git state, or runtime configuration
were changed while preparing this handoff.
