import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";

import { z } from "zod";

import {
  EVIDENCE_SCHEMA_VERSION,
  EvidenceBundleSchema,
  EvidenceRelativePathSchema,
  type EvidenceBundle,
  type EvidenceItem,
} from "../contracts/evidence.js";
import {
  SecretPolicyError,
  assertSecretSafe,
} from "../security/payload-policy.js";
import { EvidencePolicyError } from "./project-evidence-provider.js";

const DEFAULT_ALLOWED_EXTENSIONS = [
  ".bicep",
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".md",
  ".mjs",
  ".ps1",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
] as const;

const CREDENTIAL_ASSIGNMENT_PATTERN =
  /(?:["']?)(?:api_?key|access_?token|refresh_?token|client_?secret|password|private_?key|connection_?string|sas_?token|sharedaccesskey|accountkey)(?:["']?)\s*[:=]\s*["']?[^\s"',;}]{4,}/iu;
const GIT_COMMAND_TIMEOUT_MS = 10_000;

const PolicySchema = z
  .object({
    requireClean: z.boolean().default(true),
    maxFiles: z.number().int().min(1).max(16).default(12),
    maxFileBytes: z
      .number()
      .int()
      .min(1)
      .max(262_144)
      .default(131_072),
    maxTotalBytes: z
      .number()
      .int()
      .min(1)
      .max(1_048_576)
      .default(524_288),
    allowedExtensions: z
      .array(z.string().regex(/^\.[a-z0-9]+$/u))
      .min(1)
      .max(64)
      .default([...DEFAULT_ALLOWED_EXTENSIONS]),
    gitExecutable: z.string().trim().min(1).optional(),
    gitExecutableSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/iu)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      Boolean(value.gitExecutable) !==
      Boolean(value.gitExecutableSha256)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "gitExecutable and gitExecutableSha256 must be supplied together.",
      });
    }
  });

const CollectionInputSchema = z
  .object({
    project: z.string().trim().min(1).max(120),
    projectRoot: z.string().trim().min(1),
    revision: z
      .string()
      .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u),
    paths: z.array(EvidenceRelativePathSchema).min(1).max(16),
    now: z.date().optional(),
  })
  .strict();

export interface PinnedGitEvidencePolicy {
  requireClean?: boolean;
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  allowedExtensions?: string[];
  gitExecutable?: string;
  gitExecutableSha256?: string;
}

export interface PinnedGitEvidenceInput {
  project: string;
  projectRoot: string;
  revision: string;
  paths: string[];
  now?: Date;
}

export class PinnedGitEvidenceProvider {
  private readonly policy: z.infer<typeof PolicySchema>;
  private readonly gitExecutable: string;

  public constructor(policy: PinnedGitEvidencePolicy = {}) {
    this.policy = PolicySchema.parse(policy);
    this.gitExecutable = resolveGitExecutable(
      this.policy.gitExecutable,
      this.policy.gitExecutableSha256,
    );
    if (this.policy.maxFileBytes > this.policy.maxTotalBytes) {
      throw new EvidencePolicyError(
        "The Git evidence per-file byte limit cannot exceed the aggregate byte limit.",
      );
    }
  }

  public collect(input: PinnedGitEvidenceInput): EvidenceBundle {
    const parsed = CollectionInputSchema.parse(input);
    if (parsed.paths.length > this.policy.maxFiles) {
      throw new EvidencePolicyError(
        "The Git evidence request exceeds the configured file-count limit.",
      );
    }
    const root = canonicalDirectory(parsed.projectRoot);
    const repositoryRoot = canonicalDirectory(
      gitText(
        this.gitExecutable,
        root,
        ["rev-parse", "--show-toplevel"],
        "repository root",
      ),
    );
    if (!samePath(root, repositoryRoot)) {
      throw new EvidencePolicyError(
        "Pinned Git evidence requires the allowlisted project root to be the repository root.",
      );
    }

    const head = gitText(
      this.gitExecutable,
      root,
      ["rev-parse", "--verify", "HEAD^{commit}"],
      "repository HEAD",
    ).toLowerCase();
    if (head !== parsed.revision) {
      throw new EvidencePolicyError(
        "The requested Git revision does not match repository HEAD.",
      );
    }
    const commitTime = new Date(
      gitText(
        this.gitExecutable,
        root,
        ["show", "-s", "--format=%cI", head],
        "commit timestamp",
      ),
    ).toISOString();
    const branch = gitOptionalText(this.gitExecutable, root, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "HEAD",
    ]);
    const dirty =
      gitText(
        this.gitExecutable,
        root,
        ["status", "--porcelain=v1", "--untracked-files=all"],
        "worktree status",
      ).length > 0;
    if (dirty && this.policy.requireClean) {
      throw new EvidencePolicyError(
        "Pinned Git evidence requires a clean repository.",
      );
    }

