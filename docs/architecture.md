# Architecture

## Process Boundaries

The MCP server and background bridge service are separate processes that share
one local SQLite database.

The MCP server validates requests and performs short SQLite transactions. It
does not connect to Azure. The bridge service is the only process allowed to
authenticate to Azure Service Bus.

## Delivery Semantics

Delivery is at least once.

1. An MCP send call commits an outbox row before returning.
2. The bridge leases the outbox row, sends it, and marks it sent only after
   Azure acknowledges the send.
3. The receiving bridge persists a valid message before completing the broker
   delivery.
4. Broker redelivery is deduplicated by the local inbox primary key.
5. Consumer side effects must use `message_id` as an idempotency key.

No distributed transaction exists across SQLite, Azure Service Bus, and an
agent's external side effects. The system must never claim exactly-once
execution.

## Azure Topology

The approved target topology is one dedicated Service Bus Standard namespace,
one `agent-messages` topic, and one filtered subscription for each machine.
Messages use stable `MessageId` values and conversation-scoped `SessionId`
values. Each subscription has one explicit `bridge-target` correlation rule
that matches the `bridgeTarget` application property.

SYS-B is an Azure VM and uses its explicitly selected user-assigned managed
identity directly; Azure Arc is not required. SYS-A is a physical host and
uses the separately approved Entra application with a machine-local client
certificate. The bridge never falls back to Azure CLI credentials, shared SAS
keys, client secrets, or a chained default credential.

Operational failures are reduced to stable allowlisted error codes before
they enter SQLite, MCP status, or stderr. Raw SDK exception text, endpoints,
certificate paths, broker identifiers, and message identifiers are not
written to operational logs.

Azure resources are not created until the owner approves a reviewed Bicep
`what-if`.
