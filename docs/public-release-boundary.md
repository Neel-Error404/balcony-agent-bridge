# Public Release Boundary

Balcony Agent Bridge is now in a public GitHub repository. The visibility
change occurred before the clean-export boundary below was reconciled. This
document therefore separates observed public state from the stricter boundary
required for a supported release; it does not retroactively describe the
current history as a clean export.

## npm Package

The npm artifact is a runtime distribution. Its allowlist is intentionally
small:

- compiled files under `dist/`;
- the two reviewed examples under `config/`;
- `package.json`;
- `README.md`;
- `SECURITY.md`;
- an owner-approved `LICENSE` and optional `NOTICE` when they exist.

Source, tests, infrastructure, service-installation scripts, environment
files, planning documents, handoffs, and verification evidence are not part of
the npm artifact. `npm run verify:package` enforces this boundary, and
`npm run smoke:package` installs the tarball in a temporary directory and
checks the installed CLI.

## Intended Public Source Export

A public source repository may contain the reusable implementation and its
tests, generic infrastructure templates, public examples, architecture and
security documentation, and contributor guidance.

The original release plan classified the following operational records as
private-only and excluded them from a clean public source export:

- `AGENTS.md` while it contains private vault or machine routing;
- `docs/handoff/`;
- `docs/verification/`;
- internal execution records under `docs/plans/`;
- `docs/costs.md` while it records a private deployment's current state;
- `docs/runbooks/sys-a-physical-host.md` while it records machine-specific
  operational state;
- machine-local configuration, rendered service definitions, databases, logs,
  and generated evidence;
- any real endpoint, IP address, tenant, client identifier, certificate path,
  repository path, username, or credential.

Generic installation and recovery scripts may be published only after their
defaults, examples, comments, and error text pass the public-safety review.

## History Requirement

Removing a private file from the branch tip does not remove it from Git
history. The first public repository must therefore be created from a reviewed
clean export or from explicitly sanitized history. Before publication, repeat
the current-tree and reachable-history secret scan against exactly the refs
that will become public.

A clean history is the default recommendation because it avoids carrying
private operational records into a repository that may later become public.

## Observed Public History

The repository became public with `AGENTS.md`, `docs/handoff/**`,
`docs/verification/**`, internal plans, and machine-oriented operational notes
still reachable. The current-tree and reachable-history safety scan reports no
known credential patterns, but that does not satisfy the planned privacy
boundary or prove that every operational detail was intended for publication.

Removing files from a later commit would not remove their earlier versions.
Before a supported release, the owner must explicitly choose one of these
paths:

1. accept the existing operational evidence as intentionally public after a
   dedicated privacy review and revise this boundary; or
2. create a reviewed clean export or sanitize history, understanding that this
   changes public Git history and requires a separately approved migration.

Phase 6 records this divergence but does not silently rewrite history.

## Current Gate

The source repository is public under Apache-2.0. The package remains marked
`private`, which permits local tarball verification and prevents npm
publication. No GitHub release, version tag, or npm package has been published.
The history decision, private vulnerability-reporting channel, supported
release, npm publication, Azure changes, and live deployment remain separate
owner-approved actions.

The automated safety check detects private-key blocks, common cloud and SaaS
token formats, credentialed URLs, Azure Service Bus and Storage connection
strings, bearer credentials, sensitive client-secret assignments, and
forbidden credential/database filenames. It is a release gate, not a proof
that no unknown secret format exists; manual review remains required.

## License Decision

The owner selected the Apache License 2.0 on 2026-08-25 because its explicit
patent grant gives infrastructure contributors and adopters clearer protection.
The public source is governed by that license. Package publication remains
separately owner-gated while the npm package is marked `private`.