    const seen = new Set<string>();
    const items: EvidenceItem[] = [];
    let totalBytes = 0;
    for (const requestedPath of parsed.paths) {
      const safePath = normalizeGitPath(requestedPath);
      const comparison = safePath.toLowerCase();
      if (seen.has(comparison)) {
        throw new EvidencePolicyError(
          "The Git evidence request contains a duplicate path.",
        );
      }
      seen.add(comparison);
      const extension = path.posix.extname(safePath).toLowerCase();
      if (!this.policy.allowedExtensions.includes(extension)) {
        throw new EvidencePolicyError(
          `Git evidence path '${safePath}' does not use an approved text extension.`,
        );
      }

      const treeEntry = gitText(
        this.gitExecutable,
        root,
        ["ls-tree", head, "--", safePath],
        `tracked blob '${safePath}'`,
      );
      const match =
        /^([0-9]{6}) (blob) ([a-f0-9]{40}|[a-f0-9]{64})\t(.+)$/u.exec(
          treeEntry,
        );
      if (
        !match ||
        !["100644", "100755"].includes(match[1]!) ||
        match[4]?.replaceAll("\\", "/") !== safePath
      ) {
        throw new EvidencePolicyError(
          `Git evidence path '${safePath}' is not a tracked regular blob.`,
        );
      }
      const blobOid = match[3]!;
      const size = Number.parseInt(
        gitText(
          this.gitExecutable,
          root,
          ["cat-file", "-s", blobOid],
          `blob size '${safePath}'`,
        ),
        10,
      );
      if (!Number.isSafeInteger(size) || size < 0) {
        throw new EvidencePolicyError(
          `Git evidence path '${safePath}' has an invalid blob size.`,
        );
      }
      if (size > this.policy.maxFileBytes) {
        throw new EvidencePolicyError(
          `Git evidence path '${safePath}' exceeds the per-file byte limit.`,
        );
      }
      if (totalBytes + size > this.policy.maxTotalBytes) {
        throw new EvidencePolicyError(
          "The Git evidence request exceeds the aggregate byte limit.",
        );
      }
      const contentBuffer = gitBuffer(
        this.gitExecutable,
        root,
        ["cat-file", "blob", blobOid],
        `blob content '${safePath}'`,
        this.policy.maxFileBytes,
      );
      if (contentBuffer.byteLength !== size) {
        throw new EvidencePolicyError(
          `Git evidence path '${safePath}' changed during object retrieval.`,
        );
      }
      if (contentBuffer.includes(0)) {
        throw new EvidencePolicyError(
          `Git evidence path '${safePath}' appears to contain binary data.`,
        );
      }
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(
          contentBuffer,
        );
      } catch (error) {
        throw new EvidencePolicyError(
          `Git evidence path '${safePath}' is not valid UTF-8 text.`,
          { cause: error },
        );
      }
      assertEvidenceTextSafe(content, safePath);
      items.push({
        path: safePath,
        source: "pinned_git",
        git_commit: head,
        git_blob_oid: blobOid,
        content,
        sha256: createHash("sha256")
          .update(contentBuffer)
          .digest("hex"),
        byte_length: contentBuffer.byteLength,
        modified_at_utc: commitTime,
      });
      totalBytes += contentBuffer.byteLength;
    }

    return EvidenceBundleSchema.parse({
      schema_version: EVIDENCE_SCHEMA_VERSION,
      project: parsed.project,
      generated_at_utc: (parsed.now ?? new Date()).toISOString(),
      total_bytes: totalBytes,
      git_snapshot: {
        revision: head,
        branch,
        worktree_state: dirty ? "dirty" : "clean",
        commit_time_utc: commitTime,
      },
      items,
    });
  }
}

