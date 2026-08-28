import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import { NodeIdSchema, SystemIdSchema, type SystemId } from "../contracts/envelope.js";
import {
  deriveEd25519KeyId,
  generateNodeIdentity,
  validateNodeIdentityDirectory,
} from "../security/node-identity.js";

const MAX_ENROLLMENT_BYTES = 1024 * 1024;
const MANIFEST_FILE = "onboarding-manifest.json";
const IDENTITY_DIRECTORY = "identity";
const MEMBERSHIP_FILE = "membership.json";
const PROFILE_FILE = "config.json";
const DATABASE_FILE = "bridge.sqlite3";

const NetworkIdSchema = z.string().trim().min(1).max(50).regex(
  /^[a-z][a-z0-9-]*$/,
  "must be a bounded lowercase network identifier",
);
const KeyIdSchema = z.string().regex(/^ed25519:[A-Za-z0-9_-]{43}$/);
const EnrollmentSchema = z.object({
  schema_version: z.literal("1.0"),
  network_id: NetworkIdSchema,
  node_id: SystemIdSchema,
  key_id: KeyIdSchema,
  spki_der_base64url: z.string().min(1).max(1024).regex(/^[A-Za-z0-9_-]+$/),
  status: z.literal("active"),
}).strict();
const GeneratedEnrollmentSchema = EnrollmentSchema.omit({
  schema_version: true,
  network_id: true,
});
const ManifestSchema = z.object({
  schema_version: z.literal("1.0"),
  status: z.enum(["pending", "blocked", "complete"]),
  root: z.string().min(1),
  node_id: SystemIdSchema,
  network_id: NetworkIdSchema,
  authorized_node_ids: z.array(SystemIdSchema).min(1).max(32),
  identity_directory: z.string().min(1),
  signing_key_path: z.string().min(1),
  local_enrollment_path: z.string().min(1),
  membership_path: z.string().min(1),
  profile_path: z.string().min(1),
  database_path: z.string().min(1),
  local_enrollment: EnrollmentSchema.optional(),
  enrollments: z.record(z.string(), EnrollmentSchema),
  artifact_sha256: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
  created_at_utc: z.string().datetime({ offset: true }),
  updated_at_utc: z.string().datetime({ offset: true }),
}).strict();

export type OnboardingStatus = "pending" | "blocked" | "complete";
export type Enrollment = z.infer<typeof EnrollmentSchema>;
export type OnboardingManifest = z.infer<typeof ManifestSchema>;

export interface StartOnboardingInput {
  root: string;
  nodeId: SystemId;
  processIdentity: string | undefined;
  networkId: string;
  authorizedNodeIds: readonly SystemId[];
  identityDirectory?: string;
}

export interface OnboardingManifestResult extends OnboardingManifest {
  manifestPath: string;
}

export interface OnboardingStatusResult {
  manifest: OnboardingManifestResult;
  status: OnboardingStatus;
  artifacts: Readonly<Record<string, ArtifactStatus>>;
  issues: readonly string[];
}

export interface ArtifactStatus {
  present: boolean;
  sha256?: string;
}

export interface PublicEnrollmentExport {
  enrollment: Enrollment;
  json: string;
}

export interface ImportEnrollmentInput {
  manifestPath: string;
  inputPath: string;
  expectedPeerId: SystemId;
}

export interface PreparedIdentityOptions {
  directory: string;
}

export interface GenerateOnboardingIdentityOptions {
  manifestPath: string;
}

export interface MembershipPolicy {
  schema_version: "1.0";
  network_id: string;
  peers: Array<{
    node_id: SystemId;
    keys: Array<Pick<Enrollment, "key_id" | "spki_der_base64url" | "status">>;
  }>;
}

export type OnboardingErrorCode =
  | "PROCESS_IDENTITY_MISMATCH"
  | "ONBOARDING_INPUT_INVALID"
  | "ONBOARDING_ROOT_INVALID"
  | "MANIFEST_INVALID"
  | "MANIFEST_CONFLICT"
  | "MANIFEST_IO_FAILED"
  | "IDENTITY_PREPARATION_FAILED"
  | "IDENTITY_CONFLICT"
  | "ENROLLMENT_INVALID"
  | "ENROLLMENT_CONFLICT"
  | "ENROLLMENT_IO_FAILED"
  | "MEMBERSHIP_INVALID"
  | "MEMBERSHIP_INCOMPLETE"
  | "MEMBERSHIP_IO_FAILED";

