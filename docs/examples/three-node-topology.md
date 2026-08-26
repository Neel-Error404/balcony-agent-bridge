# Three-Node Topology

This example shows the smallest public-alpha production shape. It uses one
static fully connected trust group; it does not create resources or authorize
real identities.

## Static Inventory

| Node ID | Example role | Subscription | Existing principal |
|---|---|---|---|
| `laptop-a` | physical developer host | `laptop-a` | approved certificate-backed Entra application |
| `laptop-b` | second operator host | `laptop-b` | approved certificate-backed Entra application |
| `build-node` | Azure worker | `build-node` | approved user-assigned managed identity |

The machine-local Azure parameters map each node to its real principal object
ID. Use placeholder UUIDs only in committed examples. Every principal gets
topic sender access and receiver access only to its listed subscription.

## Per-Node Configuration

Each node uses its own database, profile, signing key, and subscription. For a
fully connected three-node group:

| Local node | `BALCONY_AUTHORIZED_NODE_IDS` | Subscription |
|---|---|---|
| `laptop-a` | `laptop-b,build-node` | `laptop-a` |
| `laptop-b` | `laptop-a,build-node` | `laptop-b` |
| `build-node` | `laptop-a,laptop-b` | `build-node` |

Run setup once on each machine with the two remote IDs. Generate one Ed25519
identity per node, exchange only the three public enrollment JSON documents,
and create a local membership file whose `peers` contain exactly the two remote
authorized nodes and never the local node. All three policies use the same
operator-chosen network ID. Private keys and databases never cross machines.

## Routing Example

1. `laptop-a` writes a request explicitly targeted at `build-node` to its local
   outbox.
2. Its bridge signs the immutable wire envelope and sends it to the shared
   topic with `bridgeTarget=build-node`.
3. Only the `build-node` subscription rule matches. The receiving bridge checks
   signature, membership, target, lifetime, and broker metadata before SQLite.
4. A human or the optional read-only dispatcher consumes the request and
   writes a causal result targeted to `laptop-a`.
5. `laptop-a` receives and deduplicates the result, and the caller polls it by
   durable task ID.

`laptop-b` receives neither message because neither target is `laptop-b`.
This is one-to-many membership with explicit one-to-one messages, not
broadcast delivery.

## What This Example Does Not Do

- It does not discover nodes, exchange keys automatically, or issue pairing
  codes.
- It does not deploy Azure, create identities, grant RBAC, or install services.
- It does not prove a live three-machine round trip; the repository's local
  demo proves routing with a fake transport.
- It does not permit writable remote execution or transfer code, files,
  credentials, or project memory.
- It does not isolate mutually untrusted companies or tenants. Every listed
  peer is an explicitly trusted member of one operator-controlled network.
