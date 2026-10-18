# [SYS-A] Native install resolution and fresh source qualification

October 14, 2026. Working candidate based on pushed
`080eea8f2e5b6698a0aa7ac5f80553b4794bf4e8`, branch
`codex/river-paired-runtime-20261007`. The correction below is **local,
uncommitted and unpublished**; no new release revision or deployed runtime is
claimed.

October 18 continuation: the complete ordered ladder was rerun on the same
correction and again passed 595 application tests / one skip, plus 18 tooling
tests, ordinary installation, typecheck/build, MCP smoke and the safety scan.
The owner authorized committing these three reviewed files on a separate
review branch and opening a draft PR against the pilot checkpoint. Plugin
review, merge and paired acceptance are distinct gates; this note does not
claim that any of them has completed.

## Reproduced cause and smallest correction

The exact `better-sqlite3@13.0.3` archive contains native prebuilds and declares
`gypfile: false`. Its root lockfile entry omitted that declaration. npm 10.9.2
loads the locked entry as the package's installation metadata, so the omitted
value allowed npm's implicit node-gyp invocation. That unnecessary build path
then required the missing Windows SDK.

A disposable fixture containing the same locked native package and
`node-addon-api` reproduced ordinary `npm ci` failure (`MSB8036`, exit 1).
Adding only `gypfile: false` to the fixture's native lock entry made the same
ordinary command succeed, with scripts enabled and SQLite `3.53.4` loadable.
Package version, resolved archive and SHA-512 integrity were identical.

The repository correction is the same one-line declaration in
`package-lock.json`. A new foundation regression was observed red before that
change and green after it. Ordinary repository `npm ci` subsequently passed,
without `--ignore-scripts`, command shims, registry edits, an SDK installation
or changes to Node/npm defaults.

This supersedes the installation-block judgment for the **corrected working
candidate**, not the previously published `080eea8...` source. Independent
read-only review confirmed the npm metadata path, upstream archive integrity
and the narrow correction.

## Corrected host diagnosis

The MSVC compiler, linker and headers are present. The prior MSVC selection
error came from a diagnostic registry-disabling flag; it did not demonstrate
an absent compiler. Windows SDK headers/libraries remain absent.

No machine-wide repair was performed. No SDK files, Visual Studio components,
system defaults, service settings, production databases, signing identities
or authentication state were changed.

## Fresh ordered verification

Windows x64 Node **22.14.0**, npm **10.9.2**. Disposable test state used an
explicit project-owned temporary directory.

| Gate | Result |
| --- | --- |
| Ordinary `npm ci` | Passed, scripts enabled |
| Typecheck / build | Passed |
| Foundation | 191 passed, 1 skipped |
| Component | 203 passed |
| Integration | 59 passed |
| Workflow | 7 passed |
| Recovery | 64 passed |
| Security | 71 passed |
| Application total | **595 passed, 1 skipped** |
| MCP smoke | 13 tools, status successful |
| Bundle tooling | 18 passed |
| Public-safety scan | Zero findings |
| Production dependency audit | Zero findings |
| All-dependency audit | Two moderate development findings |

Recovery's effective printed command was the ordinary recovery suite; its
64-test pass is not a production service rehearsal. Integration includes
isolated unauthenticated worker initialization; no authenticated model task
or paired twelve-launch pilot was performed.

Logs and the minimal two-fixture comparison stay in project-owned, ignored
`tmp/npm-gyp-metadata-20261014`. Original development checkout: all 114 dirty
file hashes preserved. Operating checkout: clean and unchanged.

## Maintenance and delivery gate

Lockfile regeneration may discard npm's nonserialized `gypfile` metadata.
The new regression deliberately catches that loss. After any regeneration,
verify the pinned archive still declares the opt-out and preserve it before
rerunning ordinary `npm ci`; do not silently disable every install script.

The correction and evidence require a **new reviewed Git revision** before
SYS-B can obtain and independently qualify them. Do not tell SYS-B that
`080eea8...` now contains this fix or ask it to build a guessed revision.

SYS-B receipt of the prior delivery notice remains unverified. A successful
SYS-A ladder is not both-host byte equality, signing, service activation,
causal answer acceptance or 80% maturity. After the new source is delivered
and both hosts qualify it, retain the existing gates for one immutable bundle,
same-archive transfer, unique-ID rehearsal and separately approved paired
activation/rollback. No automatic model-budget replenishment or new project
grant follows from this repair.
