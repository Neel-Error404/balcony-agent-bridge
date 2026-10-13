import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const modulePath = path.join(root, "scripts/BridgeRuntimeDeployment.psm1");
const bridgeUpdater = path.join(root, "scripts/Update-BridgeService.ps1");
const dispatcherUpdater = path.join(root, "scripts/Update-DispatcherService.ps1");
const tempRoots: string[] = [];
const revision = "a".repeat(40);
const runId = "11111111-1111-4111-8111-111111111111";

function shell(script: string) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
    cwd: root, encoding: "utf8", env: { ...process.env, BALCONY_SYSTEM_ID: "SYS-A" },
  });
}

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "river-service-"));
  tempRoots.push(dir);
  const release = path.join(dir, "release");
  const install = path.join(dir, "install");
  fs.mkdirSync(install);
  const files = [
    "runtime/node.exe",
    "runtime/codex.exe",
    "runtime/codex-code-mode-host.exe",
    "dist/bridge/index.js",
    "dist/dispatcher/index.js",
    "dist/mcp/index.js",
    "node_modules/@openai/codex/bin/codex.js",
    "package.json",
    "package-lock.json",
    "LICENSE",
    "service/balcony-agent-bridge.xml.template",
    "service/balcony-agent-dispatcher.xml.template",
    "scripts/runtime-bundle.mjs",
  ];
  const entries = files.map((file) => {
    const target = path.join(release, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file);
    return { path: file, length: Buffer.byteLength(file), sha256: createHash("sha256").update(file).digest("hex") };
  });
  const manifest = {
    schema_version: "river-runtime-bundle.v1", source_revision: revision,
    source_tree: "b".repeat(40), platform: "win32", architecture: "x64",
    node_version: "22.14.0", codex_version: "0.150.1",
    database_schema_version: 9, coordination_versions: ["1.0", "1.1"], files: entries,
  };
  fs.writeFileSync(path.join(release, "manifest.json"), JSON.stringify(manifest));
  return { dir, release, install, manifest, entries };
}

function readinessProof(state: Record<string, unknown>, backupPath: string) {
  return {
    ...state,
    verifiedAtUtc: new Date().toISOString(),
    backupPath,
    backupSha256: createHash("sha256").update(fs.readFileSync(backupPath)).digest("hex"),
    operatorReady: true,
    allWritersQuiesced: true,
    restoredCopyVerified: true,
    wirePlanApproved: true,
    databaseSchemaVersion: 9,
    preMigrationSchemaVersion: 8,
  };
}

