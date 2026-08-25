# Public Release Boundary

Balcony Agent Bridge currently lives in a private operational repository. A
public release must be produced from a reviewed, secret-safe tree; changing the
visibility of the operational repository is not an acceptable shortcut.

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

## Public Source Export

A public source repository may contain the reusable implementation and its
tests, generic infrastructure templates, public examples, architecture and
security documentation, and contributor guidance.

The following operational records are private-only and must not be copied into
a public source export:

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

## Current Gate

The package remains marked `private` while release review continues. The owner
selected Apache-2.0 on 2026-08-25, and the package and source now carry that
license. This permits local tarball verification and prevents npm publication.
It does not prevent a Git repository or branch from being exposed. Creating the
public repository, changing visibility, pushing, and publishing to npm require
separate owner approval.

The automated safety check detects private-key blocks, common cloud and SaaS
token formats, credentialed URLs, Azure Service Bus and Storage connection
strings, bearer credentials, sensitive client-secret assignments, and
forbidden credential/database filenames. It is a release gate, not a proof
that no unknown secret format exists; manual review remains required.

## License Decision

The owner selected the Apache License 2.0 on 2026-08-25 because its explicit
patent grant gives infrastructure contributors and adopters clearer protection.
Publication remains separately owner-gated while the npm package is marked
`private`.
