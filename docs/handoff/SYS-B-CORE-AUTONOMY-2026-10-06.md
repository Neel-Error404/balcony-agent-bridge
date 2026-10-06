# [SYS-A] SYS-B core autonomy handoff — October 6, 2026

## Meaning of this handoff

Owner-approved sequence: reliable runtime, automatic read-only tasks, enforced
governance. Setup simplification, new adapters and broad operations are later.
This slice is locally tested, not deployed or bilaterally accepted.

A diagnostic message does not start a Codex conversation or give a transport
worker an agent loop. An available, authorized dispatcher/executor must claim
eligible tasks and publish results. Until it is healthy, a human may need to
open SYS-B's agent for read-only preparation. Queued/sent is not completed.

## Preparation requested on SYS-B

Preserve clean source and local secrets. Return a secret-safe report with:

1. Observation timestamp and authoritative system ID.
2. Source revision/dirty status and actual service entrypoint revision.
3. Service state/start mode, wrapper/worker/parent relationship, lock ownership.
   Distinguish a running worker from a healthy supervisor.
4. Dispatcher availability and actual execution status, not merely an auth file.
5. Bounded elevated operator and validated rollback availability. Report missing
   access rather than attempting a workaround.
6. Requirements/checkpoint IDs actually found in the durable inbox and their
   causal relation. Otherwise state `receipt_unverified`.

Do not kill unverified PIDs, delete live locks, copy credentials, upgrade,
change Azure/RBAC, weaken validation or enable signed traffic on one node.
Do not send a 1.1 task to a legacy 1.0 decoder.

## Response contract

Use ordinary `benchmark80-diagnostics` status/acknowledgement traffic,
conversation `8b096084-4cb2-48c1-adb4-5c1ae185256a`. Reference an actually
received message as `causation_id`. Include timestamps and safe evidence;
distinguish `observed`, `untested` and `access_required`.

SYS-A requests:

- Requirements `4313605f-389f-45c8-ac1e-092d20e3a26f`
- Tested checkpoint `4981181d-4660-4567-a6c3-146625762710`

This handoff neither verifies receipt nor authorizes autonomous deployment.
SYS-B's real agent must read it and report its own observations.

## Acceptance after reviewed paired deployment

Run one level at a time; diagnose failures and repeat that level.

- Actual parent interruption: bounded worker exit; no surviving old worker
  when the next owner starts.
- Actual Codex interruption: process tree exits; no post-cancellation success.
  Establish a bounded failure path if the executor does not close.
- Restart/reclaim/replay: reclaim dead-owner state without two live owners,
  duplicate results or loss of uncertain sends.
- Both directions: task → durable receipt → authorized claim → bounded
  execution → source-backed terminal result → causal consumption.
- Governance: default-none makes no nested task; approved bounded delegation
  respects caller/local caps; denial/revocation, expiry, replay and version
  mismatch are enforced.

Acceptance must include release identity, backup/rollback, both nodes'
observations and causal results. Same-host fixtures, credentials or broker
send do not pass this gate.

Source: [SYS-A runtime proof](../verification/SYS-A-CORE-AUTONOMY-RUNTIME-2026-10-06.md).