const ERROR_MESSAGES: Readonly<Record<OnboardingErrorCode, string>> = {
  PROCESS_IDENTITY_MISMATCH: "The process identity does not match the node being onboarded.",
  ONBOARDING_INPUT_INVALID: "The onboarding input is invalid.",
  ONBOARDING_ROOT_INVALID: "The onboarding root must be an absolute non-reparse directory.",
  MANIFEST_INVALID: "The onboarding manifest is invalid or unreadable.",
  MANIFEST_CONFLICT: "The existing onboarding manifest contradicts the requested operation.",
  MANIFEST_IO_FAILED: "The onboarding manifest could not be written atomically.",
  IDENTITY_PREPARATION_FAILED: "The identity directory could not be prepared with a safe ACL.",
  IDENTITY_CONFLICT: "The existing identity artifacts are incomplete or contradict onboarding state.",
  ENROLLMENT_INVALID: "The public enrollment is invalid or contains disallowed material.",
  ENROLLMENT_CONFLICT: "The public enrollment conflicts with the existing onboarding state.",
  ENROLLMENT_IO_FAILED: "The public enrollment could not be read or written safely.",
  MEMBERSHIP_INVALID: "The membership policy is invalid.",
  MEMBERSHIP_INCOMPLETE: "Public enrollment is missing for one or more authorized peers.",
  MEMBERSHIP_IO_FAILED: "The membership policy could not be written atomically.",
};

export class OnboardingError extends Error {
  public constructor(public readonly code: OnboardingErrorCode, cause?: unknown) {
    super(ERROR_MESSAGES[code], cause === undefined ? undefined : { cause });
    this.name = "OnboardingError";
  }
}

export function startOnboarding(input: StartOnboardingInput): OnboardingManifestResult {
  const root = validateStartInput(input);
  const manifestPath = path.join(root, MANIFEST_FILE);
  const existing = lstatIfPresent(manifestPath);
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new OnboardingError("MANIFEST_INVALID");
    }
    const manifest = readManifest(manifestPath);
    if (!sameStart(manifest, root, input)) {
      throw new OnboardingError("MANIFEST_CONFLICT");
    }
    return withManifestPath(manifest, manifestPath);
  }

  fs.mkdirSync(root, { recursive: true });
  validateOnboardingRootDirectory(root);
  const identityDirectory = resolveIdentityDirectory(input, root);
  prepareIdentityDirectory(identityDirectory);
  const now = new Date().toISOString();
  const manifest: OnboardingManifest = {
    schema_version: "1.0",
    status: "pending",
    root,
    node_id: input.nodeId,
    network_id: input.networkId,
    authorized_node_ids: [...input.authorizedNodeIds],
    identity_directory: identityDirectory,
    signing_key_path: path.join(identityDirectory, "node-identity.pkcs8.pem"),
    local_enrollment_path: path.join(identityDirectory, "node-enrollment.json"),
    membership_path: path.join(root, MEMBERSHIP_FILE),
    profile_path: path.join(root, PROFILE_FILE),
    database_path: path.join(root, DATABASE_FILE),
    enrollments: {},
    artifact_sha256: {},
    created_at_utc: now,
    updated_at_utc: now,
  };
  writeManifestAtomic(manifestPath, manifest, false);
  return withManifestPath(manifest, manifestPath);
}

export function readOnboardingManifest(manifestPath: string): OnboardingManifestResult {
  const absolute = requireAbsolute(manifestPath);
  try {
    return withManifestPath(readManifest(absolute), absolute);
  } catch (error) {
    if (error instanceof OnboardingError) throw error;
    throw new OnboardingError("MANIFEST_INVALID", error);
  }
}

export function prepareIdentityDirectory(
  options: PreparedIdentityOptions | string,
): string {
  const directory = requireAbsolute(
    typeof options === "string" ? options : options.directory,
  );
  try {
    const existing = lstatIfPresent(directory);
    if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) {
      throw new OnboardingError("ONBOARDING_ROOT_INVALID");
    }
    if (!existing) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") {
      fs.chmodSync(directory, 0o700);
      return directory;
    }
    applyWindowsIdentityAcl(directory);
    return directory;
  } catch (error) {
    if (error instanceof OnboardingError) throw error;
    throw new OnboardingError("IDENTITY_PREPARATION_FAILED", error);
  }
}

