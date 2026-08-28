# npm-first onboarding

This is the supported first-run path for `balcony-agent-bridge@0.3.0`. It needs
no source checkout and makes no Azure, RBAC, Windows-service, or network
changes. Run it independently on both Windows nodes.

## 1. Install and preflight

Install the exact public version and create a new disposable pilot root:

```powershell
npm install --global balcony-agent-bridge@0.3.0
New-Item -ItemType Directory -Path C:\BalconyPilot-R2 -ErrorAction Stop | Out-Null
balcony-agent-bridge preflight --root C:\BalconyPilot-R2
```

Preflight checks Node.js, npm, PowerShell 7, Git, Codex, npm's global bin on
`PATH`, the bounded local clock, root writability, and both packaged foreground
entrypoints. It reports safe remediation and never installs dependencies. Fix
every required `FAIL` before continuing. A missing global npm bin may prevent
the command shim itself from resolving; open a new shell after repairing
`PATH`, or invoke `dist/cli/index.js` with the exact Node executable as shown in
the main README.

## 2. Start each node and generate identity

Use the same lowercase network ID on both nodes. Use the other node as the
exact remote peer.

Pilot A:

```powershell
$env:BALCONY_SYSTEM_ID = "pilot-a"
balcony-agent-bridge onboard start `
  --root C:\BalconyPilot-R2 `
  --node-id pilot-a `
  --network-id balcony-pilot `
  --peer-id pilot-b
balcony-agent-bridge onboard export-enrollment `
  --root C:\BalconyPilot-R2 `
  --output C:\BalconyPilot-R2\pilot-a-public.json
```

Pilot B uses `pilot-b` as its local ID and `pilot-a` as `--peer-id`.

On Windows, `onboard start` creates a dedicated identity directory beneath
`%ProgramData%\Balcony\AgentBridge\identities`, protects it with an explicit
ACL, revalidates it with the existing fail-closed identity checker, and then
generates Ed25519 material. The private PKCS8 key is never printed or exported.
Only exchange the `*-public.json` enrollment files. Confirm the displayed
`node_id` and `key_id` with the peer over an independent trusted channel.

Every onboarding command is resumable. An exact rerun validates and reuses
existing state; contradictory or tampered state fails closed.

## Blind clean-VM acceptance matrix

The release is accepted only when both pilots can follow this document without
source access or private repository knowledge. The commands and expected
boundaries are identical; only the local node ID, peer ID, exact public package
version, and fresh root differ.

| Pilot | Verified host baseline | Local / peer | Fresh root | Required result |
| --- | --- | --- | --- | --- |
| A | Node 24.14.0, npm 11.19.1, Codex 0.150.1 | `pilot-a` / `pilot-b` | `C:\BalconyPilot-R2` | Packaged docs resolve; preflight is actionable; identity, enrollment exchange, membership, dispatcher, MCP, and installed foreground validation complete without a source checkout. |
| B | Windows Server 2022 build 20348, Node 24.20.0, npm 11.19.0, Codex 0.150.1 | `pilot-b` / `pilot-a` | `C:\BalconyPilot-R2` | The same path completes and unsafe inherited ACLs fail closed until the protected identity location is used. |

Run each later command on both pilots, substituting only the local/peer IDs
shown above. Each command writes one JSON object to stdout unless noted.

| Step | Expected exit | Required result |
| --- | --- | --- |
| `preflight --root C:\BalconyPilot-R2` | `0` after prerequisites are repaired | `ok: true`; checks include Node, npm, PowerShell, Git, Codex, npm global-bin `PATH`, clock, writable root, and both foreground artifacts. A missing prerequisite exits `1` with `ok: false` and actionable checks. |
| `onboard start ...` | `0` | `ok: true`, `status: "pending"`, exact `node_id`, `network_id`, peer set, manifest path, enrollment path, and public `key_id`; no private key content. |
| `onboard export-enrollment ...` | `0` | `ok: true`, exact local `node_id`/`key_id`, and requested `output_path`; the output contains public enrollment only. |
| `onboard import-peer ...` | `0` | `ok: true`, exact `imported_peer_id`, `membership_ready: true`, and `status: "complete"`. |
| `onboard configure-transport --local-only` | `0` | `ok: true`, `transport.configured: true`, and `transport.local_only: true`; no Azure mutation. |
| `onboard configure-dispatcher ...` | `0` | `ok: true`, `dispatcher.configured: true`, pinned executable hashes, project registry path, and dedicated Codex home. |
| `onboard configure-mcp ...` | `0` | `ok: true` and `mcp.configured: true` in the dedicated Codex home. |
| `runtime bridge ... --validate` | `0` | `ok: true` and `runtime: "bridge"`; no foreground loop is started. |
| `runtime dispatcher ... --validate` | `0` | `ok: true` and `runtime: "dispatcher"`; no foreground loop is started. |
| `onboard verify ...` | `0` | `ok: true`, `status: "complete"`, all three configuration flags `true`, and `azure_owner_action_required: true` for local-only mode. |
| `runtime bridge ...` without `--validate` in local-only mode | `1` | Start is rejected because approved Azure transport metadata is absent. |

