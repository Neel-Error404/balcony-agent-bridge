# [SYS-A] MCP dependency security revision

October 6, 2026. Owner-approved dependency review, isolated remediation,
tests, commit and branch push only. No merge, npm publication or deployment.

## Baseline and finding

Previous reviewed source:
`cef068a69904ed7e9e70162c6ef296c4c5cae893`, package `0.3.1-core.1`.
That branch and commit remain unchanged.

SYS-B qualified that exact source with 544 application passes and one skip,
but its fresh audit reported a high production SDK advisory. SYS-A verified
receipt of report `80db1d52-38a3-4062-9a4d-2fca05ca074c` and independently
reproduced the audit finding before changing dependencies.

Advisory: `GHSA-6qxp-vccf-f47h`, MCP OAuth credential routing.
The maintainer advisory reports affected SDK versions 1.12.0–1.30.1 and
patched 1.x versions beginning 1.31.0. Fresh registry audit recommends 1.32.1.
This revision pins **exactly `@modelcontextprotocol/sdk@1.32.1`**.

Primary source:
`https://github.com/advisories/GHSA-6qxp-vccf-f47h`.

## Reachability and regression scope

The project's supported MCP server and clients use stdio; source/scripts
inspection found no remote OAuth client/provider, HTTP/SSE client or `withOAuth`
flow. The maintainer advisory explicitly lists MCP servers and stdio clients
as unaffected. Thus the audit finding is a dependency-release gate, not proof
that this project's supported runtime disclosed credentials.

The added test exercises the dependency's public `auth()` seam with injected
fetch, synthetic client/refresh credentials, and reserved `.test` issuers.
No real credentials, paid models, local auth files or external requests are
used. With old SDK 1.30.0 the negative regression observed forwarded credentials
and failed. With 1.32.1 it passed; a positive trusted-issuer refresh also passed.
A third test independently checks foreign refresh tokens with public client
information. These tests do not add OAuth functionality to Agent River.

The upstream fix does not make every possible OAuth integration safe.
Credentials saved before issuer-binding may need clearing or explicit issuer
attribution; bundled providers require configured expected issuer; custom
providers must preserve saved issuer metadata. Those are advisory caveats, not
instructions to edit the machine's existing Codex auth. No such affected
integration was found in this project's supported code.

## Changes and identity

Security branch: `codex/river-mcp-security-20261006`.
Candidate metadata: `0.3.1-core.2`, so it is not confused with the prior artifact.
Package/lock/MCP version/CLI assertion agree. The only runtime dependency change
is the exact SDK package and its integrity; no unrelated transitive updates or
application refactor is included.

The previous core branch remains at its reviewed commit; original dirty
checkout and operating runtime must remain untouched. A new commit and artifact
identity are required for SYS-B verification, not reuse of the old 544-test
snapshot.

## Verification

Red/green issuer tests passed (three cases) and exact `npm ci` succeeded.
The full ordered ladder passed:

| Level | Passed | Skipped |
| --- | ---: | ---: |
| Foundation | 189 | 1 |
| Component | 188 | 0 |
| Integration | 57 | 0 |
| Workflow | 7 | 0 |
| Recovery | 35 | 0 |
| Security | 71 | 0 |
| Total | **547** | **1** |

Typecheck, build and compiled stdio MCP smoke passed (13 tools, successful
status). The security count includes the three synthetic issuer checks; it
does not establish a real OAuth deployment, WinSW or paid model execution.
Machine-local logs:
`tmp/mcp-security-20261006` beneath the original development checkout.

Fresh post-install production audit reported zero findings; all-dependency
audit still reports two moderate development-only Vitest/mocker findings.
These audit results are dated snapshots, not claims of universal security.

Clean-cache installed-package verification passed in a disposable empty npm
project with fresh isolated cache and run-owned D: temporary storage:

- `balcony-agent-bridge-0.3.1-core.2.tgz`
- SHA-1 `c24c7dec3e19ec410a31972afb6b16bffaba326d`
- Integrity `sha512-a2kwgVrKvlFvoKFDC6gZ9NXQmdCwBA/ubInsKVqSIqOPt87ueilKb9bEw6gpLZiMr0a5v/12hc3QhM2UcS8/Ew==`
- 152 files; 239,298 packed bytes; 1,175,206 unpacked bytes.

This artifact is not npm publication or byte-equivalent two-host acceptance.
Source review found no confirmed must-fix; reviewer did not rerun tests.
Original 114 dirty-source hashes remain unchanged, and the operating checkout
remains clean at its original revision. No service or credential action occurred.

## Next gate

SYS-B must obtain the exact new branch revision in its isolated review checkout,
review this narrow diff, repeat verification and report its own fresh audit.
No old operating checkout should be pulled/replaced or activated by implication.
Paired signing/schema/backlog decisions, backup/restoration, operator access,
real authenticated worker/service interruption and causal bilateral task proof
remain required before deployment. The 80% maturity goal is not achieved.
