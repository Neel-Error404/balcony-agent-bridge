import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";

import { z } from "zod";

import { AgentBridgeService } from "../application/agent-bridge-service.js";
import type { BridgeConfig } from "../config.js";
import {
  CONSULTATION_PROTOCOL_VERSION,
  ConsultationRunSchema,
  consultationRequestFingerprint,
  type ConsultationRun,
} from "../contracts/consultation.js";
import {
  EVIDENCE_SCHEMA_VERSION,
  EvidenceBundleSchema,
  type ChildTurnResult,
  type EvidenceBundle,
  type EvidenceItem,
} from "../contracts/evidence.js";
import type {
  BridgeEnvelope,
  SystemId,
} from "../contracts/envelope.js";
import type { CodexExecutor } from "../dispatcher/codex-executor.js";
import type { ProjectRegistry } from "../dispatcher/project-registry.js";
import {
  CodexExecutionError,
  DispatchRejectedError,
} from "../errors.js";
import {
  buildEvidenceOnlyChildPrompt,
  EvidencePolicyError,
  parseEvidenceOnlyChildResult,
  type EvidenceCollectionInput,
} from "../evidence/project-evidence-provider.js";
import type {
  BridgeDatabase,
  ClaimedInboxMessage,
} from "../storage/database.js";

const CoordinatorPolicySchema = z
  .object({
    maxRounds: z.number().int().min(1).max(16),
    maxDepth: z.number().int().min(1).max(4),
    runTimeoutSeconds: z.number().int().min(30).max(3600),
    claimLeaseSeconds: z.number().int().min(720).max(900),
    maxOutputBytes: z.number().int().min(1024).max(60_000),
    peerPollIntervalSeconds: z
      .number()
      .int()
      .min(1)
      .max(300)
      .default(5),
  })
  .strict();

export interface AutonomousConsultationPolicy {
  maxRounds: number;
  maxDepth: number;
  runTimeoutSeconds: number;
  claimLeaseSeconds: number;
  maxOutputBytes: number;
  peerPollIntervalSeconds?: number;
}

export interface ConsultationEvidenceProvider {
  collect(input: EvidenceCollectionInput): EvidenceBundle;
}

export class AutonomousConsultationCoordinator {
  private readonly consumerId: string;
  private readonly bridgeService: AgentBridgeService;
  private readonly policy: z.infer<typeof CoordinatorPolicySchema>;
  private readonly workingDirectory: string;
  private readonly systemId: SystemId;
  private readonly peerSystemId: SystemId;

  public constructor(
    config: BridgeConfig,
    private readonly database: BridgeDatabase,
    private readonly projects: ProjectRegistry,
    private readonly executor: CodexExecutor,
    private readonly evidenceProvider: ConsultationEvidenceProvider,
    workingDirectory: string,
    policy: AutonomousConsultationPolicy,
    private readonly clock?: () => Date,
  ) {
    this.consumerId = `consultation-coordinator:${config.systemId}:${randomUUID()}`;
    this.bridgeService = new AgentBridgeService(config, database);
    this.policy = CoordinatorPolicySchema.parse(policy);
    this.workingDirectory = requireDirectory(workingDirectory);
    this.systemId = config.systemId;
    this.peerSystemId = config.peerSystemId;
  }

  public async runOnce(
    now = new Date(),
    abortSignal?: AbortSignal,
  ): Promise<number> {
    const claims = this.database.claimAutonomousConsultationInbox(
      this.consumerId,
      1,
      this.policy.claimLeaseSeconds,
      now,
    );
    let progressed = 0;
    for (const claim of claims) {
      if (await this.processClaim(claim, now, abortSignal)) {
        progressed += 1;
      }
    }
    return progressed;
  }

  public recordHeartbeat(
    status: "healthy" | "degraded",
    lastErrorCode?: string,
  ): void {
    this.database.recordConsultationCoordinatorHeartbeat(
      this.consumerId,
      status,
      lastErrorCode,
    );
  }

