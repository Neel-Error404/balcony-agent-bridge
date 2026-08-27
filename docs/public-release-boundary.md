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
still reachable. Before `v0.1.0`, the owner completed a dedicated review of the
current tree and reachable history and accepted those records as intentionally
public. The review found no live Azure tenant identifier, credential, private
key, connection string, access token, non-example Service Bus hostname, or
user-profile credential path. Public commit identities, generic machine paths,
synthetic endpoints, and operational message identifiers remain visible.

The accepted decision is to retain history. Rewriting it after publication
would break existing clones and references without retracting copies already
made. Reachable-history scanning remains a release gate, but it cannot prove
the absence of every unknown secret format. A future confirmed exposure must
be handled as an incident with credential revocation first; history rewriting
alone is not credential remediation. The dated review record is
`docs/verification/SYS-A-V0.1.0-HISTORY-PRIVACY-REVIEW-2026-08-26.md`.

## Current Gate

The source repository is public under Apache-2.0. Version `0.2.0` is approved
for a public npm package and GitHub release, the existing public history is
retained, and GitHub private vulnerability reporting is enabled. Azure and live
service changes remain separate reviewed operations even when they use the same
tagged source revision.

The automated safety check detects private-key blocks, common cloud and SaaS
token formats, credentialed URLs, Azure Service Bus and Storage connection
strings, bearer credentials, sensitive client-secret assignments, and
forbidden credential/database filenames. It is a release gate, not a proof
that no unknown secret format exists; manual review remains required.

## License Decision

The owner selected the Apache License 2.0 on 2026-08-25 because its explicit
patent grant gives infrastructure contributors and adopters clearer protection.
The public source is governed by that license. Public `0.2.0` npm publication
is approved but is not complete until the registry returns the released
version.