export function generateOnboardingIdentity(
  options: GenerateOnboardingIdentityOptions,
): OnboardingManifestResult {
  const current = readOnboardingManifest(options.manifestPath);
  prepareIdentityDirectory(current.identity_directory);
  try {
    validateNodeIdentityDirectory(current.identity_directory);
  } catch (error) {
    throw new OnboardingError("IDENTITY_PREPARATION_FAILED", error);
  }
  const existingKey = lstatIfPresent(current.signing_key_path);
  const existingEnrollment = lstatIfPresent(current.local_enrollment_path);
  if (existingKey || existingEnrollment) {
    if (
      !existingKey?.isFile() ||
      existingKey.isSymbolicLink() ||
      !existingEnrollment?.isFile() ||
      existingEnrollment.isSymbolicLink()
    ) {
      throw new OnboardingError("IDENTITY_CONFLICT");
    }
    try {
      const rawEnrollment = readEnrollmentFile(current.local_enrollment_path);
      const enrollment = parseLocalEnrollment(rawEnrollment, current.network_id);
      if (
        enrollment.node_id !== current.node_id ||
        (current.local_enrollment &&
          canonicalJson(current.local_enrollment) !== canonicalJson(enrollment))
      ) {
        throw new OnboardingError("IDENTITY_CONFLICT");
      }
      validatePrivateKeyMatches(current.signing_key_path, enrollment);
      if (!EnrollmentSchema.safeParse(rawEnrollment).success) {
        writeAtomic(
          current.local_enrollment_path,
          exportPublicEnrollment(enrollment).json,
          true,
          "ENROLLMENT_IO_FAILED",
        );
      }
      const enrollmentHash = hashFile(current.local_enrollment_path);
      if (
        current.local_enrollment &&
        current.artifact_sha256["local_enrollment"] === enrollmentHash
      ) {
        return current;
      }
      const recovered: OnboardingManifest = {
        ...manifestData(current),
        local_enrollment: enrollment,
        artifact_sha256: {
          ...current.artifact_sha256,
          local_enrollment: enrollmentHash,
        },
        updated_at_utc: new Date().toISOString(),
      };
      writeManifestAtomic(current.manifestPath, recovered, true);
      return withManifestPath(recovered, current.manifestPath);
    } catch (error) {
      if (error instanceof OnboardingError && error.code === "IDENTITY_CONFLICT") {
        throw error;
      }
      throw new OnboardingError("IDENTITY_CONFLICT", error);
    }
  }
  const generated = generateNodeIdentity({
    nodeId: current.node_id,
    outputDirectory: current.identity_directory,
  });
  const enrollment = parseEnrollment({
    schema_version: "1.0",
    network_id: current.network_id,
    ...generated.enrollment,
  });
  writeAtomic(
    current.local_enrollment_path,
    exportPublicEnrollment(enrollment).json,
    true,
    "ENROLLMENT_IO_FAILED",
  );
  const updated: OnboardingManifest = {
    ...manifestData(current),
    local_enrollment: enrollment,
    artifact_sha256: {
      ...current.artifact_sha256,
      local_enrollment: hashFile(current.local_enrollment_path),
    },
    updated_at_utc: new Date().toISOString(),
  };
  writeManifestAtomic(current.manifestPath, updated, true);
  return withManifestPath(updated, current.manifestPath);
}

export function exportPublicEnrollment(
  value: unknown,
): PublicEnrollmentExport {
  const enrollment = parseEnrollment(value);
  return { enrollment, json: `${canonicalJson(enrollment)}\n` };
}

export function exportEnrollmentFile(
  inputPath: string,
  outputPath?: string,
): PublicEnrollmentExport & { outputPath?: string } {
  const exported = exportPublicEnrollment(readEnrollmentFile(inputPath));
  if (outputPath !== undefined) {
    const target = requireAbsolute(outputPath);
    const existing = lstatIfPresent(target);
    if (existing) {
      if (!existing.isFile() || existing.isSymbolicLink() || hashFile(target) !== hashContent(exported.json)) {
        throw new OnboardingError("ENROLLMENT_IO_FAILED");
      }
      return { ...exported, outputPath: target };
    }
    writeAtomic(target, exported.json, false, "ENROLLMENT_IO_FAILED");
    return { ...exported, outputPath: target };
  }
  return exported;
}

export function exportOnboardingEnrollment(
  manifestPath: string,
  outputPath: string,
): PublicEnrollmentExport & { outputPath: string } {
  const manifest = readOnboardingManifest(manifestPath);
  if (!manifest.local_enrollment) {
    throw new OnboardingError("IDENTITY_CONFLICT");
  }
  const enrollmentHash = hashFile(manifest.local_enrollment_path);
  const enrollment = parseEnrollment(
    readEnrollmentFile(manifest.local_enrollment_path),
  );
  if (
    manifest.artifact_sha256["local_enrollment"] !== enrollmentHash ||
    canonicalJson(enrollment) !== canonicalJson(manifest.local_enrollment)
  ) {
    throw new OnboardingError("IDENTITY_CONFLICT");
  }
  try {
    validateNodeIdentityDirectory(manifest.identity_directory);
    validatePrivateKeyMatches(manifest.signing_key_path, enrollment);
  } catch (error) {
    throw new OnboardingError("IDENTITY_CONFLICT", error);
  }
  const exported = exportEnrollmentFile(
    manifest.local_enrollment_path,
    outputPath,
  );
  return { ...exported, outputPath: exported.outputPath! };
}

