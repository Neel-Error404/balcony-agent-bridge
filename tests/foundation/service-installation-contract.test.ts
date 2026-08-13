import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const installer = fs.readFileSync(
  path.join(repositoryRoot, "scripts", "Install-BridgeService.ps1"),
  "utf8",
).replace(/\r\n/g, "\n");
const serviceTemplate = fs.readFileSync(
  path.join(
    repositoryRoot,
    "service",
    "balcony-agent-bridge.xml.template",
  ),
  "utf8",
);

describe("Windows service installation contract", () => {
  it("supports explicit managed-identity and certificate modes", () => {
    expect(installer).toContain(
      'ParameterSetName = "ManagedIdentity"',
    );
    expect(installer).toContain(
      'ParameterSetName = "ClientCertificate"',
    );
    expect(installer).toContain("[guid] $ManagedIdentityClientId");
    expect(installer).toContain("[guid] $AzureTenantId");
    expect(installer).toContain("[guid] $AzureClientId");
    expect(installer).toContain("$AzureClientCertificatePath");
    expect(installer).toContain(
      '"__AUTH_ENVIRONMENT__",\n        $authEnvironment',
    );
    expect(installer).not.toContain(
      '"__AUTH_ENVIRONMENT__" = $authEnvironment',
    );
    expect(serviceTemplate).toContain(
      "__AUTH_ENVIRONMENT__",
    );
    expect(installer).toContain(
      "[Security.AccessControl.FileSystemRights]::Modify",
    );
    expect(installer).toContain(
      "Set-Acl -LiteralPath $dataDirectory",
    );
  });

  it("binds installation to the declared machine and Azure hostname", () => {
    expect(installer).toContain(
      "$env:BALCONY_SYSTEM_ID -ne $SystemId",
    );
    expect(installer).toContain(
      "servicebus\\.windows\\.net",
    );
  });
});