PowerShell 7 and Git were absent in the first run on both machines. Preflight
must report those exact blockers with approved installation guidance; it must
not install them. The public-package test must also prove that no private key is
printed or transferred, no Azure/MCP/service mutation occurs before its explicit
step, and the foreground bridge remains validation-only until an infrastructure
owner supplies approved Service Bus topology and access.

## 3. Import the peer and build membership

After receiving and independently confirming the peer's public JSON:

```powershell
balcony-agent-bridge onboard import-peer `
  --root C:\BalconyPilot-R2 `
  --peer-id pilot-b `
  --enrollment C:\path\from-peer\pilot-b-public.json
```

Pilot B imports `pilot-a`. When the exact declared peer set is present, the
command writes deterministic membership schema `1.0`. It rejects the local
node, missing or extra peers, duplicate IDs or key material, malformed or
private keys, key-ID mismatches, symlinks, oversized files, and network-policy
contradictions. This does not change the v0.2 signed wire format.

## 4. Configure local runtime state

For a no-Azure readiness run, explicitly select local-only evaluation:

```powershell
balcony-agent-bridge onboard configure-transport `
  --root C:\BalconyPilot-R2 `
  --local-only
```

This creates the local profile and SQLite database but cannot start message
transport. To run the signed bridge after an infrastructure owner has already
provisioned the namespace, subscription, filter, and RBAC, use a fresh root and
provide the approved non-secret topology instead:

```powershell
balcony-agent-bridge onboard configure-transport `
  --root C:\BalconyPilot-R2 `
  --servicebus-namespace approved-name.servicebus.windows.net `
  --topic agent-messages `
  --subscription pilot-a `
  --auth-mode managed_identity
```

This command validates and records metadata only. It never creates Azure
resources, grants RBAC, installs services, or accepts client secrets,
connection strings, SAS keys, or certificate contents.

Configure the read-only Codex dispatcher for one explicitly readable local
project, then register the local MCP server:

```powershell
balcony-agent-bridge onboard configure-dispatcher `
  --root C:\BalconyPilot-R2 `
  --project-key pilot-project `
  --project-path C:\absolute\path\to\readable-project
balcony-agent-bridge onboard configure-mcp --root C:\BalconyPilot-R2
```

On Windows, the dispatcher command finds the globally installed Codex native
binary and its `codex-code-mode-host.exe` companion, pins both SHA-256 values,
and creates a dedicated ACL-protected Codex home beneath
`%ProgramData%\Balcony\AgentBridge\codex-homes`. MCP registration is written
to that dedicated home with a secret-scrubbed process environment. An exact
existing registration is verified and adopted after an interrupted local-state
write; a contradictory registration fails closed and is never overwritten. If discovery is ambiguous, pass both
`--codex-executable` and `--code-mode-host-executable` explicitly.

## 5. Validate, then run in the foreground

Validation starts neither transport nor dispatch loops:

```powershell
balcony-agent-bridge runtime bridge --root C:\BalconyPilot-R2 --validate
balcony-agent-bridge runtime dispatcher --root C:\BalconyPilot-R2 --validate
balcony-agent-bridge onboard verify --root C:\BalconyPilot-R2
```

After the infrastructure owner has completed Azure provisioning and the
profile contains that approved topology, run each process in a separate
foreground terminal:

```powershell
$env:BALCONY_SYSTEM_ID = "pilot-a"
balcony-agent-bridge runtime bridge --root C:\BalconyPilot-R2
```

```powershell
$env:BALCONY_SYSTEM_ID = "pilot-a"
balcony-agent-bridge runtime dispatcher --root C:\BalconyPilot-R2
```

Stop either process with Ctrl+C. The bridge alone receives Azure metadata,
membership, and the signing-key path. The dispatcher receives the local
profile, pinned Codex binaries, isolated Codex home, and project registry; its
environment is scrubbed of Azure and message-signing variables. MCP receives
only the local profile and process node ID.

## Boundary after onboarding

- Local npm commands: preflight, identity, enrollment, membership, profile,
  SQLite, Codex pinning, MCP registration, and foreground launches.
- Infrastructure-owner action: create/approve Service Bus namespace, topic,
  subscriptions, filters, managed identity or client-certificate setup, and
  RBAC.
- Separate elevated source workflow: install or update Windows services after
  reviewing the source runbook and `-WhatIf` output.

Do not copy the private key, local database, Codex home, or runtime settings to
the peer. See `message-authentication.md`, `configuration.md`,
`runbooks/read-only-dispatcher.md`, and `runbooks/windows-service.md` for the
full security and production boundaries.

## Abandoning a disposable pilot root

Removing the pilot root does not silently delete the protected identity or
dedicated Codex home beneath `%ProgramData%`; retaining them prevents accidental
key loss. Prefer reverting the VM snapshot. Without a snapshot, inspect
`onboarding-manifest.json` and `runtime-settings.json` before moving the pilot
root to the Recycle Bin. Remove the recorded identity and Codex-home directories
only when abandoning that node permanently: resolve each path, require it to be
a direct child of the corresponding
`%ProgramData%\Balcony\AgentBridge\identities` or `codex-homes` directory, print
the exact target, obtain operator confirmation, and use `Remove-Item
-LiteralPath <verified-path> -Recurse`. Never use a wildcard, environment
variable as the deletion target, or delete the parent directory.