export function importPublicEnrollment(
  input: ImportEnrollmentInput,
): OnboardingManifestResult {
  const current = readOnboardingManifest(input.manifestPath);
  const expectedPeerId = parseNodeId(input.expectedPeerId);
  if (!current.authorized_node_ids.includes(expectedPeerId) || expectedPeerId === current.node_id) {
    throw new OnboardingError("ENROLLMENT_INVALID");
  }
  const enrollment = parseEnrollment(readEnrollmentFile(input.inputPath));
  if (
    enrollment.node_id !== expectedPeerId ||
    enrollment.node_id === current.node_id ||
    enrollment.network_id !== current.network_id
  ) {
    throw new OnboardingError("ENROLLMENT_INVALID");
  }
  const prior = current.enrollments[expectedPeerId];
  if (prior && canonicalJson(prior) !== canonicalJson(enrollment)) {
    throw new OnboardingError("ENROLLMENT_CONFLICT");
  }
  for (const [nodeId, existing] of Object.entries(current.enrollments)) {
    if (nodeId !== expectedPeerId && (
      existing.key_id === enrollment.key_id ||
      existing.spki_der_base64url === enrollment.spki_der_base64url
    )) {
      throw new OnboardingError("ENROLLMENT_CONFLICT");
    }
  }
  if (current.local_enrollment && (
    current.local_enrollment.key_id === enrollment.key_id ||
    current.local_enrollment.spki_der_base64url === enrollment.spki_der_base64url
  )) {
    throw new OnboardingError("ENROLLMENT_CONFLICT");
  }

    const enrollmentDirectory = path.join(current.root, "enrollments");
    prepareIdentityDirectory(enrollmentDirectory);
    const target = path.join(enrollmentDirectory, `${expectedPeerId}.json`);
    const exported = exportPublicEnrollment(enrollment);
    const exportedHash = hashContent(exported.json);
    const targetMetadata = lstatIfPresent(target);
    if (targetMetadata) {
      if (
        !targetMetadata.isFile() ||
        targetMetadata.isSymbolicLink() ||
        hashFile(target) !== exportedHash
      ) {
        throw new OnboardingError("ENROLLMENT_CONFLICT");
      }
      if (prior) {
        if (
          current.artifact_sha256[`enrollment:${expectedPeerId}`] !==
          exportedHash
        ) {
          throw new OnboardingError("ENROLLMENT_CONFLICT");
        }
        return current;
      }
      if (current.artifact_sha256[`enrollment:${expectedPeerId}`]) {
        throw new OnboardingError("ENROLLMENT_CONFLICT");
      }
      // Recover only the exact canonical artifact that the interrupted import
      // would have written. Any other pre-existing bytes remain a conflict.
    } else {
      if (prior || current.artifact_sha256[`enrollment:${expectedPeerId}`]) {
        throw new OnboardingError("ENROLLMENT_CONFLICT");
      }
      writeAtomic(target, exported.json, false, "ENROLLMENT_IO_FAILED");
    }
  const updated: OnboardingManifest = {
    ...manifestData(current),
    enrollments: { ...current.enrollments, [expectedPeerId]: enrollment },
    artifact_sha256: {
      ...current.artifact_sha256,
      [`enrollment:${expectedPeerId}`]: hashFile(target),
    },
    updated_at_utc: new Date().toISOString(),
  };
  writeManifestAtomic(current.manifestPath, updated, true);
  return withManifestPath(updated, current.manifestPath);
}

export function buildMembershipPolicy(
  value: OnboardingManifest | OnboardingManifestResult,
): MembershipPolicy {
  let manifest: OnboardingManifest;
  try {
    const { manifestPath: _ignored, ...manifestValue } = value as OnboardingManifestResult;
    manifest = ManifestSchema.parse(manifestValue);
    validateManifest(manifest);
  } catch (error) {
    if (error instanceof OnboardingError) throw error;
    throw new OnboardingError("MEMBERSHIP_INVALID", error);
  }
  const peers = [...manifest.authorized_node_ids].sort(compareIds);
  if (peers.some((nodeId) => nodeId === manifest.node_id)) {
    throw new OnboardingError("MEMBERSHIP_INVALID");
  }
  if (peers.some((nodeId) => !manifest.enrollments[nodeId])) {
    throw new OnboardingError("MEMBERSHIP_INCOMPLETE");
  }
  const seenKeys = new Set<string>();
  const seenSpki = new Set<string>();
  return {
    schema_version: "1.0",
    network_id: manifest.network_id,
    peers: peers.map((nodeId) => {
      const enrollment = manifest.enrollments[nodeId]!;
      parseEnrollment(enrollment);
      if (seenKeys.has(enrollment.key_id) || seenSpki.has(enrollment.spki_der_base64url)) {
        throw new OnboardingError("MEMBERSHIP_INVALID");
      }
      seenKeys.add(enrollment.key_id);
      seenSpki.add(enrollment.spki_der_base64url);
      return {
        node_id: nodeId,
        keys: [{
          key_id: enrollment.key_id,
          spki_der_base64url: enrollment.spki_der_base64url,
          status: enrollment.status,
        }],
      };
    }),
  };
}