  private async processClaim(
    claim: ClaimedInboxMessage,
    now: Date,
    abortSignal?: AbortSignal,
  ): Promise<boolean> {
    let run: ConsultationRun;
    try {
      run = this.ensureRun(claim.envelope, now);
    } catch (error) {
      if (error instanceof DispatchRejectedError) {
        this.settleInitialFailure(claim, error.code, now);
        return true;
      }
      throw error;
    }

    try {
      if (now.toISOString() >= run.deadline_at_utc) {
        this.fail(run, claim, "CONSULTATION_TIMED_OUT", now);
        return true;
      }

      switch (run.state) {
        case "pending_child":
          await this.executeChild(run, claim, now, abortSignal);
          return true;
        case "needs_information":
          this.collectLocalEvidence(run, claim, now);
          return true;
        case "waiting_peer":
          return this.advancePeerWait(run, claim, now);
        case "completed":
          this.complete(run, claim, now);
          return true;
        case "failed":
          this.settleFailure(run, claim, now);
          return true;
      }
    } catch (error) {
      if (
        error instanceof EvidencePolicyError ||
        error instanceof DispatchRejectedError ||
        (error instanceof CodexExecutionError &&
          error.code !== "CODEX_ABORTED")
      ) {
        this.fail(run, claim, error.code, now);
        return true;
      }
      throw error;
    }
  }

  private ensureRun(
    envelope: BridgeEnvelope,
    now: Date,
  ): ConsultationRun {
    const projectKey = envelope.payload.project;
    const request = envelope.payload.body;
    if (
      !projectKey ||
      !envelope.payload.coordination_request ||
      !this.projects.get(projectKey)
    ) {
      throw new DispatchRejectedError(
        "The consultation request is not enabled for the local project.",
      );
    }
    const fingerprint = consultationRequestFingerprint({
      project: projectKey,
      subject: envelope.payload.subject,
      request,
    });
    const context = envelope.payload.consultation_context;
    const ancestry = context?.ancestry_fingerprints ?? [fingerprint];
    if (context && ancestry.at(-1) !== fingerprint) {
      throw new DispatchRejectedError(
        "The consultation request does not match its ancestry fingerprint.",
      );
    }
    const maxDepth = Math.min(
      context?.max_depth ?? this.policy.maxDepth,
      this.policy.maxDepth,
    );
    const depth = context?.depth ?? 0;
    if (depth > maxDepth) {
      throw new DispatchRejectedError(
        "The consultation request exceeds the configured depth.",
      );
    }
    const createdAt = new Date(envelope.created_at_utc);
    const policyDeadline = new Date(
      createdAt.getTime() + this.policy.runTimeoutSeconds * 1000,
    );
    const expiresAt = envelope.expires_at_utc
      ? new Date(envelope.expires_at_utc)
      : policyDeadline;
    const deadline =
      expiresAt.getTime() < policyDeadline.getTime()
        ? expiresAt
        : policyDeadline;
    return this.database.ensureConsultationRun(
      ConsultationRunSchema.parse({
        schema_version: CONSULTATION_PROTOCOL_VERSION,
        request_message_id: envelope.message_id,
        conversation_id: envelope.conversation_id,
        root_request_id:
          context?.root_request_id ?? envelope.message_id,
        project: projectKey,
        state: "pending_child",
        round_count: 0,
        depth,
        max_rounds: this.policy.maxRounds,
        max_depth: maxDepth,
        ancestry_fingerprints: ancestry,
        deadline_at_utc: deadline.toISOString(),
        evidence: emptyEvidence(projectKey, now),
        version: 0,
        created_at_utc: now.toISOString(),
        updated_at_utc: now.toISOString(),
      }),
    ).run;
  }

