# [SYS-A] Batch 5 Codex Bundle and Consultation Upgrade Plan

## Objective

Publish a source candidate that treats native Codex as a pinned two-file
Windows bundle and provides a fail-closed, reversible upgrade path from the
installed legacy dispatcher to consultation mode.

## Demonstrated Failures

1. The dispatcher installer copies and hashes `codex.exe` only. Codex 0.147.0
   expects `codex-code-mode-host.exe` beside it when `code_mode_host` is
   enabled.
2. Both installed dispatchers run in `legacy` mode, so requests without
   `dispatch.evidence_mode=pinned_git` cannot enter the consultation claim
   route.
3. SYS-A's loaded MCP server still comes from the pre-Batch-4 build and cannot
   submit `evidence_mode`.

## Source Changes

1. Add explicit companion executable path and SHA-256 configuration.
2. Require, copy, hash, and ACL both Codex executables during installation.
3. Validate both files again when the dispatcher constructs its executor.
4. Add an existing-service upgrade script that preserves `CODEX_HOME`, the
   project registry, bridge data, and Azure isolation; restarts only the
   dispatcher; and restores the previous configuration and binaries on
   failure.
5. Document consultation mode and MCP reload as distinct admission gates.

## Verification

Run each level independently in this order:

1. Foundation.
2. Component.
3. Integration.
4. Workflow.
5. Recovery.
6. Security.
7. Typecheck, production build, thirteen-tool MCP smoke, production audit,
   and exact diff review.

## Explicit Boundaries

- No service, runtime configuration, Codex MCP configuration, registry, DLQ,
  Azure, RBAC, network, or credential change.
- No staging, commit, push, deployment, installation, restart, replay, or
  settlement.
- The live clean `e90951e` bridge worktree remains untouched.
