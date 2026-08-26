import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
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
const dispatcherInstaller = fs.readFileSync(
  path.join(repositoryRoot, "scripts", "Install-DispatcherService.ps1"),
  "utf8",
);
const dispatcherTemplate = fs.readFileSync(
  path.join(
    repositoryRoot,
    "service",
    "balcony-agent-dispatcher.xml.template",
  ),
  "utf8",
);
const securityModule = fs.readFileSync(
  path.join(repositoryRoot, "scripts", "BridgeServiceSecurity.psm1"),
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
    expect(installer).toContain("[string[]] $AuthorizedNodeIds");
    expect(installer).toContain(
      '"__AUTHORIZED_NODE_IDS__" = $authorizedNodeIdsValue',
    );
    expect(serviceTemplate).toContain("BALCONY_AUTHORIZED_NODE_IDS");
  });

  it("requires and projects bridge-only Ed25519 authentication paths without key content handling", () => {
    expect(installer).toContain("[string] $MessageAuthenticationMembershipPath");
    expect(installer).toContain("[string] $MessageAuthenticationSigningKeyPath");
    expect(installer).toContain("[IO.Path]::IsPathRooted($path)");
    expect(installer).toContain("[IO.FileAttributes]::ReparsePoint");
    expect(installer).toContain(
      "Message authentication files must not be reparse points.",
    );
    expect(installer).toContain(
      "Message authentication membership and signing-key paths must be different.",
    );
    expect(installer).toContain(
      '"__MESSAGE_AUTH_MEMBERSHIP_PATH__" = $MessageAuthenticationMembershipPath',
    );
    expect(installer).toContain(
      '"__MESSAGE_AUTH_SIGNING_KEY_PATH__" = $MessageAuthenticationSigningKeyPath',
    );
    expect(installer).not.toContain(
      "Get-Content -LiteralPath $MessageAuthenticationSigningKeyPath",
    );
    expect(installer).not.toContain(
      "Write-Output $MessageAuthenticationSigningKeyPath",
    );

    expect(serviceTemplate).toContain(
      'name="BALCONY_MESSAGE_AUTH_MODE" value="ed25519"',
    );
    expect(serviceTemplate).toContain("BALCONY_MESSAGE_AUTH_MEMBERSHIP_PATH");
    expect(serviceTemplate).toContain("BALCONY_MESSAGE_AUTH_SIGNING_KEY_PATH");
    expect(dispatcherInstaller).not.toContain("BALCONY_MESSAGE_AUTH");
    expect(dispatcherTemplate).not.toContain("BALCONY_MESSAGE_AUTH");
  });

  it("fails closed when credential or bridge-runtime input ACLs are not restricted", () => {
    expect(installer).toContain("function Assert-NoBroadSensitiveCredentialAccess");
    expect(installer).toContain("function Assert-NoUntrustedWriteAccess");
    for (const sid of [
      "S-1-5-18",
      "S-1-5-32-544",
      "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464",
    ]) {
      expect(installer).toContain(sid);
    }
    expect(securityModule).toContain(
      "[Security.Principal.SecurityIdentifier]",
    );
    expect(securityModule).toContain("Get-Acl -LiteralPath $Path");
    expect(securityModule).toContain(
      "ConvertTo-BridgeServiceSid -IdentityReference $acl.Owner",
    );
    expect(securityModule).toContain(
      "$TrustedSids -notcontains $ownerSid",
    );
    expect(securityModule).toContain(
      "Credential ACL validation failed.",
    );
    expect(installer).toContain(
      "Runtime integrity validation failed.",
    );
    expect(installer).toContain(
      "Assert-NoBroadSensitiveCredentialAccess -Path $MessageAuthenticationSigningKeyPath",
    );
    expect(installer).toContain(
      "Assert-TrustedRuntimePath -Path $MessageAuthenticationSigningKeyPath",
    );
    expect(installer).toContain(
      "Assert-TrustedRuntimePath -Path $AzureClientCertificatePath",
    );
    expect(installer).toContain(
      "Assert-NoUntrustedWriteAccess -Path $MessageAuthenticationMembershipPath",
    );
    expect(installer).toContain(
      "Assert-BridgeServiceLocalSystemReadAccess -Path $MessageAuthenticationMembershipPath",
    );
    expect(installer).toContain(
      "Assert-NoUntrustedWriteAccess -Path $RepositoryRoot",
    );
    expect(installer).toContain(
      "Assert-NoUntrustedWriteAccess -Path $NodeExecutable",
    );
    expect(installer).toContain(
      "Assert-NoUntrustedWriteAccess -Path $WinSwExecutable",
    );
  });

  it("allowlists credential access and recursively validates service runtime integrity", () => {
    expect(installer).toContain("$installerSid = (");
    expect(installer).toContain("$trustedCredentialSids = $trustedWriteSids");
    expect(installer).toContain("$installerSid");
    expect(installer).toContain("function Assert-TrustedRuntimePath");
    expect(installer).toContain("function Assert-TrustedRuntimeTree");
    expect(installer).toContain("[IO.FileAttributes]::ReparsePoint");
    expect(installer).toContain("Runtime integrity validation failed.");
    expect(securityModule).toContain("Credential ACL validation failed.");
    expect(installer).toContain("Join-Path $RepositoryRoot \"dist\"");
    expect(installer).toContain("Join-Path $RepositoryRoot \"node_modules\"");
    expect(installer).toContain("Assert-TrustedRuntimeTree -Path $distDirectory");
    expect(installer).toContain("Assert-TrustedRuntimeTree -Path $nodeModulesDirectory");
    expect(installer).toContain("Assert-TrustedRuntimePath -Path $serviceTemplate");
    expect(installer).toContain("Assert-TrustedRuntimePath -Path $NodeExecutable");
    expect(installer).toContain("Assert-TrustedRuntimePath -Path $WinSwExecutable");
    expect(installer).toContain("Assert-TrustedRuntimePath -Path $serviceDirectory");
    expect(installer).toContain("Assert-TrustedRuntimePath -Path $serviceExecutable");
    expect(installer).toContain("Assert-TrustedRuntimePath -Path $serviceConfiguration");
    expect(installer).toContain("Import-Module -Force -Name $bridgeServiceSecurityModule");
    expect(securityModule).toContain("function ConvertTo-BridgeServiceSid");
    expect(securityModule).toContain("function Assert-BridgeServiceCredentialAcl");
    expect(securityModule).toContain(
      "function Assert-BridgeServiceLocalSystemReadAccess",
    );
    expect(securityModule).toContain("function Assert-BridgeServiceRuntimeItem");
    expect(securityModule).toContain("function Assert-BridgeServiceRuntimePath");
    expect(securityModule).toContain(
      "[Security.AccessControl.PropagationFlags]::InheritOnly",
    );
    expect(securityModule).toContain("$ancestorReplacementRights");
    expect(securityModule).toContain(
      "[Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles",
    );
    expect(installer).toContain("-LeafMutationRights $runtimeMutationRights");
    expect(securityModule).toContain("[Security.Principal.NTAccount]::new(");
  });

  it.runIf(process.platform === "win32")(
    "validates effective leaf and ancestor ACL behavior on Windows",
    () => {
      const output = execFileSync(
        "pwsh.exe",
        [
          "-NoProfile",
          "-File",
          path.join(
            repositoryRoot,
            "tests",
            "foundation",
            "bridge-service-security-behavior.ps1",
          ),
        ],
        { cwd: repositoryRoot, encoding: "utf8" },
      );

      expect(output).toContain("ACL_BEHAVIORAL_PROOF_PASS");
    },
  );
});