  private async executeChild(
    run: ConsultationRun,
    claim: ClaimedInboxMessage,
    now: Date,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    if (run.round_count >= run.max_rounds) {
      this.fail(run, claim, "CONSULTATION_ROUND_LIMIT", now);
      return;
    }
    const timeoutSeconds = Math.max(
      1,
      Math.min(
        claim.envelope.payload.dispatch?.timeout_seconds ?? 300,
        Math.floor(
          (Date.parse(run.deadline_at_utc) - now.getTime()) / 1000,
        ),
      ),
    );
    const result = await this.executor.execute({
      projectPath: this.workingDirectory,
      executionBoundary: "evidence_only",
      prompt: buildEvidenceOnlyChildPrompt({
        subject: claim.envelope.payload.subject,
        request: claim.envelope.payload.body,
        priorDiscussion: "",
        evidence: run.evidence,
      }),
      timeoutSeconds,
      maxOutputBytes: this.policy.maxOutputBytes,
      ...(abortSignal ? { abortSignal } : {}),
    });
    const completedAt = this.operationTime(now);
    const child = parseEvidenceOnlyChildResult(
      result.output,
      run.evidence,
    );
    const nextRound = run.round_count + 1;
    if (child.outcome === "completed") {
      const completed = this.database.saveConsultationRun(
        {
          ...withoutTransientRequests(run),
          state: "completed",
          round_count: nextRound,
          final_answer: child.answer,
        },
        run.version,
        completedAt,
      );
      this.complete(completed, claim, completedAt);
      return;
    }

    const parked = this.database.saveConsultationRun(
      {
        ...withoutTransientRequests(run),
        state: child.requested_evidence
          ? "needs_information"
          : "waiting_peer",
        round_count: nextRound,
        ...(child.requested_evidence
          ? { requested_evidence: child.requested_evidence }
          : {}),
        ...(child.peer_request
          ? { peer_request: child.peer_request }
          : {}),
      },
      run.version,
      completedAt,
    );
    this.release(claim, parked.state, completedAt);
  }

  private collectLocalEvidence(
    run: ConsultationRun,
    claim: ClaimedInboxMessage,
    now: Date,
  ): void {
    const project = this.projects.get(run.project);
    if (!project || !run.requested_evidence?.length) {
      this.fail(run, claim, "CONSULTATION_EVIDENCE_INVALID", now);
      return;
    }
    const collected = this.evidenceProvider.collect({
      project: run.project,
      projectRoot: project.path,
      paths: run.requested_evidence,
      now,
    });
    const collectedAt = this.operationTime(now);
    const next = this.database.saveConsultationRun(
      {
        ...withoutTransientRequests(run),
        state: "pending_child",
        evidence: mergeEvidence(
          run.evidence,
          collected,
          collectedAt,
        ),
      },
      run.version,
      collectedAt,
    );
    this.release(claim, next.state, collectedAt);
  }

