import { createHash, generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { SystemIdSchema, type SystemId } from "../contracts/envelope.js";

const PRIVATE_KEY_FILE = "node-identity.pkcs8.pem";
const ENROLLMENT_FILE = "node-enrollment.json";
const WINDOWS_ACL_CHECK_TIMEOUT_MS = 10_000;
const WINDOWS_IDENTITY_DIRECTORY_CHECK = String.raw`
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Test-IdentityRuleAppliesToItem {
    param(
        [Parameter(Mandatory)]
        [Security.AccessControl.FileSystemAccessRule] $Rule
    )

    return (($Rule.PropagationFlags -band
        [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0)
}

function Assert-IdentityPathItem {
    param(
        [Parameter(Mandatory)] [string] $Path,
        [Parameter(Mandatory)] [string[]] $TrustedSids,
        [Parameter(Mandatory)]
        [Security.AccessControl.FileSystemRights] $ProhibitedRights,
        [Parameter(Mandatory)] [bool] $IncludeInheritOnly
    )

    $item = [IO.DirectoryInfo]::new($Path)
    if (-not $item.Exists) {
        throw "Identity directory security validation failed."
    }
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Identity directory security validation failed."
    }
    $sections = (
        [Security.AccessControl.AccessControlSections]::Access -bor
        [Security.AccessControl.AccessControlSections]::Owner
    )
    $acl = $item.GetAccessControl($sections)
    $ownerSid = $acl.GetOwner(
        [Security.Principal.SecurityIdentifier]
    ).Value
    if ($TrustedSids -notcontains $ownerSid) {
        throw "Identity directory security validation failed."
    }
    $rules = $acl.GetAccessRules(
        $true,
        $true,
        [Security.Principal.SecurityIdentifier]
    )
    foreach ($rule in $rules) {
        if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) {
            continue
        }
        if (
            -not $IncludeInheritOnly -and
            -not (Test-IdentityRuleAppliesToItem -Rule $rule)
        ) {
            continue
        }
        $sid = $rule.IdentityReference.Value
        if (
            $TrustedSids -notcontains $sid -and
            (($rule.FileSystemRights -band $ProhibitedRights) -ne 0)
        ) {
            throw "Identity directory security validation failed."
        }
    }
}

$identityPath = $env:BALCONY_IDENTITY_DIRECTORY
if ([string]::IsNullOrWhiteSpace($identityPath)) {
    throw "Identity directory security validation failed."
}
$identityItem = [IO.DirectoryInfo]::new($identityPath)
if (-not $identityItem.Exists) {
    throw "Identity directory security validation failed."
}
$trustedSids = @(
    [Security.Principal.WindowsIdentity]::GetCurrent().User.Value,
    "S-1-5-18",
    "S-1-5-32-544",
    "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"
) | Select-Object -Unique
$identityAcl = $identityItem.GetAccessControl(
    [Security.AccessControl.AccessControlSections]::Access
)
if (-not $identityAcl.AreAccessRulesProtected) {
    throw "Identity directory security validation failed."
}

Assert-IdentityPathItem -Path $identityItem.FullName -TrustedSids $trustedSids -ProhibitedRights ([Security.AccessControl.FileSystemRights]::FullControl) -IncludeInheritOnly $true

$ancestorReplacementRights = (
    [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
    [Security.AccessControl.FileSystemRights]::Delete -bor
    [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
    [Security.AccessControl.FileSystemRights]::TakeOwnership
)
$ancestor = $identityItem.Parent
while ($null -ne $ancestor) {
    Assert-IdentityPathItem -Path $ancestor.FullName -TrustedSids $trustedSids -ProhibitedRights $ancestorReplacementRights -IncludeInheritOnly $false
    $ancestor = $ancestor.Parent
}
`;

export interface GenerateNodeIdentityOptions {
  nodeId: SystemId;
  outputDirectory: string;
}

export interface PublicNodeEnrollment {
  node_id: SystemId;
  key_id: string;
  spki_der_base64url: string;
  status: "active";
}

export interface GeneratedNodeIdentity {
  signingKeyPath: string;
  enrollmentPath: string;
  keyId: string;
  enrollment: PublicNodeEnrollment;
}

export type NodeIdentityErrorCode =
  | "IDENTITY_ACL_UNSAFE"
  | "IDENTITY_DIRECTORY_INVALID"
  | "IDENTITY_DIRECTORY_MISSING"
  | "IDENTITY_GENERATION_FAILED"
  | "IDENTITY_OUTPUT_EXISTS"
  | "IDENTITY_PARTIAL_CLEANUP_FAILED"
  | "IDENTITY_POWERSHELL_UNAVAILABLE";

const NODE_IDENTITY_ERROR_MESSAGES: Readonly<Record<NodeIdentityErrorCode, string>> = {
  IDENTITY_ACL_UNSAFE:
    "Identity directory ACL is unsafe; restrict access before generating keys.",
  IDENTITY_DIRECTORY_INVALID:
    "Identity output must be an absolute, non-reparse directory.",
  IDENTITY_DIRECTORY_MISSING:
    "Create and secure the identity output directory before generating keys on Windows.",
  IDENTITY_GENERATION_FAILED: "Identity files could not be generated securely.",
  IDENTITY_OUTPUT_EXISTS:
    "Identity output files already exist; use an empty directory or preserve the existing identity.",
  IDENTITY_PARTIAL_CLEANUP_FAILED:
    "Private-key cleanup failed after partial identity generation; inspect the output directory manually.",
  IDENTITY_POWERSHELL_UNAVAILABLE:
    "Windows PowerShell is unavailable for identity ACL validation.",
};

export class NodeIdentityError extends Error {
  public readonly code: NodeIdentityErrorCode;

  public constructor(code: NodeIdentityErrorCode) {
    super(NODE_IDENTITY_ERROR_MESSAGES[code]);
    this.name = "NodeIdentityError";
    this.code = code;
  }
}

export function generateNodeIdentity(
  options: GenerateNodeIdentityOptions,
): GeneratedNodeIdentity {
  try {
    const nodeId = SystemIdSchema.parse(options.nodeId);
    const outputDirectory = prepareOutputDirectory(options.outputDirectory);
    const signingKeyPath = path.join(outputDirectory, PRIVATE_KEY_FILE);
    const enrollmentPath = path.join(outputDirectory, ENROLLMENT_FILE);
    assertOutputMissing(signingKeyPath);
    assertOutputMissing(enrollmentPath);

    const pair = generateKeyPairSync("ed25519");
    const privateKeyPem = pair.privateKey.export({
      format: "pem",
      type: "pkcs8",
    }) as string;
    const spkiDer = pair.publicKey.export({
      format: "der",
      type: "spki",
    }) as Buffer;
    const keyId = deriveEd25519KeyId(spkiDer);
    const enrollment: PublicNodeEnrollment = {
      node_id: nodeId,
      key_id: keyId,
      spki_der_base64url: spkiDer.toString("base64url"),
      status: "active",
    };

    let createdPrivateKey = false;
    try {
      assertIdentityDirectorySecure(outputDirectory);
      fs.writeFileSync(signingKeyPath, privateKeyPem, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      fs.chmodSync(signingKeyPath, 0o600);
      createdPrivateKey = true;
      fs.writeFileSync(enrollmentPath, `${JSON.stringify(enrollment, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
    } catch (error) {
      if (createdPrivateKey) {
        try {
          fs.rmSync(signingKeyPath, { force: true });
        } catch {
          throw new NodeIdentityError("IDENTITY_PARTIAL_CLEANUP_FAILED");
        }
      }
      throw error;
    }

    return { signingKeyPath, enrollmentPath, keyId, enrollment };
  } catch (error) {
    if (error instanceof NodeIdentityError) {
      throw error;
    }
    throw new NodeIdentityError("IDENTITY_GENERATION_FAILED");
  }
}

export function deriveEd25519KeyId(spkiDer: Buffer): string {
  return `ed25519:${createHash("sha256").update(spkiDer).digest("base64url")}`;
}

function prepareOutputDirectory(outputDirectory: string): string {
  if (!path.isAbsolute(outputDirectory)) {
    throw new NodeIdentityError("IDENTITY_DIRECTORY_INVALID");
  }
  const resolved = path.resolve(outputDirectory);
  const existing = lstatIfPresent(resolved);
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new NodeIdentityError("IDENTITY_DIRECTORY_INVALID");
    }
  } else {
    if (process.platform === "win32") {
      throw new NodeIdentityError("IDENTITY_DIRECTORY_MISSING");
    }
    fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  }
  const created = fs.lstatSync(resolved);
  if (!created.isDirectory() || created.isSymbolicLink()) {
    throw new NodeIdentityError("IDENTITY_DIRECTORY_INVALID");
  }
  return resolved;
}

function assertIdentityDirectorySecure(outputDirectory: string): void {
  if (process.platform !== "win32") {
    return;
  }
  const systemRoot = process.env["SystemRoot"];
  if (!systemRoot || !path.isAbsolute(systemRoot)) {
    throw new NodeIdentityError("IDENTITY_POWERSHELL_UNAVAILABLE");
  }
  const powershellPath = path.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const powershell = lstatIfPresent(powershellPath);
  if (!powershell?.isFile() || powershell.isSymbolicLink()) {
    throw new NodeIdentityError("IDENTITY_POWERSHELL_UNAVAILABLE");
  }
  const encodedCommand = Buffer.from(
    WINDOWS_IDENTITY_DIRECTORY_CHECK,
    "utf16le",
  ).toString("base64");
  const result = spawnSync(
    powershellPath,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        BALCONY_IDENTITY_DIRECTORY: outputDirectory,
      },
      timeout: WINDOWS_ACL_CHECK_TIMEOUT_MS,
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0) {
    throw new NodeIdentityError("IDENTITY_ACL_UNSAFE");
  }
}

function assertOutputMissing(filePath: string): void {
  if (lstatIfPresent(filePath)) {
    throw new NodeIdentityError("IDENTITY_OUTPUT_EXISTS");
  }
}

function lstatIfPresent(filePath: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}
