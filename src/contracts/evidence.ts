import { createHash } from "node:crypto";
import path from "node:path";

import { z } from "zod";

import { CoordinationIntentSchema } from "./coordination.js";

export const EVIDENCE_SCHEMA_VERSION = "1.0" as const;

const GitObjectIdSchema = z
  .string()
  .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);

export const PinnedGitSnapshotSchema = z
  .object({
    revision: GitObjectIdSchema,
    branch: z.string().trim().min(1).max(255).nullable(),
    worktree_state: z.enum(["clean", "dirty"]),
    commit_time_utc: z.string().datetime({ offset: true }),
  })
  .strict();

export const PeerInformationRequestSchema = z
  .object({
    subject: z.string().trim().min(1).max(200),
    request: z.string().trim().min(1).max(12_000),
    intent: CoordinationIntentSchema,
  })
  .strict();

export const EvidenceRelativePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  .superRefine((value, context) => {
    const normalized = value.replaceAll("\\", "/");
    const segments = normalized.split("/");
    if (
      path.posix.isAbsolute(normalized) ||
      path.win32.isAbsolute(value) ||
      path.win32.parse(value).root !== "" ||
      segments.some(
        (segment) =>
          segment.length === 0 ||
          segment === "." ||
          segment === "..",
      )
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Evidence paths must use canonical relative components without traversal.",
      });
    }
  });

export const EvidenceItemSchema = z
  .object({
    path: EvidenceRelativePathSchema,
    source: z.enum([
      "local_project",
      "peer_result",
      "pinned_git",
    ]),
    source_message_id: z.string().uuid().optional(),
    git_commit: GitObjectIdSchema.optional(),
    git_blob_oid: GitObjectIdSchema.optional(),
    content: z.string().max(262_144),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    byte_length: z.number().int().nonnegative().max(262_144),
    modified_at_utc: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((value, context) => {
    const content = Buffer.from(value.content, "utf8");
    if (content.byteLength !== value.byte_length) {
      context.addIssue({
        code: "custom",
        message: "Evidence byte_length does not match its UTF-8 content.",
        path: ["byte_length"],
      });
    }
    const actualHash = createHash("sha256").update(content).digest("hex");
    if (actualHash !== value.sha256) {
      context.addIssue({
        code: "custom",
        message: "Evidence sha256 does not match its content.",
        path: ["sha256"],
      });
    }
    if (
      value.source === "peer_result" &&
      !value.source_message_id
    ) {
      context.addIssue({
        code: "custom",
        message: "Peer-result evidence requires source_message_id.",
        path: ["source_message_id"],
      });
    }
    if (
      value.source === "local_project" &&
      (value.source_message_id ||
        value.git_commit ||
        value.git_blob_oid)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Local-project evidence cannot declare source_message_id.",
        path: ["source_message_id"],
      });
    }
    if (
      value.source === "peer_result" &&
      (value.git_commit || value.git_blob_oid)
    ) {
      context.addIssue({
        code: "custom",
        message: "Peer-result evidence cannot declare Git object IDs.",
        path: ["git_commit"],
      });
    }
    if (
      value.source === "pinned_git" &&
      (!value.git_commit ||
        !value.git_blob_oid ||
        value.source_message_id)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Pinned-Git evidence requires commit and blob object IDs without source_message_id.",
        path: ["git_commit"],
      });
    }
  });

export const EvidenceBundleSchema = z
  .object({
    schema_version: z.literal(EVIDENCE_SCHEMA_VERSION),
    project: z.string().trim().min(1).max(120),
    generated_at_utc: z.string().datetime({ offset: true }),
    total_bytes: z.number().int().nonnegative().max(1_048_576),
    git_snapshot: PinnedGitSnapshotSchema.optional(),
    items: z.array(EvidenceItemSchema).max(16),
  })
  .strict()
  .superRefine((value, context) => {
    const total = value.items.reduce(
      (sum, item) => sum + item.byte_length,
      0,
    );
    if (total !== value.total_bytes) {
      context.addIssue({
        code: "custom",
        message: "Evidence total_bytes does not match its items.",
        path: ["total_bytes"],
      });
    }

    const paths = value.items.map((item) =>
      item.path.replaceAll("\\", "/").toLowerCase(),
    );
    if (new Set(paths).size !== paths.length) {
      context.addIssue({
        code: "custom",
        message: "Evidence bundle paths must be unique.",
        path: ["items"],
      });
    }

    for (const [index, item] of value.items.entries()) {
      if (
        item.source === "pinned_git" &&
        (!value.git_snapshot ||
          item.git_commit !== value.git_snapshot.revision)
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Pinned-Git item commit must match the bundle snapshot revision.",
          path: ["items", index, "git_commit"],
        });
      }
    }
  });

const CompletedChildTurnSchema = z
  .object({
    schema_version: z.literal(EVIDENCE_SCHEMA_VERSION),
    outcome: z.literal("completed"),
    answer: z.string().trim().min(1).max(48_000),
    evidence_paths: z.array(EvidenceRelativePathSchema).max(16),
  })
  .strict();

const NeedsInformationChildTurnSchema = z
  .object({
    schema_version: z.literal(EVIDENCE_SCHEMA_VERSION),
    outcome: z.literal("needs_information"),
    reason: z.string().trim().min(1).max(4000),
    requested_evidence: z
      .array(EvidenceRelativePathSchema)
      .min(1)
      .max(16)
      .optional(),
    peer_request: PeerInformationRequestSchema.optional(),
    evidence_paths: z.array(EvidenceRelativePathSchema).max(16),
  })
  .strict()
  .superRefine((value, context) => {
    const sourceCount =
      (value.requested_evidence?.length ? 1 : 0) +
      (value.peer_request ? 1 : 0);
    if (sourceCount !== 1) {
      context.addIssue({
        code: "custom",
        message:
          "needs_information requires exactly one of requested_evidence or peer_request.",
        path: ["requested_evidence"],
      });
    }
  });

export const ChildTurnResultSchema = z.union([
  CompletedChildTurnSchema,
  NeedsInformationChildTurnSchema,
]);

export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;
export type EvidenceBundle = z.infer<typeof EvidenceBundleSchema>;
export type ChildTurnResult = z.infer<typeof ChildTurnResultSchema>;