export function writeMembershipPolicy(
  manifestPath: string,
): OnboardingManifestResult {
    const current = readOnboardingManifest(manifestPath);
    const policy = buildMembershipPolicy(current);
    const json = `${canonicalJson(policy)}\n`;
    const membershipHash = hashContent(json);
    const membershipMetadata = lstatIfPresent(current.membership_path);
    if (membershipMetadata) {
      if (
        !membershipMetadata.isFile() ||
        membershipMetadata.isSymbolicLink() ||
        hashFile(current.membership_path) !== membershipHash ||
        (current.artifact_sha256["membership"] !== undefined &&
          current.artifact_sha256["membership"] !== membershipHash)
      ) {
        throw new OnboardingError("MEMBERSHIP_INVALID");
      }
      if (current.artifact_sha256["membership"] === membershipHash) {
        return current;
      }
    } else if (current.artifact_sha256["membership"]) {
      throw new OnboardingError("MEMBERSHIP_INVALID");
    } else {
      writeAtomic(current.membership_path, json, false, "MEMBERSHIP_IO_FAILED");
    }
  const updated: OnboardingManifest = {
    ...manifestData(current),
    artifact_sha256: {
      ...current.artifact_sha256,
      membership: hashFile(current.membership_path),
    },
    updated_at_utc: new Date().toISOString(),
  };
  writeManifestAtomic(current.manifestPath, updated, true);
  return withManifestPath(updated, current.manifestPath);
}

export function statusOnboarding(manifestPath: string): OnboardingStatusResult {
  const manifest = readOnboardingManifest(manifestPath);
  const artifacts: Record<string, ArtifactStatus> = {};
  const issues: string[] = [];
  try {
    validateNodeIdentityDirectory(manifest.identity_directory);
  } catch {
    issues.push("identity_directory: unsafe ACL");
  }
  const inspect = (
    name: string,
    filePath: string,
    hashArtifact = true,
  ): void => {
    const metadata = lstatIfPresent(filePath);
    if (!metadata || !metadata.isFile() || metadata.isSymbolicLink()) {
      artifacts[name] = { present: false };
      if (manifest.artifact_sha256[name]) issues.push(`${name}: artifact missing`);
      return;
    }
    if (!hashArtifact) {
      artifacts[name] = { present: true };
      return;
    }
    const sha256 = hashFile(filePath);
    artifacts[name] = { present: true, sha256 };
    const expected = manifest.artifact_sha256[name];
    if (expected && expected !== sha256) issues.push(`${name}: artifact changed`);
  };
  inspect("local_enrollment", manifest.local_enrollment_path);
  inspect("membership", manifest.membership_path);
  inspect("profile", manifest.profile_path);
  inspect("database", manifest.database_path, false);
  inspect("runtime_settings", path.join(manifest.root, "runtime-settings.json"));
  inspect("dispatcher_projects", path.join(manifest.root, "dispatcher-projects.json"));
  for (const peerId of manifest.authorized_node_ids) {
    inspect(`enrollment:${peerId}`, path.join(manifest.root, "enrollments", `${peerId}.json`));
    if (artifacts[`enrollment:${peerId}`]?.present) {
      try {
        const actual = parseEnrollment(
          readEnrollmentFile(path.join(manifest.root, "enrollments", `${peerId}.json`)),
        );
        if (canonicalJson(actual) !== canonicalJson(manifest.enrollments[peerId])) {
          issues.push(`enrollment:${peerId}: content mismatch`);
        }
      } catch {
        issues.push(`enrollment:${peerId}: invalid enrollment`);
      }
    }
  }
  if (manifest.status === "complete") {
    const requiredArtifacts = [
      "local_enrollment",
      "membership",
      ...manifest.authorized_node_ids.map((peerId) => `enrollment:${peerId}`),
    ];
    for (const artifact of requiredArtifacts) {
      if (!artifacts[artifact]?.present) issues.push(`${artifact}: artifact missing`);
    }
  }
  if (manifest.artifact_sha256["runtime_settings"]) {
    for (const artifact of ["profile", "database"]) {
      if (!artifacts[artifact]?.present) issues.push(`${artifact}: artifact missing`);
    }
  }
  if (manifest.local_enrollment) {
    try {
      const local = parseEnrollment(readEnrollmentFile(manifest.local_enrollment_path));
      if (local.node_id !== manifest.node_id) issues.push("local enrollment: node mismatch");
      validatePrivateKeyMatches(manifest.signing_key_path, local);
    } catch {
      issues.push("local identity: invalid or unavailable");
    }
  }
  if (artifacts["membership"]?.present) {
    try {
      const actual = JSON.parse(readRegularFile(manifest.membership_path).toString("utf8"));
      if (canonicalJson(actual) !== canonicalJson(buildMembershipPolicy(manifest))) {
        issues.push("membership: exact policy mismatch");
      }
    } catch {
      issues.push("membership: invalid policy");
    }
  }
  return {
    manifest,
    status: issues.length > 0 ? "blocked" : manifest.status,
    artifacts,
    issues,
  };
}

