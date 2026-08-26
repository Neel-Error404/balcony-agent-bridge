import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const RESTRICT_DIRECTORY_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
$directory = $env:BALCONY_TEST_IDENTITY_DIRECTORY
New-Item -ItemType Directory -Force -Path $directory | Out-Null
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = [Security.AccessControl.DirectorySecurity]::new()
$acl.SetOwner($currentSid)
$acl.SetAccessRuleProtection($true, $false)
$inheritance = (
    [Security.AccessControl.InheritanceFlags]::ObjectInherit -bor
    [Security.AccessControl.InheritanceFlags]::ContainerInherit
)
foreach ($sidValue in @($currentSid.Value, "S-1-5-18", "S-1-5-32-544")) {
    $sid = [Security.Principal.SecurityIdentifier]::new($sidValue)
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
        $sid,
        [Security.AccessControl.FileSystemRights]::FullControl,
        $inheritance,
        [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow
    )
    $acl.AddAccessRule($rule)
}
$directoryInfo = [IO.DirectoryInfo]::new($directory)
$directoryInfo.SetAccessControl($acl)
`;

const ADD_INHERIT_ONLY_READ_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
$directory = $env:BALCONY_TEST_IDENTITY_DIRECTORY
$directoryInfo = [IO.DirectoryInfo]::new($directory)
$acl = $directoryInfo.GetAccessControl(
    [Security.AccessControl.AccessControlSections]::Access
)
$everyone = [Security.Principal.SecurityIdentifier]::new("S-1-1-0")
$rule = [Security.AccessControl.FileSystemAccessRule]::new(
    $everyone,
    [Security.AccessControl.FileSystemRights]::ReadAndExecute,
    [Security.AccessControl.InheritanceFlags]::ObjectInherit,
    [Security.AccessControl.PropagationFlags]::InheritOnly,
    [Security.AccessControl.AccessControlType]::Allow
)
$acl.AddAccessRule($rule)
$directoryInfo.SetAccessControl($acl)
`;

export function prepareSecureIdentityDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    return;
  }
  runWindowsAclScript(RESTRICT_DIRECTORY_SCRIPT, directory);
}

export function addInheritOnlyReadAccess(directory: string): void {
  if (process.platform !== "win32") {
    throw new Error("The Windows ACL fixture is unavailable on this platform");
  }
  runWindowsAclScript(ADD_INHERIT_ONLY_READ_SCRIPT, directory);
}

function runWindowsAclScript(script: string, directory: string): void {
  const systemRoot = process.env["SystemRoot"];
  if (!systemRoot || !path.isAbsolute(systemRoot)) {
    throw new Error("Windows SystemRoot is unavailable for the ACL fixture");
  }
  const powershellPath = path.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const result = spawnSync(
    powershellPath,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      encoding: "utf8",
      env: { ...process.env, BALCONY_TEST_IDENTITY_DIRECTORY: directory },
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `Unable to create the restricted Windows ACL fixture: ${
        result.error?.message ?? result.stderr.trim()
      }`,
    );
  }
}

export function createSecureIdentityDirectory(prefix: string): string {
  const parent =
    process.platform === "win32"
      ? process.env["ProgramData"]
      : os.tmpdir();
  if (!parent || !path.isAbsolute(parent)) {
    throw new Error("A secure identity test parent is unavailable");
  }
  const directory = fs.mkdtempSync(path.join(parent, prefix));
  prepareSecureIdentityDirectory(directory);
  return directory;
}