function canonicalDirectory(value: string): string {
  const resolved = path.resolve(value);
  try {
    if (!fs.statSync(resolved).isDirectory()) {
      throw new Error("not a directory");
    }
    return fs.realpathSync.native(resolved);
  } catch (error) {
    throw new EvidencePolicyError(
      "The Git evidence root is not an accessible directory.",
      { cause: error },
    );
  }
}

function normalizeGitPath(value: string): string {
  const parsed = EvidenceRelativePathSchema.parse(value);
  const normalized = parsed.replaceAll("\\", "/");
  if (normalized.includes(":")) {
    throw new EvidencePolicyError(
      "Git evidence paths cannot contain colon characters.",
    );
  }
  return normalized;
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function gitText(
  executable: string,
  root: string,
  arguments_: string[],
  operation: string,
): string {
  return gitBuffer(
    executable,
    root,
    arguments_,
    operation,
    1_048_576,
  )
    .toString("utf8")
    .trim();
}

function gitOptionalText(
  executable: string,
  root: string,
  arguments_: string[],
): string | null {
  const result = spawnSync(executable, ["-C", root, ...arguments_], {
    encoding: "buffer",
    maxBuffer: 1_048_576,
    timeout: GIT_COMMAND_TIMEOUT_MS,
    shell: false,
    windowsHide: true,
  });
  if (result.status === 1) {
    return null;
  }
  if (result.status !== 0 || result.error) {
    throw new EvidencePolicyError(
      "Git could not determine the repository branch.",
      { cause: result.error },
    );
  }
  return result.stdout.toString("utf8").trim() || null;
}

function gitBuffer(
  executable: string,
  root: string,
  arguments_: string[],
  operation: string,
  maxBuffer: number,
): Buffer {
  const result = spawnSync(executable, ["-C", root, ...arguments_], {
    encoding: "buffer",
    maxBuffer,
    timeout: GIT_COMMAND_TIMEOUT_MS,
    shell: false,
    windowsHide: true,
  });
  if (result.status !== 0 || result.error) {
    throw new EvidencePolicyError(
      `Git could not read ${operation}.`,
      { cause: result.error },
    );
  }
  return result.stdout;
}

function resolveGitExecutable(
  executable: string | undefined,
  expectedSha256: string | undefined,
): string {
  if (!executable || !expectedSha256) {
    return "git";
  }
  const resolved = path.resolve(executable);
  let actual: string;
  try {
    if (!fs.statSync(resolved).isFile()) {
      throw new Error("not a file");
    }
    actual = createHash("sha256")
      .update(fs.readFileSync(resolved))
      .digest("hex");
  } catch (error) {
    throw new EvidencePolicyError(
      "The configured Git executable is not accessible.",
      { cause: error },
    );
  }
  if (actual !== expectedSha256.toLowerCase()) {
    throw new EvidencePolicyError(
      "The configured Git executable did not match its approved SHA-256.",
    );
  }
  return resolved;
}

function assertEvidenceTextSafe(
  content: string,
  safePath: string,
): void {
  try {
    assertSecretSafe(content);
    if (CREDENTIAL_ASSIGNMENT_PATTERN.test(content)) {
      throw new SecretPolicyError(
        "Evidence contains a credential-shaped assignment.",
      );
    }
  } catch (error) {
    if (error instanceof SecretPolicyError) {
      throw new EvidencePolicyError(
        `Git evidence path '${safePath}' is not secret-safe.`,
        { cause: error },
      );
    }
    throw error;
  }
}