export function resumeOnboarding(manifestPath: string): OnboardingStatusResult {
  const current = statusOnboarding(manifestPath);
  let status: OnboardingStatus = current.status;
  if (current.issues.length > 0) {
    status = "blocked";
  } else if (
    current.manifest.local_enrollment &&
    current.manifest.authorized_node_ids.every((peerId) => Boolean(current.manifest.enrollments[peerId])) &&
    current.artifacts["local_enrollment"]?.present &&
    current.manifest.authorized_node_ids.every((peerId) => current.artifacts[`enrollment:${peerId}`]?.present) &&
    current.artifacts["membership"]?.present
  ) {
    status = "complete";
  } else {
    status = "pending";
  }
  if (status !== current.manifest.status) {
    const updated = { ...manifestData(current.manifest), status, updated_at_utc: new Date().toISOString() };
    writeManifestAtomic(current.manifest.manifestPath, updated, true);
    current.manifest = withManifestPath(updated, current.manifest.manifestPath);
  }
  return { ...current, status, manifest: current.manifest };
}

export function recordOnboardingArtifactHash(
  manifestPath: string,
  artifactName: "profile" | "runtime_settings" | "dispatcher_projects",
  artifactPath: string,
): OnboardingManifestResult {
  const current = readOnboardingManifest(manifestPath);
  const expectedPath = artifactName === "profile"
    ? current.profile_path
    : artifactName === "runtime_settings"
      ? path.join(current.root, "runtime-settings.json")
      : path.join(current.root, "dispatcher-projects.json");
  if (path.resolve(artifactPath) !== expectedPath) {
    throw new OnboardingError("MANIFEST_CONFLICT");
  }
  const updated: OnboardingManifest = {
    ...manifestData(current),
    artifact_sha256: {
      ...current.artifact_sha256,
      [artifactName]: hashFile(expectedPath),
    },
    updated_at_utc: new Date().toISOString(),
  };
  writeManifestAtomic(current.manifestPath, updated, true);
  return withManifestPath(updated, current.manifestPath);
}

function validateStartInput(input: StartOnboardingInput): string {
  if (!input || typeof input !== "object" || !Array.isArray(input.authorizedNodeIds)) {
    throw new OnboardingError("ONBOARDING_INPUT_INVALID");
  }
  const root = requireAbsolute(input.root);
  const nodeId = parseNodeId(input.nodeId);
  if (input.nodeId !== nodeId) throw new OnboardingError("ONBOARDING_INPUT_INVALID");
  if (input.processIdentity !== nodeId) throw new OnboardingError("PROCESS_IDENTITY_MISMATCH");
  const networkId = NetworkIdSchema.safeParse(input.networkId);
  if (!networkId.success) throw new OnboardingError("ONBOARDING_INPUT_INVALID");
  if (networkId.data !== input.networkId) throw new OnboardingError("ONBOARDING_INPUT_INVALID");
  const peers = input.authorizedNodeIds.map(parseNodeId);
  if (peers.some((peer, index) => peer !== input.authorizedNodeIds[index])) {
    throw new OnboardingError("ONBOARDING_INPUT_INVALID");
  }
  if (peers.length === 0 || peers.length > 32 || new Set(peers).size !== peers.length || peers.includes(nodeId)) {
    throw new OnboardingError("ONBOARDING_INPUT_INVALID");
  }
  if (peers.some((peer, index) => index > 0 && compareIds(peers[index - 1]!, peer) >= 0)) {
    throw new OnboardingError("ONBOARDING_INPUT_INVALID");
  }
  const existing = lstatIfPresent(root);
  if (existing) validateOnboardingRootDirectory(root);
  return root;
}

function validateOnboardingRootDirectory(root: string): void {
  try {
    const metadata = fs.lstatSync(root);
    const realRoot = fs.realpathSync.native(root);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      path.relative(path.resolve(root), realRoot) !== ""
    ) {
      throw new Error("onboarding root is redirected");
    }
  } catch (error) {
    if (error instanceof OnboardingError) throw error;
    throw new OnboardingError("ONBOARDING_ROOT_INVALID", error);
  }
}

function sameStart(manifest: OnboardingManifest, root: string, input: StartOnboardingInput): boolean {
  return manifest.root === root &&
    manifest.node_id === input.nodeId &&
    manifest.network_id === input.networkId &&
    manifest.identity_directory === resolveIdentityDirectory(input, root) &&
    JSON.stringify(manifest.authorized_node_ids) === JSON.stringify(input.authorizedNodeIds);
}

