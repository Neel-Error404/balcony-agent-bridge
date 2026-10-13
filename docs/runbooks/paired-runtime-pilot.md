# [SYS-A] Paired runtime pilot — operator gates

October 7, 2026. These are **gated procedures**, not authority to change live
services, credentials, broker traffic or databases.

## Pilot execution

`BALCONY_DISPATCHER_PILOT_CONFIG_PATH` explicitly selects a machine-local JSON
file. It is accepted only in consultation mode with one enabled registry entry:
`balcony-agent-bridge`, schema 1.2, pinned Git evidence. Keep other project
entries disabled and do not grant their resources in the migrated database.

The `river-pilot.v1` object must supply:

- Shared UUID `run_id`; exact `system_id` (`SYS-A` or `SYS-B`).
- `resource_id: "balcony-agent-bridge"`.
- An explicitly approved Codex `model`, not an inferred provider default.
- An absolute local `ledger_path` outside the source/release directories.
- `billing_mode: "subscription_only"` and canonical UTC
  `billing_verified_until_utc`.
- Fixed limits: `maximum_launches: 6`, `execution_timeout_seconds: 120`,
  `root_timeout_seconds: 300`, `maximum_rounds: 2`, `maximum_depth: 1`,
  `final_answer_characters: 4000`, `maximum_output_bytes: 48000`.

Use the same run ID on both nodes and approve exactly one configuration and
ledger per node. Protect both with the intended service-account/operator ACLs.
Six per immutable ledger is not a tamper-proof physical-node limit: a local
administrator can restore/replace files. Do not create another ledger or
restore an earlier launch count to replenish the twelve-launch allowance.

After explicit local preparation approval:

```powershell
# Use SYS-B on the other machine. Config is a reviewed machine-local file.
$env:BALCONY_SYSTEM_ID = "SYS-A"
& $approvedNode $pilotCli prepare --config $approvedPilotConfig
if ($LASTEXITCODE -ne 0) { throw "Pilot preparation failed; do not reset state." }
& $approvedNode $pilotCli status --config $approvedPilotConfig
if ($LASTEXITCODE -ne 0) { throw "Pilot status failed; verify identity/state." }
```

`$pilotCli` is the approved bundle's `dist/dispatcher/pilot-cli.js`.
Preparation refuses an existing ledger; status is read-only and checks its
identity. Runtime refuses a missing or mismatched ledger. Reservations are
durably consumed before execution; failed and uncertain launches are counted.
Reserved/uncertain state blocks the next owner rather than overlapping it.
There is intentionally no automatic reservation clear or allowance reset.

The dispatcher checks ChatGPT sign-in mode and rejects API-key authentication
before startup and each launch. That does **not** verify subscription allowance,
refresh validity, paid-overflow settings or actual model acceptance. Those
require current owner/provider evidence before authenticated work. No dollar
cap is claimed. If billing is uncertain, stop; never copy sign-in files between
nodes or silently switch to Azure/API credentials.

Absent pilot configuration leaves the existing execution path unchanged.

## Immutable bundle

The bundle tool requires a clean exact revision, Windows x64 Node 22.14.0,
the installed exact lockfile closure and managed Codex 0.150.1. It builds a
service-capable payload including runtime tools, compiled code, production
dependencies, scripts/templates and licenses; it excludes local runtime state.

After reviewed source commit and artifact-build approval:

```powershell
npm run runtime:bundle -- plan --root $cleanCheckout --revision $approvedRevision --node $approvedNode
npm run runtime:bundle -- build --root $cleanCheckout --revision $approvedRevision --node $approvedNode --output $bundleDirectory
npm run runtime:bundle -- archive --bundle $bundleDirectory --output $archivePath --receipt $receiptPath
# Both hosts receive the same archive. Approve its SHA-256 independently.
npm run runtime:bundle -- verify --archive $archivePath --receipt $receiptPath --sha256 $approvedArchiveSha256 --revision $approvedRevision
npm run runtime:bundle -- extract --archive $archivePath --receipt $receiptPath --sha256 $approvedArchiveSha256 --revision $approvedRevision --output $extractedDirectory
```

Do not rebuild separately and claim byte identity. Manifest and receipt hashes
are integrity evidence, not proof of trusted npm supply-chain provenance.
The receipt is outside the archive to avoid self-reference. Do not authorize
an arbitrary receipt merely because it matches its own archive.

## Stage and activation

Both service command surfaces support explicit Validate, Stage, Activate and
Rollback operations. The new dispatcher parameter set is separate from its
legacy updater. Use `-WhatIf` before any approved mutation.

Stage requires a run ID, approved revision and independent manifest SHA-256,
declared install/release roots, and operator-rendered XML bound to the staged
entrypoint. It does not start a service, run Codex, write live XML, migrate a
database or grant a resource. No template should be copied over live XML
without the approved rendering/validation procedure.

Activate requires matching local readiness and the **same service on the
opposite node**, not the other component on this host. Both proofs must bind
the run, source and manifest and be current. Service operations verify account,
SID/startup/recovery metadata and creation-bound tracked descendants. Any
uncertain process, path, hash or ACL stops replacement.

Dispatcher XML must select the bundled Codex executable and companion with
their manifest hashes. After a candidate start attempt, a failed replacement
does not restart old code automatically: it keeps the old XML stopped until
explicit database restoration/compatibility proof is accepted. Successful
configuration restoration is not database restoration.

The service updater is not a database restore engine or complete fleet
orchestrator. The external operator window owns all-writer quiescence,
backup/restoration, schema/backlog disposition, matching trust, exact peer
readiness and coordinated signed/raw traffic. An assertion flag is not itself
independent proof that those operations occurred.

Never activate or roll back one node into incompatible traffic. Never restart
old code over schema 9. Preserve failed evidence and same-node pre-migration
backups; do not move a machine's database or credentials to its peer.

## Remaining acceptance

Disposable module/transport fixtures are not actual WinSW service rehearsal.
The first source slice does not prove real Azure shutdown, active authenticated
descendant termination, source-backed tasks both directions or the 24-hour
observation. Those remain separate approvals and proof gates, using fresh IDs
and no more than twelve counted launches. The maturity score is not promoted
by local test counts.
