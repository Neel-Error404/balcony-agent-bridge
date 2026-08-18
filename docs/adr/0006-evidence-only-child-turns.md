# ADR 0006: Evidence-Only Child Turns

## Status

Phase 1 is implemented in a detached SYS-B candidate worktree and is consumed
by the Phase 2 coordinator described in ADR 0007. Neither phase is installed
or deployed.

## Decision

Project files must cross into an autonomous child turn through a strict local
evidence provider. The child receives a versioned evidence bundle, not a
project root or machine-local path.

The provider:

- accepts only explicit canonical relative paths under one allowlisted root;
- rejects traversal, absolute and drive-relative paths, symbolic links, and
  reparse-point components;
- accepts only approved UTF-8 text extensions and regular files;
- enforces file-count, per-file, and aggregate byte limits;
- rejects binary and credential-shaped content;
- records modification time, byte length, and a SHA-256 content digest;
- optionally enforces a caller-supplied maximum evidence age; and
- verifies that a file did not change while it was read.

The evidence bundle schema independently verifies item hashes, byte lengths,
aggregate size, and unique paths.

The child-turn contract has two terminal outcomes:

- `completed`, with a bounded answer and citations limited to supplied paths;
- `needs_information`, with a reason and canonical relative paths requested
  from the parent coordinator.

Child output must be one strict JSON object. The parent rejects invalid JSON,
unknown citations, secret-bearing output, and any schema mismatch.

## Security Boundary

The prompt tells the child not to use shell, filesystem, network, or retrieval
tools and treats all request, discussion, and evidence text as untrusted data.
This instruction is part of the child contract, not an operating-system
containment claim.

The current production dispatcher still launches Codex in the allowlisted
project root under the read-only sandbox. Phase 1 does not change that runtime
and therefore does not yet prove that the child lacks direct shell-based read
access. Production acceptance requires Phase 2 to route coordination through
the provider, use a neutral execution directory, and prove the executor cannot
retrieve project material outside the supplied bundle.

## Next Gate

ADR 0007 resolves the durable parent-coordinator design. Production acceptance
still requires foreground integration, executor-containment proof, and the
separate release and deployment gates.