  private advancePeerWait(
    run: ConsultationRun,
    claim: ClaimedInboxMessage,
    now: Date,
  ): boolean {
    if (!run.peer_request) {
      this.fail(run, claim, "CONSULTATION_PEER_REQUEST_INVALID", now);
      return true;
    }
    if (!run.nested_task_id) {
      if (run.depth >= run.max_depth) {
        this.fail(run, claim, "CONSULTATION_DEPTH_LIMIT", now);
        return true;
      }
      const fingerprint = consultationRequestFingerprint({
        project: run.project,
        subject: run.peer_request.subject,
        request: run.peer_request.request,
      });
      if (run.ancestry_fingerprints.includes(fingerprint)) {
        this.fail(run, claim, "CONSULTATION_CYCLE_DETECTED", now);
        return true;
      }
      const nested = this.bridgeService.send({
        idempotencyKey: `consultation-peer:${run.request_message_id}:${run.round_count}`,
        kind: "task_request",
        streamId: "agent-coordination",
        correlationId: run.root_request_id,
        causationId: run.request_message_id,
        sequenceNumber: 0,
        expiresAtUtc: run.deadline_at_utc,
        now,
        payload: {
          project: run.project,
          subject: run.peer_request.subject,
          body: run.peer_request.request,
          evidence: [],
          dispatch: {
            executor: "codex_cli",
            access: "read_only",
            evidence_mode: "pinned_git",
          },
          coordination_request: {
            protocol_version: "1.0",
            intent: run.peer_request.intent,
            access_mode: "read_only",
          },
          consultation_context: {
            protocol_version: "1.0",
            root_request_id: run.root_request_id,
            parent_request_id: run.request_message_id,
            depth: run.depth + 1,
            max_depth: run.max_depth,
            ancestry_fingerprints: [
              ...run.ancestry_fingerprints,
              fingerprint,
            ],
          },
        },
      });
      const waiting = this.database.saveConsultationRun(
        {
          ...run,
          nested_task_id: nested.message_id,
          next_attempt_at_utc: addSeconds(
            now,
            this.policy.peerPollIntervalSeconds,
          ).toISOString(),
        },
        run.version,
        now,
      );
      this.release(claim, waiting.state, now);
      return true;
    }

    const reply = this.database.findInboxReplyTo(run.nested_task_id);
    if (!reply) {
      const waiting = this.database.saveConsultationRun(
        {
          ...run,
          next_attempt_at_utc: addSeconds(
            now,
            this.policy.peerPollIntervalSeconds,
          ).toISOString(),
        },
        run.version,
        now,
      );
      this.release(claim, waiting.state, now);
      return false;
    }
    const nested = this.database.getOutboxMessage(run.nested_task_id);
    if (
      !nested ||
      nested.envelope.kind !== "task_request" ||
      nested.envelope.stream_id !== "agent-coordination" ||
      reply.state === "quarantined" ||
      reply.envelope.origin_system !== this.peerSystemId ||
      reply.envelope.target_system !== this.systemId ||
      reply.envelope.stream_id !== "agent-coordination" ||
      reply.envelope.conversation_id !==
        nested.envelope.conversation_id ||
      reply.envelope.correlation_id !== run.root_request_id ||
      reply.envelope.payload.project !== run.project
    ) {
      this.fail(
        run,
        claim,
        "CONSULTATION_PEER_RESULT_INVALID",
        now,
      );
      return true;
    }
    if (
      reply.envelope.payload.coordination_result?.outcome !==
      "completed"
    ) {
      this.fail(run, claim, "CONSULTATION_PEER_FAILED", now);
      return true;
    }
    const item = peerEvidenceItem(reply.envelope);
    const next = this.database.saveConsultationRun(
      {
        ...withoutTransientRequests(run),
        state: "pending_child",
        evidence: mergeEvidence(
          run.evidence,
          EvidenceBundleSchema.parse({
            schema_version: EVIDENCE_SCHEMA_VERSION,
            project: run.project,
            generated_at_utc: now.toISOString(),
            total_bytes: item.byte_length,
            items: [item],
          }),
          now,
        ),
      },
      run.version,
      now,
    );
    this.release(claim, next.state, now);
    return true;
  }

  private complete(
    run: ConsultationRun,
    claim: ClaimedInboxMessage,
    now: Date,
  ): void {
    if (!run.final_answer) {
      throw new DispatchRejectedError(
        "The completed consultation has no final answer.",
      );
    }
    this.bridgeService.settleWithReply({
      originalMessageId: run.request_message_id,
      consumerId: this.consumerId,
      claimToken: claim.claimToken,
      outcome: "processed",
      idempotencyKey: `consultation-result:${run.request_message_id}`,
      kind: "task_result",
      now,
      payload: {
        project: run.project,
        subject: `Consultation completed: ${claim.envelope.payload.subject}`.slice(
          0,
          200,
        ),
        body: run.final_answer,
        evidence: [],
        coordination_result: {
          protocol_version: "1.0",
          request_message_id: run.request_message_id,
          outcome: "completed",
        },
      },
    });
  }

  private fail(
    run: ConsultationRun,
    claim: ClaimedInboxMessage,
    code: string,
    now: Date,
  ): void {
    const failed =
      run.state === "failed"
        ? run
        : this.database.saveConsultationRun(
            {
              ...withoutTransientRequests(run),
              state: "failed",
              error_code: code,
            },
            run.version,
            now,
          );
    this.settleFailure(failed, claim, now);
  }

  private settleFailure(
    run: ConsultationRun,
    claim: ClaimedInboxMessage,
    now: Date,
  ): void {
    this.bridgeService.settleWithReply({
      originalMessageId: run.request_message_id,
      consumerId: this.consumerId,
      claimToken: claim.claimToken,
      outcome: "rejected",
      idempotencyKey: `consultation-failure:${run.request_message_id}`,
      kind: "task_result",
      now,
      ...(run.error_code ? { reason: run.error_code } : {}),
      payload: {
        project: run.project,
        subject: `Consultation stopped: ${claim.envelope.payload.subject}`.slice(
          0,
          200,
        ),
        body:
          "The bounded consultation stopped at a configured safety limit or evidence boundary.",
        evidence: [],
        coordination_result: {
          protocol_version: "1.0",
          request_message_id: run.request_message_id,
          outcome: "rejected",
        },
      },
    });
  }

