import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { z } from "zod";

export const MANAGED_CODEX_VERSION = "0.150.1";

export interface ManagedCodexToolchain {
  version: string;
  codexExecutable: string;
  codeModeHostExecutable: string;
}

export interface ManagedCodexToolchainOptions {
  packageRoot: string;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
}

const CodexPackageSchema = z.object({
  name: z.literal("@openai/codex"),
  version: z.literal(MANAGED_CODEX_VERSION),
}).passthrough();

const BridgePackageSchema = z.object({
  name: z.literal("balcony-agent-bridge"),
  dependencies: z.object({
    "@openai/codex": z.literal(MANAGED_CODEX_VERSION),
  }).passthrough(),
}).passthrough();

const targetByPlatform = {
  "win32:x64": {
    packageName: "@openai/codex-win32-x64",
    packageVersion: `${MANAGED_CODEX_VERSION}-win32-x64`,
    vendorTarget: "x86_64-pc-windows-msvc",
    suffix: ".exe",
  },
  "win32:arm64": {
    packageName: "@openai/codex-win32-arm64",
    packageVersion: `${MANAGED_CODEX_VERSION}-win32-arm64`,
    vendorTarget: "aarch64-pc-windows-msvc",
    suffix: ".exe",
  },
  "linux:x64": {
    packageName: "@openai/codex-linux-x64",
    packageVersion: `${MANAGED_CODEX_VERSION}-linux-x64`,
    vendorTarget: "x86_64-unknown-linux-musl",
    suffix: "",
  },
  "linux:arm64": {
    packageName: "@openai/codex-linux-arm64",
    packageVersion: `${MANAGED_CODEX_VERSION}-linux-arm64`,
    vendorTarget: "aarch64-unknown-linux-musl",
    suffix: "",
  },
  "darwin:x64": {
    packageName: "@openai/codex-darwin-x64",
    packageVersion: `${MANAGED_CODEX_VERSION}-darwin-x64`,
    vendorTarget: "x86_64-apple-darwin",
    suffix: "",
  },
  "darwin:arm64": {
    packageName: "@openai/codex-darwin-arm64",
    packageVersion: `${MANAGED_CODEX_VERSION}-darwin-arm64`,
    vendorTarget: "aarch64-apple-darwin",
    suffix: "",
  },
} as const;

export class ManagedCodexToolchainError extends Error {
  public constructor(
    public readonly code:
      | "MANAGED_CODEX_UNSUPPORTED"
      | "MANAGED_CODEX_PACKAGE_INVALID"
      | "MANAGED_CODEX_NATIVE_PACKAGE_MISSING"
      | "MANAGED_CODEX_BINARY_MISSING",
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "ManagedCodexToolchainError";
  }
}

export function resolveManagedCodexToolchain(
  options: ManagedCodexToolchainOptions,
): ManagedCodexToolchain {
  const packageRoot = path.resolve(options.packageRoot);
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const target = targetByPlatform[`${platform}:${arch}` as keyof typeof targetByPlatform];
  if (!target) {
    throw new ManagedCodexToolchainError("MANAGED_CODEX_UNSUPPORTED");
  }

  const bridgePackageJson = path.join(packageRoot, "package.json");
  let codexPackageJson: string;
  let parsedPackage: z.infer<typeof CodexPackageSchema>;
  try {
    BridgePackageSchema.parse(
      JSON.parse(fs.readFileSync(bridgePackageJson, "utf8")),
    );
    codexPackageJson = createRequire(bridgePackageJson).resolve(
      "@openai/codex/package.json",
    );
    parsedPackage = CodexPackageSchema.parse(
      JSON.parse(fs.readFileSync(codexPackageJson, "utf8")),
    );
  } catch (error) {
    throw new ManagedCodexToolchainError(
      "MANAGED_CODEX_PACKAGE_INVALID",
      { cause: error },
    );
  }

  let nativePackageJson: string;
  try {
    nativePackageJson = createRequire(codexPackageJson).resolve(
      `${target.packageName}/package.json`,
    );
  } catch (error) {
    throw new ManagedCodexToolchainError(
      "MANAGED_CODEX_NATIVE_PACKAGE_MISSING",
      { cause: error },
    );
  }
  const nativePackageRoot = path.dirname(nativePackageJson);
  try {
    const nativePackage = z.object({
      name: z.literal("@openai/codex"),
      version: z.literal(target.packageVersion),
    }).passthrough().parse(JSON.parse(fs.readFileSync(nativePackageJson, "utf8")));
    if (nativePackage.version !== target.packageVersion) {
      throw new Error("native package version mismatch");
    }
  } catch (error) {
    throw new ManagedCodexToolchainError("MANAGED_CODEX_NATIVE_PACKAGE_MISSING");
  }

  const binaryRoot = path.join(
    nativePackageRoot,
    "vendor",
    target.vendorTarget,
    "bin",
  );
  const codexExecutable = requireRegularFile(
    path.join(binaryRoot, `codex${target.suffix}`),
  );
  const codeModeHostExecutable = requireRegularFile(
    path.join(binaryRoot, `codex-code-mode-host${target.suffix}`),
  );
  return {
    version: parsedPackage.version,
    codexExecutable,
    codeModeHostExecutable,
  };
}

function requireRegularFile(filePath: string): string {
  try {
    const metadata = fs.lstatSync(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("not a regular file");
    }
    return fs.realpathSync.native(filePath);
  } catch (error) {
    throw new ManagedCodexToolchainError(
      "MANAGED_CODEX_BINARY_MISSING",
      { cause: error },
    );
  }
}
