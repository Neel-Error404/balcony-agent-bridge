# [SYS-A] Core runtime/governance Git candidate

October 6, 2026. Owner authorized isolated assembly, review, staging and commit;
push, publication and deployment are excluded.

## Source and selection

Base: `fc876483b83ddebf16cc7ae5f3d3f437a845c63c`.
Isolated branch: `codex/river-core-governance-20261006`.
Local package: `0.3.1-core.1`, distinct from the broader uncommitted onboarding
candidate and public `0.3.0`.

The original dirty checkout is preserved. Core runtime, lifecycle, explicit
delegation/authorization, MCP input and cancellation/recovery fixes are
included with their test closure. Internal signed peer-check seams were
retained because bridge/envelope/database and signed workflow tests depend
on them; no peer-check CLI expansion is included.

Package-managed Codex `0.150.1` and its resolver are required for reproducible
real-binary initialization/entrypoint tests. Broader bootstrap, capability
preflight, readiness, onboarding verification, CLI changes, foundation lanes
and onboarding-release metadata were not copied. The original v0.3 onboarding
implementation remains the base, not a new setup feature.

A narrow local prerelease version identifies this different artifact. Historical
verification records retain their original dirty-candidate counts and hashes;
they are not evidence for this isolated tree. The candidate needs its own gates.

## Preparation failures and resolution

Initial offline install lacked cached packages; explicit project-local install
with run-owned D: temporary storage prepared dependencies. No global install or
credential/configuration copy was performed.

The first baseline foundation run failed 15 tests because the new checkout had
not been built. All failures were missing compiled foreground/MCP entrypoints.
Building unchanged base and repeating foundation passed 173 tests, one skip.

Fresh base production audit reported five flagged transitive packages, including
high and critical severity. The four compatible lockfile patches already
prepared with the core hardening were retained; a narrow compatible
`proxy-addr` lock update removed the remaining production finding. No force
upgrade or direct dependency-major change was used. Audit output is point-in-time
evidence, not proof of exploitability or universal security.

A compatible development-only `source-map-js` lock patch also removed a high
audit finding. Two moderate development-only Vitest/mocker findings remain.
The suggested `4.1.11` update failed in npm 10.9.2's peer resolver with
`Cannot read properties of null (reading 'edgesOut')`, both install and
lock-only. The known `4.1.10` pin was retained rather than bypassing peer
validation or taking a force upgrade. Production audit is zero; all-dependency
audit is not zero. These findings do not ship in the production dependency
set; reachability/exploitability was not established by this assembly task.

## Verification and review

The isolated candidate passed the ordered ladder:

| Level | Passed | Skipped |
| --- | ---: | ---: |
| Foundation | 189 | 1 |
| Component | 188 | 0 |
| Integration | 57 | 0 |
| Workflow | 7 | 0 |
| Recovery | 35 | 0 |
| Security | 68 | 0 |
| Total | **544** | **1** |

Its lower count than the original dirty candidate's 577 reflects excluded
onboarding/CLI verification tests, not a claim of equivalent setup coverage.
Baseline tests remain in place and core regression suites are retained.

Typecheck, build, MCP smoke (13 tools, successful status), PowerShell parse and
diff whitespace passed. Public-safety scan: 246 source files plus history,
zero findings at that checkpoint. No new broader tooling lane is included.

Scoped independent source review found no confirmed must-fix after checking
the isolated diff and dependency closure; reviewer did not rerun tests.
Original-checkout verification found all 114 recorded dirty-file hashes
unchanged, original HEAD/branch unchanged and no original staged paths.
Local logs and inventories remain machine-local.

Clean-cache installed-package verification passed in a disposable empty npm
project using a fresh isolated cache and run-owned D: temporary storage:

- Artifact `balcony-agent-bridge-0.3.1-core.1.tgz`
- SHA-1 `07d1b86f1dad79c1651540486ce497063e5f5790`
- Integrity `sha512-Uxx8nQfkgPYeyDMrIzOFIz5QBYcfgwz44R8sD4TLTZuDG30SsHOP0qUjrmuCWskpms3aHcdyTn4Mb5CjHp/eeg==`
- 152 files; 239,299 packed bytes; 1,175,205 unpacked bytes.

The prior offline consumer attempt lacked an uncached transitive types package
and failed explicitly; it was not counted as passing. Fresh-cache verification
used network package retrieval, then offline npm-exec for the installed CLI.
This is an installed consumer on the same host, not independent clean Windows
VMs, public registry publication or actual service deployment.

## Deployment boundary

Protocol `1.1` must not be sent to legacy receivers. Signed/legacy broker
traffic, pending work, per-node schema and trust configuration require a paired
operator decision. Actual WinSW and active authenticated executor termination,
restore/rollback, restart/replay and fresh source-backed causal answers both
ways remain unverified. No service or production database was changed.

Next: obtain separately bounded source transfer and two-host operator authority,
then qualify the real fleet using the immutable committed candidate.