  private settleInitialFailure(
    claim: ClaimedInboxMessage,
    code: string,
    now: Date,
  ): void {
    this.bridgeService.settleWithReply({
      originalMessageId: claim.envelope.message_id,
      consumerId: this.consumerId,
      claimToken: claim.claimToken,
      outcome: "rejected",
      idempotencyKey: `consultation-failure:${claim.envelope.message_id}`,
      kind: "task_result",
      reason: code,
      now,
      payload: {
        subject: `Consultation stopped: ${claim.envelope.payload.subject}`.slice(
          0,
          200,
        ),
        body:
          "The bounded consultation stopped at a configured project or evidence boundary.",
        ...(claim.envelope.payload.project
          ? { project: claim.envelope.payload.project }
          : {}),
        evidence: [],
        coordination_result: {
          protocol_version: "1.0",
          request_message_id: claim.envelope.message_id,
          outcome: "rejected",
        },
      },
    });
  }

  private release(
    claim: ClaimedInboxMessage,
    reason: string,
    now: Date,
  ): void {
    this.database.acknowledge(
      claim.envelope.message_id,
      this.consumerId,
      claim.claimToken,
      "retry",
      reason,
      now,
    );
  }

  private operationTime(fallback: Date): Date {
    return this.clock?.() ?? fallback;
  }
}

function emptyEvidence(project: string, now: Date): EvidenceBundle {
  return EvidenceBundleSchema.parse({
    schema_version: EVIDENCE_SCHEMA_VERSION,
    project,
    generated_at_utc: now.toISOString(),
    total_bytes: 0,
    items: [],
  });
}

function mergeEvidence(
  existing: EvidenceBundle,
  added: EvidenceBundle,
  now: Date,
): EvidenceBundle {
  if (
    existing.git_snapshot &&
    added.git_snapshot &&
    existing.git_snapshot.revision !==
      added.git_snapshot.revision
  ) {
    throw new EvidencePolicyError(
      "Consultation evidence cannot mix Git revisions.",
    );
  }
  const gitSnapshot =
    added.git_snapshot ?? existing.git_snapshot;
  const items = new Map<string, EvidenceItem>();
  for (const item of [...existing.items, ...added.items]) {
    items.set(item.path.toLowerCase(), item);
  }
  const merged = [...items.values()];
  return EvidenceBundleSchema.parse({
    schema_version: EVIDENCE_SCHEMA_VERSION,
    project: existing.project,
    generated_at_utc: now.toISOString(),
    total_bytes: merged.reduce(
      (total, item) => total + item.byte_length,
      0,
    ),
    ...(gitSnapshot ? { git_snapshot: gitSnapshot } : {}),
    items: merged,
  });
}

function peerEvidenceItem(envelope: BridgeEnvelope): EvidenceItem {
  const content = envelope.payload.body;
  const bytes = Buffer.from(content, "utf8");
  return {
    path: `.bridge/peer-results/${envelope.message_id}.txt`,
    source: "peer_result",
    source_message_id: envelope.message_id,
    content,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byte_length: bytes.byteLength,
    modified_at_utc: envelope.created_at_utc,
  };
}

function withoutTransientRequests(
  run: ConsultationRun,
): Omit<
  ConsultationRun,
  | "requested_evidence"
  | "peer_request"
  | "nested_task_id"
  | "next_attempt_at_utc"
> {
  const {
    requested_evidence: _requestedEvidence,
    peer_request: _peerRequest,
    nested_task_id: _nestedTaskId,
    next_attempt_at_utc: _nextAttemptAtUtc,
    ...rest
  } = run;
  return rest;
}

function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

function requireDirectory(value: string): string {
  const resolved = fs.realpathSync.native(value);
  if (!fs.statSync(resolved).isDirectory()) {
    throw new DispatchRejectedError(
      "The consultation working directory is not accessible.",
    );
  }
  return resolved;
}
