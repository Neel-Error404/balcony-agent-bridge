# [SYS-A] Enforced delegation contract — implementation and delivery plan

## Outcome

An authenticated bounded read-only task cannot enqueue a peer request unless
its versioned task contract explicitly permits bounded delegation. The
restriction survives continuation and durable coordinator recovery.

The observed legacy failure was a no-delegation probe that created a nested
request and timed out. Prompt-only enforcement is insufficient.

## Design and compatibility

- New caller coordination protocol is `1.1`.
- A `1.1` request requires `delegation: { mode: "none" }` or
  `delegation: { mode: "bounded", max_depth: 1..4 }`.
- New caller APIs default to `none`. Continuations preserve the original
  request policy; they cannot widen it.
- Receivers retain `1.0` decoding for history, but a legacy request grants no
  new delegation authority. Unknown versions fail closed. Old receivers
  reject `1.1`, not silently reinterpret it.
- Persist the effective delegation policy in the existing consultation JSON;
  missing policy in historical runs defaults to none. No new SQLite table.
- Effective depth is the minimum of local policy, explicit caller limit and
  parent context. Nested requests retain that effective policy. Envelope
  validation rejects inconsistent `1.1` context/policy before persistence.
- A model's peer request under none receives a deterministic rejection code
  `CONSULTATION_DELEGATION_PROHIBITED`; do not parse natural-language text as
  authorization. Check again before enqueue and after recovery.
- The child prompt exposes only permitted result forms. Runtime checks remain
  authoritative even if the model ignores the prompt.
- Result protocol version matches its original request.

## Ownership

Root owns coordination/consultation schemas, envelope constraints, caller/MCP
API, SQL version admission and identity fencing, integration and final proof.
One bounded worker owns coordinator enforcement/child prompt and focused
coordinator/security/recovery tests after schemas are ready. A separate
documentation lane may prepare SYS-B requirements and public-safe history.
Independent review is read-only.

No overlapping writers. Preserve inherited dirty source; record changed path
and content hashes before edits. Do not stage the whole worktree.

## Tests and acceptance

TDD at caller/envelope/coordinator seams:

1. Default caller emits 1.1 none; explicit bounded policy validated; changed
   retry authority conflicts; continuation cannot widen policy.
2. None plus malicious model peer request produces one rejected result and
   zero nested outbox requests.
3. Recovery from a prohibited waiting-peer run cannot enqueue a nested task.
4. Explicit bounded consultations work; child inherits policy/depth.
5. Legacy missing policy does not grant delegation; old decoder rejects 1.1.
6. Local evidence → answer still works under none.
7. Version/cause/result linkage and resource grants remain unchanged.

Run foundation, component, integration, workflow, recovery, security
sequentially; stop at failure, diagnose and rerun that tier. Then tooling,
typecheck/build, MCP smoke, package/history/dependency checks and installed
consumer. Proof is local fixture/consumer until actual two-node acceptance.

## SYS-B requirements and Git/deployment protocol

Convey a diagnostic-stream requirements packet with evidence/plan source
pointers. No auto-reply chain or delegated deployment. SYS-B must inventory
existing-fleet process/service ownership and worker status, preserve its clean
repo, and prepare a separately reviewed compatibility/deployment plan.

Both machines must eventually use one reviewed immutable revision and artifact
with matching 1.1 behavior. Do not send 1.1 tasks to the legacy fleet or mix a
signed/raw fleet.

Prepare a public-safe history/changelog and exact Git change-set manifest.
Current worktree contains earlier uncommitted onboarding/hardening work.
Stage/commit/push only after explicit approval of the reviewed path set;
do not claim history files are commits. Tags/publication are separate.

Before deployment: tests and independent review, clean approved release,
service-capable bundle, actual signed trust, both-node backups/rollback,
quiesced writers and backlog disposition, preview/what-if where applicable.
Then paired deployment, real source-backed answers, no-delegation negative,
restart/replay/permission checks and causal SYS-B acceptance.

## Stop / deferred

Stop at tested local contract and delivered requirements. No service mutation,
credential/RBAC changes, Git publication or signed fleet cutover within this
slice without separately satisfied gates. Reliable unattended wake-up,
service recovery, caller continuation, quotas and host acceptance remain
subsequent milestones; this patch alone is not the 80% end-state.