function invoke(f: ReturnType<typeof fixture>, operation: string, extra = "") {
  const xml = path.join(f.dir, "bridge.xml");
  if (!fs.existsSync(xml)) {
    fs.writeFileSync(xml, `<service><id>BalconyAgentBridge</id><executable>${path.join(f.install, "releases", revision, "runtime/node.exe")}</executable><arguments>${path.join(f.install, "releases", revision, "dist/bridge/index.js")}</arguments><workingdirectory>${path.join(f.install, "releases", revision)}</workingdirectory><env name="BALCONY_SYSTEM_ID" value="SYS-A" /><env name="BALCONY_RUNTIME_SUPERVISION" value="service_parent" /><env name="BALCONY_AUTHORIZED_NODE_IDS" value="SYS-B" /></service>`);
  }
  const approvedManifestSha256 = createHash("sha256")
    .update(fs.readFileSync(path.join(f.release, "manifest.json"))).digest("hex");
  // Disposable temp directories are intentionally not production-ACL qualified.
  const stageAclAdapter = operation === "Stage" && !extra.includes("-ServiceAdapter") && !extra.includes("-WhatIf")
    ? "-ServiceAdapter @{ AssertRuntimePath={ param($path) } }" : "";
  return shell(`
    $ErrorActionPreference='Stop'
    Import-Module -Force '${modulePath.replaceAll("'", "''")}'
    Invoke-BridgeRuntimeDeployment -Operation ${operation} -ServiceId BalconyAgentBridge -NodeId SYS-A -InstallRoot '${f.install.replaceAll("'", "''")}' -ReleaseRoot '${f.release.replaceAll("'", "''")}' -ApprovedRevision '${revision}' -ApprovedManifestSha256 '${approvedManifestSha256}' -DeploymentRunId '${runId}' -DesiredServiceXmlPath '${xml.replaceAll("'", "''")}' ${stageAclAdapter} ${extra} | ConvertTo-Json -Compress -Depth 5
  `);
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("River service deployment public module seam", () => {
  it("requires a shared deployment run ID before staging", () => {
    const f = fixture();
    invoke(f, "Validate");
    const digest = createHash("sha256").update(fs.readFileSync(path.join(f.release, "manifest.json"))).digest("hex");
    const result = shell(`Import-Module -Force '${modulePath}'; Invoke-BridgeRuntimeDeployment -Operation Stage -ServiceId BalconyAgentBridge -NodeId SYS-A -InstallRoot '${f.install}' -ReleaseRoot '${f.release}' -ApprovedRevision '${revision}' -ApprovedManifestSha256 '${digest}' -DesiredServiceXmlPath '${path.join(f.dir, "bridge.xml")}'`);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/DeploymentRunId|run ID/i);
    expect(fs.readdirSync(f.install)).toEqual([]);
  });

  it("refuses a release without an independently approved manifest digest", () => {
    const f = fixture();
    const xml = path.join(f.dir, "bridge.xml");
    invoke(f, "Validate");
    const result = shell(`Import-Module -Force '${modulePath}'; Invoke-BridgeRuntimeDeployment -Operation Stage -ServiceId BalconyAgentBridge -NodeId SYS-A -InstallRoot '${f.install}' -ReleaseRoot '${f.release}' -ApprovedRevision '${revision}' -DeploymentRunId '${runId}' -DesiredServiceXmlPath '${xml}'`);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/ApprovedManifestSha256|manifest/i);
    expect(fs.readdirSync(f.install)).toEqual([]);
  });

  it("rejects a correctly structured but unapproved manifest digest", () => {
    const f = fixture();
    const result = invoke(f, "Stage", `-ApprovedManifestSha256 '${"0".repeat(64)}'`);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/ApprovedManifestSha256/i);
    expect(fs.readdirSync(f.install)).toEqual([]);
  });

  it("rejects a mutated release file before creating install state", () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.release, "dist/bridge/index.js"), "tampered");
    const result = invoke(f, "Stage");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/digest|length/i);
    expect(fs.readdirSync(f.install)).toEqual([]);
  });

  it("validates and stages an immutable release with XML digest but never starts a service", () => {
    const f = fixture();
    const result = invoke(f, "Stage");
    expect(result.status, result.stderr).toBe(0);
    const state = JSON.parse(result.stdout.trim());
    expect(JSON.parse(fs.readFileSync(path.join(f.install, "releases", `${revision}.BalconyAgentBridge.state.json`), "utf8")).status).toBe("staged");
    expect(state.revision).toBe(revision);
    expect(state.serviceId).toBe("BalconyAgentBridge");
    expect(state.xmlSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.existsSync(path.join(f.install, "releases", revision, "runtime/codex.exe"))).toBe(true);
    expect(fs.existsSync(path.join(f.install, "releases", revision, "dist/bridge/index.js"))).toBe(true);
    expect(fs.existsSync(path.join(f.install, "service", "BalconyAgentBridge.xml"))).toBe(false);
  });

  it("removes the staged target if state publication fails", () => {
    const f = fixture();
    const statePath = path.join(f.install, "releases", `${revision}.BalconyAgentBridge.state.json`);
    fs.mkdirSync(statePath, { recursive: true });
    const result = invoke(f, "Stage");
    expect(result.status).not.toBe(0);
    expect(fs.existsSync(path.join(f.install, "releases", revision))).toBe(false);
    expect(fs.statSync(statePath).isDirectory()).toBe(true);
  });

  it("WhatIf performs validation but leaves no staged files", () => {
    const f = fixture();
    const result = invoke(f, "Stage", "-WhatIf");
    expect(result.status, result.stderr).toBe(0);
    expect(fs.readdirSync(f.install)).toEqual([]);
  });

  it("both updater command surfaces delegate paired Stage WhatIf without legacy mutation", () => {
    const f = fixture();
    const bridgeXml = path.join(f.dir, "bridge.xml");
    invoke(f, "Validate"); // writes only the private fixture's rendered XML
    const dispatcherXml = path.join(f.dir, "dispatcher.xml");
    const target = path.join(f.install, "releases", revision);
    const hash = (file: string) => f.entries.find((entry) => entry.path === file)!.sha256;
    fs.writeFileSync(dispatcherXml, `<service><id>BalconyAgentDispatcher</id><executable>${path.join(target, "runtime/node.exe")}</executable><arguments>${path.join(target, "dist/dispatcher/index.js")}</arguments><workingdirectory>${target}</workingdirectory><env name="BALCONY_SYSTEM_ID" value="SYS-A" /><env name="BALCONY_RUNTIME_SUPERVISION" value="service_parent" /><env name="BALCONY_AUTHORIZED_NODE_IDS" value="SYS-B" /><env name="BALCONY_DISPATCHER_PILOT_CONFIG_PATH" value="${path.join(f.dir, "pilot.json")}" /><env name="BALCONY_CODEX_EXECUTABLE" value="${path.join(target, "runtime/codex.exe")}" /><env name="BALCONY_CODEX_EXECUTABLE_SHA256" value="${hash("runtime/codex.exe")}" /><env name="BALCONY_CODEX_CODE_MODE_HOST_EXECUTABLE" value="${path.join(target, "runtime/codex-code-mode-host.exe")}" /><env name="BALCONY_CODEX_CODE_MODE_HOST_SHA256" value="${hash("runtime/codex-code-mode-host.exe")}" /></service>`);
    for (const [updater, id, xml] of [
      [bridgeUpdater, "BalconyAgentBridge", bridgeXml],
      [dispatcherUpdater, "BalconyAgentDispatcher", dispatcherXml],
    ]) {
      const digest = createHash("sha256").update(fs.readFileSync(path.join(f.release, "manifest.json"))).digest("hex");
      const result = shell(`& '${updater}' -Operation Stage -ServiceId ${id} -NodeId SYS-A -InstallRoot '${f.install}' -ReleaseRoot '${f.release}' -ApprovedRevision ${revision} -ApprovedManifestSha256 ${digest} -DeploymentRunId '${runId}' -DesiredServiceXmlPath '${xml}' -WhatIf`);
      expect(result.status, result.stderr).toBe(0);
    }
    fs.writeFileSync(dispatcherXml, fs.readFileSync(dispatcherXml, "utf8")
      .replace(hash("runtime/codex-code-mode-host.exe"), "0".repeat(64)));
    const digest = createHash("sha256").update(fs.readFileSync(path.join(f.release, "manifest.json"))).digest("hex");
    const wrongCompanionHash = shell(`& '${dispatcherUpdater}' -Operation Validate -ServiceId BalconyAgentDispatcher -NodeId SYS-A -InstallRoot '${f.install}' -ReleaseRoot '${f.release}' -ApprovedRevision ${revision} -ApprovedManifestSha256 ${digest} -DeploymentRunId '${runId}' -DesiredServiceXmlPath '${dispatcherXml}'`);
    expect(wrongCompanionHash.status).not.toBe(0);
    expect(wrongCompanionHash.stderr).toMatch(/bundled|companion|hash/i);
    expect(fs.readdirSync(f.install)).toEqual([]);
  }, 15_000);

  it("requires an explicit InstallRoot for paired dispatcher operations before touching a default installation", () => {
    const f = fixture();
    const xml = path.join(f.dir, "dispatcher.xml");
    const digest = createHash("sha256")
      .update(fs.readFileSync(path.join(f.release, "manifest.json"))).digest("hex");
    const result = shell(`& '${dispatcherUpdater}' -Operation Stage -ServiceId BalconyAgentDispatcher -NodeId SYS-A -ReleaseRoot '${f.release}' -ApprovedRevision ${revision} -ApprovedManifestSha256 ${digest} -DeploymentRunId '${runId}' -DesiredServiceXmlPath '${xml}' -WhatIf`);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/InstallRoot/);
    expect(fs.readdirSync(f.install)).toEqual([]);
  });

  it("rejects dispatcher XML that points Codex outside the approved bundled runtime", () => {
    const f = fixture();
    const foreign = path.join(f.dir, "codex.exe");
    fs.copyFileSync(path.join(f.release, "runtime", "codex.exe"), foreign);
    const expected = (file: string) => f.entries.find((entry) => entry.path === file)!.sha256;
    const target = path.join(f.install, "releases", revision);
    const xml = path.join(f.dir, "dispatcher.xml");
    fs.writeFileSync(xml, `<service>
      <id>BalconyAgentDispatcher</id>
      <executable>${path.join(target, "runtime/node.exe")}</executable>
      <arguments>${path.join(target, "dist/dispatcher/index.js")}</arguments>
      <workingdirectory>${target}</workingdirectory>
      <env name="BALCONY_SYSTEM_ID" value="SYS-A" />
      <env name="BALCONY_RUNTIME_SUPERVISION" value="service_parent" />
      <env name="BALCONY_AUTHORIZED_NODE_IDS" value="SYS-B" />
      <env name="BALCONY_CODEX_EXECUTABLE" value="${foreign}" />
      <env name="BALCONY_CODEX_EXECUTABLE_SHA256" value="${expected("runtime/codex.exe")}" />
      <env name="BALCONY_CODEX_CODE_MODE_HOST_EXECUTABLE" value="${path.join(target, "runtime/codex-code-mode-host.exe")}" />
      <env name="BALCONY_CODEX_CODE_MODE_HOST_SHA256" value="${expected("runtime/codex-code-mode-host.exe")}" />
    </service>`);
    const digest = createHash("sha256").update(fs.readFileSync(path.join(f.release, "manifest.json"))).digest("hex");
    const result = shell(`& '${dispatcherUpdater}' -Operation Validate -ServiceId BalconyAgentDispatcher -NodeId SYS-A -InstallRoot '${f.install}' -ReleaseRoot '${f.release}' -ApprovedRevision ${revision} -ApprovedManifestSha256 ${digest} -DeploymentRunId '${runId}' -DesiredServiceXmlPath '${xml}'`);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/bundled|codex|runtime/i);
    expect(fs.readdirSync(f.install)).toEqual([]);
  });

  it("refuses activation without explicit readiness and quiescence proof", () => {
    const f = fixture();
    expect(invoke(f, "Stage").status).toBe(0);
    const result = invoke(f, "Activate");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/readiness|proof/i);
    expect(fs.existsSync(path.join(f.install, "service", "BalconyAgentBridge.xml"))).toBe(false);
  });

  it("rejects an opposite-component same-host state as bilateral stage proof", () => {
    const f = fixture();
    expect(invoke(f, "Stage").status).toBe(0);
    const state = JSON.parse(fs.readFileSync(path.join(f.install, "releases", `${revision}.BalconyAgentBridge.state.json`), "utf8"));
    const backup = path.join(f.dir, "db.backup");
    fs.writeFileSync(backup, "backup");
    const ready = path.join(f.dir, "ready.json");
    fs.writeFileSync(ready, JSON.stringify(readinessProof(state, backup)));
    const peer = path.join(f.dir, "peer.json");
    fs.writeFileSync(peer, JSON.stringify({ ...state, serviceId: "BalconyAgentDispatcher", nodeId: "SYS-A" }));
    const result = invoke(f, "Activate", `-ReadinessProofPath '${ready}' -PeerStageStatePath '${peer}' -WhatIf`);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/peer|paired|stage proof/i);
  });

  it("refuses activation without an independently verified restored copy and wire plan", () => {
    const f = fixture();
    expect(invoke(f, "Stage").status).toBe(0);
    const state = JSON.parse(fs.readFileSync(path.join(f.install, "releases", `${revision}.BalconyAgentBridge.state.json`), "utf8"));
    const backup = path.join(f.dir, "db.backup");
    fs.writeFileSync(backup, "backup");
    const ready = path.join(f.dir, "ready.json");
    fs.writeFileSync(ready, JSON.stringify({
      ...state, backupPath: backup, backupSha256: createHash("sha256").update("backup").digest("hex"),
      operatorReady: true,
    }));
    const peer = path.join(f.dir, "peer.json");
    fs.writeFileSync(peer, JSON.stringify({ ...state, nodeId: "SYS-B" }));
    const result = invoke(f, "Activate", `-ReadinessProofPath '${ready}' -PeerStageStatePath '${peer}' -WhatIf`);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/readiness|restor|wire plan/i);
  });

  it("refuses a reparse-point rollback backup destination before service inspection or mutation", () => {
    const f = fixture();
    expect(invoke(f, "Stage").status).toBe(0);
    const existing = path.join(f.install, "service/BalconyAgentBridge.xml");
    fs.mkdirSync(path.dirname(existing));
    fs.writeFileSync(existing, "original");
    const foreign = path.join(f.dir, "foreign-backups");
    fs.mkdirSync(foreign);
    fs.symlinkSync(foreign, path.join(f.install, "rollback"), "junction");
    const backup = path.join(f.dir, "db.backup");
    fs.writeFileSync(backup, "backup");
    const state = JSON.parse(fs.readFileSync(path.join(f.install, "releases", `${revision}.BalconyAgentBridge.state.json`), "utf8"));
    const peer = path.join(f.dir, "peer.json");
    fs.writeFileSync(peer, JSON.stringify({ ...state, nodeId: "SYS-B" }));
    const ready = path.join(f.dir, "ready.json");
    fs.writeFileSync(ready, JSON.stringify(readinessProof(state, backup)));
    const result = shell(`
      $ErrorActionPreference='Stop'; Import-Module -Force '${modulePath}'
      $global:snapshots=0; $global:stops=0
      $adapter=@{
        AssertRuntimePath={ param($path) }
        GetSnapshot={ param($name) $global:snapshots++; [pscustomobject]@{
          State='Stopped'; ProcessId=0; ChildCount=0; StartName='LocalSystem'
          SidType='UNRESTRICTED'; StartMode='Auto'; Recovery='restart'
        } }
        GetProcessTree={ param($id) @() }
        ProcessIdentityExists={ param($id,$creation) $false }
        Stop={ param($name) $global:stops++ }
        Start={ param($name) throw 'unexpected start' }
        Sleep={ param($ms) }
      }
      try {
        Invoke-BridgeRuntimeDeployment -Operation Activate -ServiceId BalconyAgentBridge -NodeId SYS-A -InstallRoot '${f.install}' -ReleaseRoot '${f.release}' -ApprovedRevision '${revision}' -ApprovedManifestSha256 '${state.manifestSha256}' -DeploymentRunId '${runId}' -DesiredServiceXmlPath '${path.join(f.dir, "bridge.xml")}' -ReadinessProofPath '${ready}' -PeerStageStatePath '${peer}' -ServiceAdapter $adapter | Out-Null
        throw 'unexpected success'
      } catch { [pscustomobject]@{ message=$_.Exception.Message; snapshots=$global:snapshots; stops=$global:stops } | ConvertTo-Json -Compress }
    `);
    expect(result.status, result.stderr).toBe(0);
    const outcome = JSON.parse(result.stdout.trim());
    expect(outcome.message).toMatch(/reparse/i);
    expect(outcome).toMatchObject({ snapshots: 0, stops: 0 });
    expect(fs.readdirSync(foreign)).toEqual([]);
    expect(fs.readFileSync(existing, "utf8")).toBe("original");
  }, 20_000);

  it("refuses a rollback backup destination changed after the first service snapshot", () => {
    const f = fixture();
    expect(invoke(f, "Stage").status).toBe(0);
    const existing = path.join(f.install, "service/BalconyAgentBridge.xml");
    fs.mkdirSync(path.dirname(existing));
    fs.writeFileSync(existing, "original");
    const foreign = path.join(f.dir, "foreign-backups");
    fs.mkdirSync(foreign);
    const backup = path.join(f.dir, "db.backup");
    fs.writeFileSync(backup, "backup");
    const state = JSON.parse(fs.readFileSync(path.join(f.install, "releases", `${revision}.BalconyAgentBridge.state.json`), "utf8"));
    const peer = path.join(f.dir, "peer.json");
    fs.writeFileSync(peer, JSON.stringify({ ...state, nodeId: "SYS-B" }));
    const ready = path.join(f.dir, "ready.json");
    fs.writeFileSync(ready, JSON.stringify(readinessProof(state, backup)));
    const result = shell(`
      $ErrorActionPreference='Stop'; Import-Module -Force '${modulePath}'
      $global:snapshots=0; $global:stops=0
      $adapter=@{
        AssertRuntimePath={ param($path) }
        GetSnapshot={
          param($name)
          $global:snapshots++
          if ($global:snapshots -eq 1) {
            New-Item -ItemType Junction -Path '${path.join(f.install, "rollback")}' -Target '${foreign}' | Out-Null
          }
          [pscustomobject]@{
            State='Stopped'; ProcessId=0; ChildCount=0; StartName='LocalSystem'
            SidType='UNRESTRICTED'; StartMode='Auto'; Recovery='restart'
          }
        }
        GetProcessTree={ param($id) @() }
        ProcessIdentityExists={ param($id,$creation) $false }
        Stop={ param($name) $global:stops++ }
        Start={ param($name) throw 'unexpected start' }
        Sleep={ param($ms) }
      }
      try {
        Invoke-BridgeRuntimeDeployment -Operation Activate -ServiceId BalconyAgentBridge -NodeId SYS-A -InstallRoot '${f.install}' -ReleaseRoot '${f.release}' -ApprovedRevision '${revision}' -ApprovedManifestSha256 '${state.manifestSha256}' -DeploymentRunId '${runId}' -DesiredServiceXmlPath '${path.join(f.dir, "bridge.xml")}' -ReadinessProofPath '${ready}' -PeerStageStatePath '${peer}' -ServiceAdapter $adapter | Out-Null
        throw 'unexpected success'
      } catch { [pscustomobject]@{ message=$_.Exception.Message; snapshots=$global:snapshots; stops=$global:stops } | ConvertTo-Json -Compress }
    `);
    expect(result.status, result.stderr).toBe(0);
    const outcome = JSON.parse(result.stdout.trim());
    expect(outcome.message).toMatch(/reparse/i);
    expect(outcome).toMatchObject({ snapshots: 1, stops: 0 });
    expect(fs.readdirSync(foreign)).toEqual([]);
    expect(fs.readFileSync(existing, "utf8")).toBe("original");
  }, 20_000);

  it("rejects a traversal entry before writing outside the release", () => {
    const f = fixture();
    f.manifest.files[0]!.path = "../outside.exe";
    fs.writeFileSync(path.join(f.release, "manifest.json"), JSON.stringify(f.manifest));
    const result = invoke(f, "Stage");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/unsafe|escapes/i);
    expect(fs.readdirSync(f.install)).toEqual([]);
  });

  it("refuses a release nested under the install root before stage writes", () => {
    const f = fixture();
    f.install = f.dir;
    const result = invoke(f, "Stage");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/overlap|nested/i);
    expect(fs.existsSync(path.join(f.install, "releases"))).toBe(false);
  });

  it("rejects a reparse-point release root before stage writes", () => {
    const f = fixture();
    const link = path.join(f.dir, "release-link");
    fs.symlinkSync(f.release, link, "junction");
    f.release = link;
    const result = invoke(f, "Stage");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/reparse|integrity/i);
    expect(fs.readdirSync(f.install)).toEqual([]);
  });

  it("refuses Stage when the install release destination is a reparse point", () => {
    const f = fixture();
    const foreign = path.join(f.dir, "foreign-release-store");
    fs.mkdirSync(foreign);
    fs.symlinkSync(foreign, path.join(f.install, "releases"), "junction");
    const result = invoke(f, "Stage", "-WhatIf");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/reparse/i);
    expect(fs.readdirSync(foreign)).toEqual([]);
  });

  it("refuses Stage when the existing install destination ACL is not approved", () => {
    const f = fixture();
    const result = invoke(f, "Stage", "-ServiceAdapter @{ AssertRuntimePath={ param($path) throw [UnauthorizedAccessException]::new('ACL denied') } }");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/ACL denied|runtime integrity/i);
    expect(fs.readdirSync(f.install)).toEqual([]);
  });

  it("rejects raw Azure default-credential environment in bridge XML", () => {
    const f = fixture();
    invoke(f, "Validate");
    const xml = path.join(f.dir, "bridge.xml");
    const rendered = fs.readFileSync(xml, "utf8");
    fs.writeFileSync(xml, rendered.replace("</service>", '<env name="AZURE_CLIENT_ID" value="unsafe-default" /></service>'));
    const result = invoke(f, "Stage");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/environment|credential/i);
    expect(fs.readdirSync(f.install)).toEqual([]);
  });

  it("requires service-parent supervision in the rendered service XML", () => {
    const f = fixture();
    invoke(f, "Validate");
    const xml = path.join(f.dir, "bridge.xml");
    fs.writeFileSync(xml, fs.readFileSync(xml, "utf8")
      .replace('<env name="BALCONY_RUNTIME_SUPERVISION" value="service_parent" />', ""));
    const result = invoke(f, "Stage");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/supervision|environment/i);
    expect(fs.readdirSync(f.install)).toEqual([]);
  }, 15_000);

  it("requires peer proofs and verifies the restored old worker during rollback", () => {
    const f = fixture();
    expect(invoke(f, "Stage").status).toBe(0);
    const old = path.join(f.install, "service/BalconyAgentBridge.xml");
    fs.mkdirSync(path.dirname(old));
    const oldNode = path.join(f.dir, "old-runtime/node.exe");
    const oldEntry = path.join(f.dir, "old-runtime/bridge.js");
    const oldXml = `<service><id>BalconyAgentBridge</id><executable>${oldNode}</executable><arguments>${oldEntry}</arguments></service>`;
    fs.writeFileSync(old, oldXml);
    const backup = path.join(f.dir, "db.backup");
    fs.writeFileSync(backup, "private-backup");
    const xmlPath = path.join(f.dir, "bridge.xml");
    const state = JSON.parse(fs.readFileSync(path.join(f.install, "releases", `${revision}.BalconyAgentBridge.state.json`), "utf8"));
    const approvedManifestSha256 = state.manifestSha256;
    const peer = path.join(f.dir, "peer.json");
    fs.writeFileSync(peer, JSON.stringify({ ...state, nodeId: "SYS-B", status: "staged" }));
    const ready = path.join(f.dir, "ready.json");
    fs.writeFileSync(ready, JSON.stringify(readinessProof(state, backup)));
    const restore = path.join(f.dir, "restore-ready.json");
    fs.writeFileSync(restore, JSON.stringify({
      ...state, verifiedAtUtc: new Date().toISOString(),
      allWritersQuiesced: true, restoredCopyVerified: true, restoredPreMigration: true,
      restoredDatabaseSchemaVersion: 8, restoredCopyPath: backup,
      restoredCopySha256: createHash("sha256").update(fs.readFileSync(backup)).digest("hex"),
    }));
    const result = shell(`
      $ErrorActionPreference='Stop'
      Import-Module -Force '${modulePath}'
      $global:running=$true; $global:stops=0; $global:starts=0; $global:aclChecks=0
      $adapter=@{
        AssertRuntimePath={
          param($path)
          if (-not (Test-Path -LiteralPath $path)) { throw 'ACL target must already exist' }
          $global:aclChecks++
        }
        GetSnapshot={
          param($name)
          [pscustomobject]@{
            State=$(if($global:running){'Running'}else{'Stopped'})
            ProcessId=$(if($global:running){10}else{0})
            StartName='LocalSystem'; SidType='UNRESTRICTED'; StartMode='Auto'
            Recovery='restart:10,30'; ChildCount=$(if($global:running){1}else{0})
            ChildProcessId=$(if($global:running){11}else{0})
            ChildCreation=$(if($global:running){'worker-created'}else{''})
            ChildExecutable=$(if(-not $global:running){''}elseif($global:starts -eq 1){'${path.join(f.install, "releases", revision, "runtime/node.exe")}'}else{'${oldNode}'})
            ChildCommandLine=$(if(-not $global:running){''}elseif($global:starts -eq 1){'${path.join(f.install, "releases", revision, "runtime/node.exe")} ${path.join(f.install, "releases", revision, "dist/bridge/index.js")}'}else{'${oldNode} ${oldEntry}'})
          }
        }
        GetProcessTree={ param($root) @([pscustomobject]@{ Id=10; Creation='first'; ParentId=0 },[pscustomobject]@{ Id=11; Creation='second'; ParentId=10 }) }
        ProcessIdentityExists={ param($id,$creation) return ($global:running -and $id -eq 11 -and $creation -eq 'worker-created') }
        Stop={ param($name) $global:stops++; $global:running=$false }
        Start={ param($name) $global:starts++; $global:running=$true }
        Sleep={ param($ms) }
      }
      Invoke-BridgeRuntimeDeployment -Operation Activate -ServiceId BalconyAgentBridge -NodeId SYS-A -InstallRoot '${f.install}' -ReleaseRoot '${f.release}' -ApprovedRevision '${revision}' -ApprovedManifestSha256 '${approvedManifestSha256}' -DeploymentRunId '${runId}' -DesiredServiceXmlPath '${xmlPath}' -ReadinessProofPath '${ready}' -PeerStageStatePath '${peer}' -ServiceAdapter $adapter | ConvertTo-Json -Compress
      try {
        Invoke-BridgeRuntimeDeployment -Operation Rollback -ServiceId BalconyAgentBridge -NodeId SYS-A -InstallRoot '${f.install}' -ReleaseRoot '${f.release}' -ApprovedRevision '${revision}' -ApprovedManifestSha256 '${approvedManifestSha256}' -DeploymentRunId '${runId}' -DesiredServiceXmlPath '${xmlPath}' -ServiceAdapter $adapter | Out-Null
        throw 'unexpected rollback without restored database'
      } catch {
        if ($_.Exception.Message -notmatch 'restor|proof') { throw }
      }
      Invoke-BridgeRuntimeDeployment -Operation Rollback -ServiceId BalconyAgentBridge -NodeId SYS-A -InstallRoot '${f.install}' -ReleaseRoot '${f.release}' -ApprovedRevision '${revision}' -ApprovedManifestSha256 '${approvedManifestSha256}' -DeploymentRunId '${runId}' -DesiredServiceXmlPath '${xmlPath}' -RestoreReadinessProofPath '${restore}' -ServiceAdapter $adapter | ConvertTo-Json -Compress
      [pscustomobject]@{ stops=$global:stops; starts=$global:starts; aclChecks=$global:aclChecks } | ConvertTo-Json -Compress
    `);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('"status":"active"');
    expect(result.stdout).toContain('"status":"rolled-back"');
    expect(result.stdout).toContain('"stops":2,"starts":2');
    expect(result.stdout).toMatch(/"aclChecks":[1-9]/);
    expect(fs.readFileSync(old, "utf8")).toBe(oldXml);
  }, 30_000);

  it.each([
    { name: "wrong entrypoint", entry: "dist/mcp/index.js", identityExists: true },
    { name: "stale worker process identity", entry: "dist/bridge/index.js", identityExists: false },
  ])("refuses a running one-child service with $name", ({ entry, identityExists }) => {
    const f = fixture();
    expect(invoke(f, "Stage").status).toBe(0);
    const existing = path.join(f.install, "service/BalconyAgentBridge.xml");
    fs.mkdirSync(path.dirname(existing));
    fs.writeFileSync(existing, "original-private-xml");
    const backup = path.join(f.dir, "db.backup");
    fs.writeFileSync(backup, "backup");
    const state = JSON.parse(fs.readFileSync(path.join(f.install, "releases", `${revision}.BalconyAgentBridge.state.json`), "utf8"));
    const peer = path.join(f.dir, "peer.json");
    fs.writeFileSync(peer, JSON.stringify({ ...state, nodeId: "SYS-B" }));
    const ready = path.join(f.dir, "ready.json");
    fs.writeFileSync(ready, JSON.stringify(readinessProof(state, backup)));
    const result = shell(`
      $ErrorActionPreference='Stop'; Import-Module -Force '${modulePath}'
      $global:running=$true; $global:startCalls=0
      $adapter=@{
        AssertRuntimePath={ param($path) }
        GetSnapshot={ param($name) [pscustomobject]@{
          State=$(if($global:running){'Running'}else{'Stopped'})
          ProcessId=$(if($global:running){10}else{0})
          StartName='LocalSystem'; SidType='UNRESTRICTED'; StartMode='Auto'
          Recovery='restart'; ChildCount=$(if($global:running){1}else{0})
          ChildProcessId=$(if($global:running){11}else{0})
          ChildCreation='worker-created'
          ChildExecutable='${path.join(f.install, "releases", revision, "runtime/node.exe")}'
          ChildCommandLine='${path.join(f.install, "releases", revision, "runtime/node.exe")} ${path.join(f.install, "releases", revision, entry)}'
        } }
        GetProcessTree={ param($root) @([pscustomobject]@{ Id=10; Creation='first'; ParentId=0 },[pscustomobject]@{ Id=11; Creation='second'; ParentId=10 }) }
        ProcessIdentityExists={ param($id,$creation) return ($global:running -and $id -eq 11 -and ${identityExists ? "$true" : "$false"}) }
        Stop={ param($name) $global:running=$false }
        Start={ param($name) $global:startCalls++; $global:running=$true }
        Sleep={ param($ms) }
      }
      try {
        Invoke-BridgeRuntimeDeployment -Operation Activate -ServiceId BalconyAgentBridge -NodeId SYS-A -InstallRoot '${f.install}' -ReleaseRoot '${f.release}' -ApprovedRevision '${revision}' -ApprovedManifestSha256 '${state.manifestSha256}' -DeploymentRunId '${runId}' -DesiredServiceXmlPath '${path.join(f.dir, "bridge.xml")}' -ReadinessProofPath '${ready}' -PeerStageStatePath '${peer}' -ServiceAdapter $adapter | Out-Null
        throw 'unexpected success'
      } catch { [pscustomobject]@{ message=$_.Exception.Message; starts=$global:startCalls; running=$global:running } | ConvertTo-Json -Compress }
    `);
    expect(result.status, result.stderr).toBe(0);
    const outcome = JSON.parse(result.stdout.trim());
    expect(outcome).toMatchObject({ starts: 1, running: false });
    expect(outcome.message).toMatch(/database restor|restore.*before restart/i);
    expect(fs.readFileSync(existing, "utf8")).toBe("original-private-xml");
  }, 20_000);

  it("refuses a bridge installed under the dispatcher account before stopping it", () => {
    const f = fixture();
    expect(invoke(f, "Stage").status).toBe(0);
    const serviceXml = path.join(f.install, "service", "BalconyAgentBridge.xml");
    fs.mkdirSync(path.dirname(serviceXml));
    fs.writeFileSync(serviceXml, "previous");
    const state = JSON.parse(fs.readFileSync(path.join(f.install, "releases", `${revision}.BalconyAgentBridge.state.json`), "utf8"));
    const backup = path.join(f.dir, "backup");
    fs.writeFileSync(backup, "backup");
    const peer = path.join(f.dir, "peer.json");
    fs.writeFileSync(peer, JSON.stringify({ ...state, nodeId: "SYS-B" }));
    const ready = path.join(f.dir, "ready.json");
    fs.writeFileSync(ready, JSON.stringify(readinessProof(state, backup)));
    const result = shell(`
      $ErrorActionPreference='Stop'; Import-Module -Force '${modulePath}'
      $global:stops=0
      $adapter=@{
        AssertRuntimePath={ param($path) }
        GetSnapshot={ param($name) [pscustomobject]@{
          State='Stopped'; ProcessId=0; ChildCount=0; StartName='NT AUTHORITY\\LocalService'
          SidType='UNRESTRICTED'; StartMode='Auto'; Recovery='restart'
        } }
        GetProcessTree={ param($id) @() }
        ProcessIdentityExists={ param($id,$creation) $false }
        Stop={ param($name) $global:stops++ }
        Start={ param($name) }
        Sleep={ param($ms) }
      }
      try {
        Invoke-BridgeRuntimeDeployment -Operation Activate -ServiceId BalconyAgentBridge -NodeId SYS-A -InstallRoot '${f.install}' -ReleaseRoot '${f.release}' -ApprovedRevision '${revision}' -ApprovedManifestSha256 '${state.manifestSha256}' -DeploymentRunId '${runId}' -DesiredServiceXmlPath '${path.join(f.dir, "bridge.xml")}' -ReadinessProofPath '${ready}' -PeerStageStatePath '${peer}' -ServiceAdapter $adapter | Out-Null
        throw 'unexpected success'
      } catch { [pscustomobject]@{ message=$_.Exception.Message; stops=$global:stops } | ConvertTo-Json -Compress }
    `);
    expect(result.status, result.stderr).toBe(0);
    const outcome = JSON.parse(result.stdout.trim());
    expect(outcome).toMatchObject({ stops: 0 });
    expect(outcome.message).toMatch(/account|identity/i);
    expect(fs.readFileSync(serviceXml, "utf8")).toBe("previous");
  }, 20_000);

  it("leaves the old XML stopped for database restoration after a candidate start attempt fails", () => {
    const f = fixture();
    expect(invoke(f, "Stage").status).toBe(0);
    const existing = path.join(f.install, "service/BalconyAgentBridge.xml");
    fs.mkdirSync(path.dirname(existing));
    fs.writeFileSync(existing, "original-private-xml");
    const backup = path.join(f.dir, "db.backup");
    fs.writeFileSync(backup, "backup");
    const state = JSON.parse(fs.readFileSync(path.join(f.install, "releases", `${revision}.BalconyAgentBridge.state.json`), "utf8"));
    const approvedManifestSha256 = state.manifestSha256;
    const peer = path.join(f.dir, "peer.json");
    fs.writeFileSync(peer, JSON.stringify({ ...state, nodeId: "SYS-B" }));
    const ready = path.join(f.dir, "ready.json");
    fs.writeFileSync(ready, JSON.stringify(readinessProof(state, backup)));
    const result = shell(`
      $ErrorActionPreference='Stop'
      Import-Module -Force '${modulePath}'
      $global:running=$true; $global:startCalls=0
      $adapter=@{
        AssertRuntimePath={ param($path) }
        GetSnapshot={
          param($name)
          [pscustomobject]@{
            State=$(if($global:running){'Running'}else{'Stopped'})
            ProcessId=$(if($global:running){10}else{0})
            StartName='LocalSystem'; SidType='UNRESTRICTED'; StartMode='Auto'
            Recovery='restart:10,30'; ChildCount=$(if($global:running){1}else{0})
          }
        }
        GetProcessTree={ param($root) @([pscustomobject]@{ Id=10; Creation='first'; ParentId=0 },[pscustomobject]@{ Id=11; Creation='second'; ParentId=10 }) }
        ProcessIdentityExists={ param($id,$creation) return $false }
        Stop={ param($name) $global:running=$false }
        Start={
          param($name)
          $global:startCalls++
          $global:running=$true
          if ($global:startCalls -eq 1) { throw [InvalidOperationException]::new('SECRET_MARKER') }
        }
        Sleep={ param($ms) }
      }
      try {
        Invoke-BridgeRuntimeDeployment -Operation Activate -ServiceId BalconyAgentBridge -NodeId SYS-A -InstallRoot '${f.install}' -ReleaseRoot '${f.release}' -ApprovedRevision '${revision}' -ApprovedManifestSha256 '${approvedManifestSha256}' -DeploymentRunId '${runId}' -DesiredServiceXmlPath '${path.join(f.dir, "bridge.xml")}' -ReadinessProofPath '${ready}' -PeerStageStatePath '${peer}' -ServiceAdapter $adapter | Out-Null
        throw 'unexpected success'
      } catch {
        [pscustomobject]@{ message=$_.Exception.Message; starts=$global:startCalls; running=$global:running } | ConvertTo-Json -Compress
      }
    `);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toMatchObject({ starts: 1, running: false });
    expect(JSON.parse(result.stdout.trim()).message).toMatch(/database restor|restore.*before restart/i);
    expect(result.stdout).not.toContain("SECRET_MARKER");
    expect(fs.readFileSync(existing, "utf8")).toBe("original-private-xml");
    expect(state.status).toBe("staged");
  });

  it("leaves the old XML stopped for database restoration when activation fails before candidate start", () => {
    const f = fixture();
    expect(invoke(f, "Stage").status).toBe(0);
    const existing = path.join(f.install, "service/BalconyAgentBridge.xml");
    fs.mkdirSync(path.dirname(existing));
    fs.writeFileSync(existing, "original-private-xml");
    const backup = path.join(f.dir, "db.backup");
    fs.writeFileSync(backup, "backup");
    const state = JSON.parse(fs.readFileSync(path.join(f.install, "releases", `${revision}.BalconyAgentBridge.state.json`), "utf8"));
    const peer = path.join(f.dir, "peer.json");
    fs.writeFileSync(peer, JSON.stringify({ ...state, nodeId: "SYS-B" }));
    const ready = path.join(f.dir, "ready.json");
    fs.writeFileSync(ready, JSON.stringify(readinessProof(state, backup)));
    const desiredXml = path.join(f.dir, "bridge.xml");
    const result = shell(`
      $ErrorActionPreference='Stop'; Import-Module -Force '${modulePath}'
      $global:running=$true; $global:startCalls=0
      $adapter=@{
        AssertRuntimePath={ param($path) }
        GetSnapshot={ param($name) [pscustomobject]@{
          State=$(if($global:running){'Running'}else{'Stopped'})
          ProcessId=$(if($global:running){10}else{0})
          StartName='LocalSystem'; SidType='UNRESTRICTED'; StartMode='Auto'
          Recovery='restart:10,30'; ChildCount=$(if($global:running){1}else{0})
        } }
        GetProcessTree={ param($root) @([pscustomobject]@{ Id=10; Creation='first'; ParentId=0 },[pscustomobject]@{ Id=11; Creation='second'; ParentId=10 }) }
        ProcessIdentityExists={ param($id,$creation) $false }
        Stop={ param($name) $global:running=$false; Remove-Item -LiteralPath '${desiredXml}' -ErrorAction SilentlyContinue }
        Start={ param($name) $global:startCalls++; $global:running=$true }
        Sleep={ param($ms) }
      }
      try {
        Invoke-BridgeRuntimeDeployment -Operation Activate -ServiceId BalconyAgentBridge -NodeId SYS-A -InstallRoot '${f.install}' -ReleaseRoot '${f.release}' -ApprovedRevision '${revision}' -ApprovedManifestSha256 '${state.manifestSha256}' -DeploymentRunId '${runId}' -DesiredServiceXmlPath '${desiredXml}' -ReadinessProofPath '${ready}' -PeerStageStatePath '${peer}' -ServiceAdapter $adapter | Out-Null
        throw 'unexpected success'
      } catch {
        [pscustomobject]@{ message=$_.Exception.Message; starts=$global:startCalls; running=$global:running } | ConvertTo-Json -Compress
      }
    `);
    expect(result.status, result.stderr).toBe(0);
    const outcome = JSON.parse(result.stdout.trim());
    expect(outcome).toMatchObject({ starts: 0, running: false });
    expect(outcome.message).toMatch(/database restor|restore.*before restart/i);
    expect(fs.readFileSync(existing, "utf8")).toBe("original-private-xml");
    expect(JSON.parse(fs.readFileSync(path.join(f.install, "releases", `${revision}.BalconyAgentBridge.state.json`), "utf8")).status).toBe("staged");
  }, 20_000);

  it("fails closed if a tracked descendant remains live", () => {
    const f = fixture();
    expect(invoke(f, "Stage").status).toBe(0);
    const existing = path.join(f.install, "service/BalconyAgentBridge.xml");
    fs.mkdirSync(path.dirname(existing));
    fs.writeFileSync(existing, "original");
    const backup = path.join(f.dir, "db.backup");
    fs.writeFileSync(backup, "backup");
    const state = JSON.parse(fs.readFileSync(path.join(f.install, "releases", `${revision}.BalconyAgentBridge.state.json`), "utf8"));
    const approvedManifestSha256 = state.manifestSha256;
    const peer = path.join(f.dir, "peer.json");
    fs.writeFileSync(peer, JSON.stringify({ ...state, nodeId: "SYS-B" }));
    const ready = path.join(f.dir, "ready.json");
    fs.writeFileSync(ready, JSON.stringify(readinessProof(state, backup)));
    const result = shell(`
      $ErrorActionPreference='Stop'; Import-Module -Force '${modulePath}'
      $global:running=$true; $global:startCalls=0
      $adapter=@{
        AssertRuntimePath={ param($path) }
        GetSnapshot={
          param($name)
          [pscustomobject]@{
            State=$(if($global:running){'Running'}else{'Stopped'})
            ProcessId=$(if($global:running){10}else{0})
            StartName='LocalSystem'; SidType='UNRESTRICTED'; StartMode='Auto'
            Recovery='restart:10,30'; ChildCount=$(if($global:running){1}else{0})
          }
        }
        GetProcessTree={ param($root) @([pscustomobject]@{ Id=10; Creation='first'; ParentId=0 },[pscustomobject]@{ Id=11; Creation='second'; ParentId=10 }) }
        ProcessIdentityExists={ param($id,$creation) return ($id -eq 11) }
        Stop={ param($name) $global:running=$false }
        Start={ param($name) $global:startCalls++; $global:running=$true }
        Sleep={ param($ms) }
      }
      try {
        Invoke-BridgeRuntimeDeployment -Operation Activate -ServiceId BalconyAgentBridge -NodeId SYS-A -InstallRoot '${f.install}' -ReleaseRoot '${f.release}' -ApprovedRevision '${revision}' -ApprovedManifestSha256 '${approvedManifestSha256}' -DeploymentRunId '${runId}' -DesiredServiceXmlPath '${path.join(f.dir, "bridge.xml")}' -ReadinessProofPath '${ready}' -PeerStageStatePath '${peer}' -ServiceAdapter $adapter -StopTimeoutSeconds 1 | Out-Null
        throw 'unexpected success'
      } catch {
        [pscustomobject]@{ message=$_.Exception.Message; starts=$global:startCalls } | ConvertTo-Json -Compress
      }
    `);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toMatchObject({ starts: 0 });
    expect(fs.readFileSync(existing, "utf8")).toBe("original");
  });
});
