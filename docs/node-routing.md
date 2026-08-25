# Node Routing

Balcony Agent Bridge uses a bounded, explicitly configured network of trusted
nodes. It does not discover nodes dynamically and it does not broadcast.

## Node IDs

A node ID is either the legacy compatibility value `SYS-A` or `SYS-B`, or a
lowercase identifier that:

- starts with a letter;
- contains only lowercase letters, digits, and hyphens; and
- is between 1 and 50 characters long.

Examples: `node-a`, `review-node-03`, and `build2`.

Every process declares its local ID with `BALCONY_SYSTEM_ID` and between 1 and
32 authorized remote IDs with the comma-separated
`BALCONY_AUTHORIZED_NODE_IDS` value. Duplicate IDs, the local ID, invalid IDs,
and an empty list fail configuration loading.

## Addressing Rules

`agent_bridge_send` and `agent_bridge_ask_agent` require `target_node_id`. The
target must be in the local authorized-node list before the message is written
to the durable outbox.

Replies do not accept a caller-selected target. They return to the validated
origin of the request being answered. Continuations return to the validated
origin of the preceding result. Result lookup verifies that the result came
from the node targeted by the original request, belongs to the same
conversation, and is addressed to the local node.

The bridge worker applies the boundary again during delivery:

- queued messages whose target is no longer authorized are quarantined before
  transport send;
- messages addressed to another local node are dead-lettered;
- messages claiming an unauthorized origin are dead-lettered before inbox
  persistence; and
- duplicate message IDs are acknowledged without creating a second inbox row.

These checks are fail-closed and preserve the existing at-least-once delivery
contract. In the production Service Bus adapter they follow a separate
Ed25519 authentication gate. The gate verifies the entire envelope, network,
signing-key status and validity, wire lifetime, and broker metadata before the
worker sees a delivery. Azure identity and filters still protect broker access
and routing, but they are not treated as proof of `origin_system`.

Every node's membership policy must list exactly the remote IDs in its local
authorized-node list. The fake transport remains unsigned for local tests;
there is no unsigned production fallback. See `message-authentication.md` for
identity enrollment, membership, coordinated rollout, rotation, and
revocation.

## Durable-State Compatibility

Database schema version 5 rebuilds the inbox and outbox tables without the
legacy two-node `CHECK` constraints. The migration is transactional, copies
every existing column, recreates dispatch and claim indexes, and records its
marker only after the replacement tables are in place. Pending, leased,
available, processed, and duplicate-suppression state is preserved.

## Static Azure Topology

The Bicep templates accept a `nodes` array containing `nodeId`,
`subscriptionName`, and an existing `principalId`. The array is limited to 32
entries. The what-if wrappers preflight unique node IDs, subscription names,
and principal IDs. For each entry the templates create one subscription and
replace the
effective `$Default` rule with an exact `bridgeTarget` correlation filter,
grant topic-level send access, and grant receive access only on that node's
subscription.

For an existing two-node topology, `infra/routing-rules.bicep` also replaces
the legacy named `bridge-target` filter with an always-false rule. This prevents
an incremental migration from leaving the old route active; review that
specific change in `what-if` before deployment.

Provisioning and RBAC changes are never implicit runtime actions. Review a
Bicep `what-if` and obtain owner approval before changing Azure resources.
