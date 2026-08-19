import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const read = (relativePath: string): string =>
  fs
    .readFileSync(path.join(repositoryRoot, relativePath), "utf8")
    .replace(/\r\n/g, "\n");

const installer = read("scripts/Install-DispatcherService.ps1");
const activator = read("scripts/Enable-DispatcherAutomaticStartup.ps1");
const safetyCheck = read("scripts/Test-DispatcherRuntimeSafety.ps1");
const template = read("service/balcony-agent-dispatcher.xml.template");

describe("dispatcher Windows service installation contract", () => {
  it("installs disabled-by-default under a restricted virtual identity", () => {
    expect(template).toContain("<startmode>Manual</startmode>");
    expect(installer).toContain(
      '$serviceAccount = "NT SERVICE\\$serviceName"',
    );
    expect(installer).toContain(
      "Set-Service -Name $serviceName -StartupType Manual",
    );
    expect(installer).not.toContain("LocalSystem");
    expect(installer).not.toContain("Start-Service");
  });

  it("passes an explicit empty password token for the virtual account", () => {
    expect(installer).toContain(
      "'obj=' $serviceAccount 'password=' '\"\"'",
    );
  });

  it("pins the release and executable identities before installation", () => {
    expect(installer).toContain("Repository HEAD does not match ApprovedRevision");
    expect(installer).toContain("The dispatcher release worktree must be clean");
    expect(installer).toContain("Get-FileHash -Algorithm SHA256");
    expect(installer).toContain("[string] $WinSwExecutableSha256");
    expect(installer).toContain("schema_version 1.2");
    expect(installer).toContain("exactly one enabled project");
    expect(installer).toContain(
      "Initial unattended activation is limited to balcony-agent-bridge",
    );
    expect(installer).toContain(
      "The enabled project path must equal the approved release checkout",
    );
    expect(installer).toContain(
      "The machine-local project registry must remain outside Git",
    );
    expect(installer).toContain(
      "The installed Codex executable failed post-copy verification",
    );
  });

  it("keeps Azure credentials out of the dispatcher process", () => {
    expect(template).not.toContain("SERVICEBUS");
    expect(template).not.toContain("AZURE_");
    expect(template).not.toContain("TOKEN");
    expect(template).not.toContain("PASSWORD");
    expect(template).toContain('value="__DISPATCHER_MODE__"');
    expect(installer).toContain('[ValidateSet("legacy", "consultation")]');
    expect(installer).toContain('[string] $DispatcherMode = "legacy"');
    expect(installer).toContain("[datetimeoffset] $NotBeforeUtc");
    expect(template).toContain("BALCONY_DISPATCHER_NOT_BEFORE_UTC");
  });

  it("separates installation from owner-approved automatic activation", () => {
    expect(activator).toContain("[switch] $OwnerApproved");
    expect(activator).toContain("start= delayed-auto");
    expect(activator).toContain("must pass live acceptance and be running first");
    expect(safetyCheck).toContain("AUTOMATIC_STARTUP_NOT_ENABLED");
    expect(safetyCheck).toContain("UNRESTRICTED_SERVICE_IDENTITY");
  });
});