function readManifest(manifestPath: string): OnboardingManifest {
  try {
    const manifest = ManifestSchema.parse(JSON.parse(readRegularFile(manifestPath).toString("utf8")));
    validateManifest(manifest, manifestPath);
    return manifest;
  } catch (error) {
    if (error instanceof OnboardingError) throw error;
    throw new OnboardingError("MANIFEST_INVALID", error);
  }
}

function validateManifest(manifest: OnboardingManifest, manifestPath?: string): void {
  for (const value of [
    manifest.root,
    manifest.identity_directory,
    manifest.signing_key_path,
    manifest.local_enrollment_path,
    manifest.membership_path,
    manifest.profile_path,
    manifest.database_path,
  ]) {
    if (!path.isAbsolute(value)) throw new OnboardingError("MANIFEST_INVALID");
  }
  if (manifest.authorized_node_ids.some((id, index) =>
    index > 0 && compareIds(manifest.authorized_node_ids[index - 1]!, id) >= 0,
  )) throw new OnboardingError("MANIFEST_INVALID");
  if (manifest.authorized_node_ids.includes(manifest.node_id)) {
    throw new OnboardingError("MANIFEST_INVALID");
  }
  if (manifestPath && path.dirname(manifestPath) !== manifest.root) {
    throw new OnboardingError("MANIFEST_INVALID");
  }
  if ([
    manifest.membership_path,
    manifest.profile_path,
    manifest.database_path,
  ].some((value) => !isContainedPath(manifest.root, value))) {
    throw new OnboardingError("MANIFEST_INVALID");
  }
  if (
    !isContainedPath(manifest.identity_directory, manifest.signing_key_path) ||
    !isContainedPath(manifest.identity_directory, manifest.local_enrollment_path)
  ) {
    throw new OnboardingError("MANIFEST_INVALID");
  }
  const seenKeyIds = new Set<string>();
  const seenSpki = new Set<string>();
  for (const enrollment of [
    ...(manifest.local_enrollment ? [manifest.local_enrollment] : []),
    ...Object.values(manifest.enrollments),
  ]) {
    parseEnrollment(enrollment);
    if (seenKeyIds.has(enrollment.key_id) || seenSpki.has(enrollment.spki_der_base64url)) {
      throw new OnboardingError("MANIFEST_INVALID");
    }
    seenKeyIds.add(enrollment.key_id);
    seenSpki.add(enrollment.spki_der_base64url);
  }
  if (
    manifest.local_enrollment &&
    (manifest.local_enrollment.node_id !== manifest.node_id ||
      manifest.local_enrollment.network_id !== manifest.network_id)
  ) {
    throw new OnboardingError("MANIFEST_INVALID");
  }
  if (Object.entries(manifest.enrollments).some(([id, enrollment]) =>
    !manifest.authorized_node_ids.includes(id as SystemId) ||
    id === manifest.node_id ||
    enrollment.node_id !== id ||
    enrollment.network_id !== manifest.network_id
  )) throw new OnboardingError("MANIFEST_INVALID");
}

function parseEnrollment(value: unknown): Enrollment {
  try {
    const enrollment = EnrollmentSchema.parse(value);
    const publicKey = createPublicKey({
      key: Buffer.from(enrollment.spki_der_base64url, "base64url"),
      format: "der",
      type: "spki",
    });
    if (
      publicKey.asymmetricKeyType !== "ed25519" ||
      deriveEd25519KeyId(publicKey.export({ format: "der", type: "spki" }) as Buffer) !== enrollment.key_id
    ) throw new Error("derived key mismatch");
    return enrollment;
  } catch (error) {
    throw new OnboardingError("ENROLLMENT_INVALID", error);
  }
}

function parseLocalEnrollment(value: unknown, networkId: string): Enrollment {
  const current = EnrollmentSchema.safeParse(value);
  if (current.success) {
    if (current.data.network_id !== networkId) {
      throw new OnboardingError("ENROLLMENT_INVALID");
    }
    return parseEnrollment(current.data);
  }
  try {
    return parseEnrollment({
      schema_version: "1.0",
      network_id: networkId,
      ...GeneratedEnrollmentSchema.parse(value),
    });
  } catch (error) {
    if (error instanceof OnboardingError) throw error;
    throw new OnboardingError("ENROLLMENT_INVALID", error);
  }
}

function readEnrollmentFile(filePath: string): unknown {
  try {
    return JSON.parse(readRegularFile(requireAbsolute(filePath)).toString("utf8"));
  } catch (error) {
    if (error instanceof OnboardingError) throw error;
    throw new OnboardingError("ENROLLMENT_IO_FAILED", error);
  }
}

function validatePrivateKeyMatches(filePath: string, enrollment: Enrollment): void {
  const key = createPrivateKey(readRegularFile(filePath).toString("utf8"));
  if (key.asymmetricKeyType !== "ed25519") throw new Error("wrong key type");
  const spki = createPublicKey(key).export({ format: "der", type: "spki" }) as Buffer;
  if (deriveEd25519KeyId(spki) !== enrollment.key_id) throw new Error("private key mismatch");
}

function readRegularFile(filePath: string): Buffer {
  const metadata = lstatIfPresent(filePath);
  if (!metadata || !metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_ENROLLMENT_BYTES) {
    throw new OnboardingError("ENROLLMENT_IO_FAILED");
  }
  return fs.readFileSync(filePath);
}

  function hashFile(filePath: string): string {
    return createHash("sha256").update(readRegularFile(filePath)).digest("hex");
  }

  function hashContent(content: string): string {
    return createHash("sha256").update(content, "utf8").digest("hex");
  }

function writeManifestAtomic(manifestPath: string, manifest: OnboardingManifest, replace: boolean): void {
  writeAtomic(manifestPath, `${canonicalJson(manifest)}\n`, replace, "MANIFEST_IO_FAILED");
}

function writeAtomic(filePath: string, content: string, replace: boolean, code: "MANIFEST_IO_FAILED" | "ENROLLMENT_IO_FAILED" | "MEMBERSHIP_IO_FAILED"): void {
  const absolute = requireAbsolute(filePath);
  const parent = path.dirname(absolute);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = `${absolute}.${process.pid}.${Date.now()}.tmp`;
  let backupPath: string | undefined;
  try {
    fs.writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, absolute);
  } catch (error) {
    if (replace && lstatIfPresent(absolute)) {
      try {
        backupPath = `${absolute}.${process.pid}.${Date.now()}.bak`;
        fs.renameSync(absolute, backupPath);
        fs.renameSync(temporary, absolute);
        fs.rmSync(backupPath, { force: true });
        return;
      } catch (replaceError) {
        try {
          if (backupPath && !lstatIfPresent(absolute) && lstatIfPresent(backupPath)) {
            fs.renameSync(backupPath, absolute);
          }
        } catch { /* preserve stable error */ }
        throw new OnboardingError(code, replaceError);
      }
    }
    try { fs.rmSync(temporary, { force: true }); } catch { /* preserve original error */ }
    throw new OnboardingError(code, error);
  }
}

function withManifestPath(manifest: OnboardingManifest, manifestPath: string): OnboardingManifestResult {
  return { ...manifest, manifestPath };
}

function manifestData(value: OnboardingManifestResult | OnboardingManifest): OnboardingManifest {
  if ("manifestPath" in value) {
    const { manifestPath: _ignored, ...manifest } = value;
    return manifest;
  }
  return value;
}

function parseNodeId(value: unknown): SystemId {
  const parsed = NodeIdSchema.safeParse(value);
  if (!parsed.success) throw new OnboardingError("ONBOARDING_INPUT_INVALID");
  return parsed.data;
}

function requireAbsolute(value: unknown): string {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new OnboardingError("ONBOARDING_INPUT_INVALID");
  }
  return path.resolve(value);
}

function isContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function lstatIfPresent(filePath: string): fs.Stats | undefined {
  try { return fs.lstatSync(filePath); } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function resolveIdentityDirectory(
  input: StartOnboardingInput,
  root: string,
): string {
  if (input.identityDirectory !== undefined) {
    return requireAbsolute(input.identityDirectory);
  }
  if (process.platform !== "win32") {
    return path.join(root, IDENTITY_DIRECTORY);
  }
  const protectedDataRoot = process.env["ProgramData"] ?? "C:\\ProgramData";
  const rootId = createHash("sha256").update(root.toLowerCase()).digest("hex").slice(0, 16);
  return path.join(
    protectedDataRoot,
    "Balcony",
    "AgentBridge",
    "identities",
    `${input.nodeId}-${rootId}`,
  );
}

function applyWindowsIdentityAcl(directory: string): void {
  const systemRoot = process.env["SystemRoot"];
  if (!systemRoot) throw new OnboardingError("IDENTITY_PREPARATION_FAILED");
  const whoami = path.join(systemRoot, "System32", "whoami.exe");
  const icacls = path.join(systemRoot, "System32", "icacls.exe");
  if (!fs.existsSync(whoami) || !fs.existsSync(icacls)) throw new OnboardingError("IDENTITY_PREPARATION_FAILED");
  const identity = spawnSync(whoami, ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true });
  const sid = identity.stdout.match(/S-\d-\d+(?:-\d+)+/i)?.[0];
  if (identity.status !== 0 || !sid) throw new OnboardingError("IDENTITY_PREPARATION_FAILED");
  const grants = [sid, "S-1-5-18", "S-1-5-32-544"].map((value) => `*${value}:(OI)(CI)F`);
  const result = spawnSync(icacls, [directory, "/inheritance:r", "/grant:r", ...grants], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new OnboardingError("IDENTITY_PREPARATION_FAILED");
}
