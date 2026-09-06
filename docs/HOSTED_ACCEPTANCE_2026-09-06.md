# Hosted recovery and operating-study acceptance

This record covers development-network software and real retained observations. It does not establish a published benchmark, independent-operator quorum, approved data rights or Pyth publication.

## Implementation verification

Revision `64c8796f24c760e7f829dd8bd6f1c1ac0603b4c8` added signed hosted export, encrypted recovery, the read-only operating study and disabled Prime Intellect support. Local verification passed 269 tests with 2,984 assertions, including the official Rust Pyth agent. Its [exact-revision workflow](https://github.com/elizaOS/blackwell-index/actions/runs/34044886097) passed Linux tests, Worker compilation, isolated workerd recovery, production image build and container lifecycle/recovery checks. The separate Pyth job exercised the actual pinned agent against a local test receiver, not production Pyth ingress.

The deployment used Worker version `1453aad5-af87-407c-9db3-23b97f5c9eed`. All 72 live checks passed, including six exact asset hashes and 60 denied private paths. Both original node identities survived. Each current collection had 64 real observations: Oracle 4, Azure 38 and Verda 22, covering all four models, with no source errors. All 49 public feed values remained unavailable, shared observations were zero, and the nodes represented one operator group.

An internal code review also fixed malformed storage domains, missing evidence references, interrupt cleanup, unsafe error disclosure, Cloudflare KV exclusion, and two ambiguous Prime Intellect hardware/SKU cases. Synthetic fixtures remain confined to tests. Prime Intellect was not contacted with an account or enabled for collection.

## Live recovery drill

The operator exported both hosted nodes through an authenticated private Cloudflare service binding. Each export was pinned to the deployed revision and its known public identity, verified locally, encrypted and restored into a new private directory.

| Check | Primary | Secondary |
| --- | --- | --- |
| Retained collection cycles | 89 | 89 |
| Reproduced snapshots | 89 | 89 |
| Verified normal-journal bytes | 12,632,064 | 12,632,064 |
| Original source response bodies | 6 | 6 |
| Evidence rows after import | 7, including signed export | 7, including signed export |
| Retained trusted published reports | 0 | 0 |
| Restore status | New identity, review required | New identity, review required |

These were unavailable development snapshots, not 89 qualified price observations. Exact reproduction confirms retained calculation/history consistency; it does not prove supplier truth or publication eligibility. The live hosted objects were not restored, reset or replaced. Recovery keys and bundles were mode 0600 and excluded from Git. Provider credentials and the old private signer were not included. The review marker blocked both `run` and `collect` on the primary restore; the normal restore policy disabled collectors, peers and Pyth on both restores.

Signed-export checkpoints:

- Primary: `bee5e07a5df35dd0b73e7564a45d5fb7b38fd275b4cfb9263f98d3c9c9dc8c40`.
- Secondary: `18607723e575f6ebb8030f79f21ff29deb0a715e053f829436be00809b5db0ba`.
- Primary snapshot 89 reproduced as `33bde0059d1b0e0ec66adccc3424e41972790a724bbcf8ba54fb38d22df729fa`.

This is local recovery from live hosted exports, not separate offsite custody or a host-loss exercise. The first transport emitted a Wrangler RPC-stub cleanup warning despite successful verification. A follow-up uses native private Fetcher bindings for both hops; verify its deployed revision and warning-free live acceptance separately.

### Native Fetcher follow-up

Revision `a32099203f23a0805a042486785fc2ed9f12dba9` deployed as Worker version `e383920c-ff1e-4431-804c-133cf85e74b2`. Its [exact-revision workflow](https://github.com/elizaOS/blackwell-index/actions/runs/34045350292) passed all jobs, including the native-Fetcher workerd drill and 14 public GET/POST export-denial requests. At 16:25 UTC, all 80 live checks passed, including 68 denied private paths. Both original identities and ongoing real collection were unchanged.

The native private export then succeeded for both live nodes with no RPC-stub warning. Each bundle reproduced 91 retained snapshots and materialized a 12,922,880-byte journal. Both isolated restores created new disabled identities, and both serving and collection were blocked by their review markers. The primary's complete private study examined 5,604 observations across 64 series with no configured anomalies or empty completed capture buckets at that cutoff. This extends the checkpoint evidence, not the benchmark qualification claim.

At 16:31 UTC, the extended verifier passed 88 checks against the same revision. Its 76 private-route probes included empty POST requests to the actual internal export paths on all four public hosts; each returned 404. Checking GET alone would not prove isolation of a POST-only export handler.

- Primary signed-export checkpoint: `ac3b538dbbc0f0ec8373c269d2397f10d42791191a244d52819dd73c867a8a01`.
- Secondary signed-export checkpoint: `23277c4285135fc222476af759514e58146a82227d265d634303d34df43d45a5`.

## First retained-data study

Each restored journal contained 5,476 real observations across 64 distinct source/SKU/commercial-term series. The private study scanned all retained observations without truncation, detected no configured anomalies, and found a retained evidence reference for every observation. The separate recovery verifier authenticated the evidence bodies; the study itself checks only links and receipt times.

The primary's retained span was about 7.38 hours. At each study's actual cutoff there were no empty completed cadence buckets. This is a short scheduling diagnostic, not provider uptime, market representativeness, price accuracy, liquidity, returns or hedge effectiveness. Verda began later in the retained history: Oracle and Azure appeared in 89 captures, Verda in 79. No missing data was filled or backdated. Thirty-day qualification remains `NOT_ESTABLISHED`.

## V2 implementation and capacity acceptance

The streaming implementation has passed local checkpoint, container, restore, CLI privacy and study checks. The actual-workerd fixture passed with 512 signed candidates at the exact 16 MiB candidate ceiling, a 700,031-byte evidence object split across two chunks, 1,100 observations in two storage batches, and 75 bounded blocks. It verified frozen mutable state, a byte-identical retry after object eviction, encrypted inspection/restore, unchanged source identity and counter changes only from the fixture's explicit mutation. No provider or external requests occurred. Runtime was 28,551 ms; this is a bounded workload result, not a per-isolate peak-memory measurement or account-plan guarantee.

The initial local full-period fixture completed build, export and independent inspection: 8,929 collection cycles, 571,456 captured observations, 26,787 reports from three fixture operators, and 8,929 snapshots. Reports contain twelve quotes each; raw captures contain 64. Changing evidence totaled 220,259,758 bytes. Source database size was 816,640,000 bytes and the encrypted archive was 1,205,313,732 bytes. All 8,929 snapshots were reproduced during independent inspection. A post-checkpoint collection remained on the source and was excluded from the checkpoint, including its counter increments.

The local export used 3,418 blocks with fourteen verified retries. Its encrypted archive SHA-256 was `f1b531a549d7902970c137f3c0f5e10612f86e9ba29ddf9160d013acb907456c`. Fresh-process peak RSS was 265,994,240 bytes for fixture generation, 379,158,528 for export and 227,573,760 for inspection, all under the explicit 384 MiB **local-process** budget. These numbers do not claim compliance with Cloudflare's separate isolate-memory ceiling. Membership bootstrap took 2,847.5 ms and checkpoint begin 182.8 ms on local SQLite; those are not Cloudflare CPU measurements.

The local full-period restore and final study subsequently passed. Restore peak RSS was 329,433,088 bytes and study peak RSS 191,578,112 bytes. All 8,929 snapshots were reproduced again during restore and independently from the restored read-only database; the study scanned all 571,456 observations across 64 series with no empty completed buckets. Frozen counter identities, values and snapshot head matched the checkpoint. All five phases finished in about 26.5 minutes on the shared local host. This remains isolated synthetic capacity data, not genuine operating history.

Revision `d18412a975eca6c1301d7462c5a772fc019d00d8` passed its [complete hosted workflow](https://github.com/elizaOS/blackwell-index/actions/runs/34048372462). Local verification passed 364 tests / 4,801 assertions. The Linux general job passed 363 tests with one conditional Rust-agent test skipped; its separate official-agent job passed all fourteen Pyth tests. Both actual-workerd recovery drills and the Docker build/lifecycle/restart/restore checks passed. The maximum-candidate workerd drill finished in 6,794 ms on that runner.

The exact-revision Linux capacity job independently passed the complete 31-day workload with network access disabled before fixture imports. It produced a 1,205,313,715-byte archive and reproduced all 8,929 snapshots during inspection, restore and read-only study. Fresh-process peak RSS was below the 384 MiB local-tool budget in every phase: 234,958,848 bytes for build, 326,578,176 for export, 266,518,528 for inspection, 268,881,920 for restore and 241,291,264 for study. The workload is three signing operators with twelve quotes per report and 64 raw observations per cycle; it does not establish retention at the registry's maximum operator count.

## V2 live acceptance

Revision `d18412a975eca6c1301d7462c5a772fc019d00d8` deployed as Worker version `bef79534-7c12-42d8-a44d-8e74aea9acd4`. All 104 live checks passed, including six asset hashes and 92 denied private GET/POST routes. Both original identities survived the membership migration. Each current cycle still contained 64 real observations with no source errors. Public feed values remained unavailable, readiness returned 503, and Pyth was not published.

Both live V2 archives were pinned to their known source identities and that release, encrypted, independently inspected and restored to fresh disabled nodes. Each contained 103 snapshots, 6,372 real observations, six evidence objects totaling 142,377 bytes and a frozen source counter of 103. Every snapshot reproduced; each restored identity differed from its source, collectors and peers were empty, Pyth was absent, and a real CLI `collect` attempt was rejected by the review marker.

| Live checkpoint | Encrypted bytes | Archive SHA-256 |
| --- | ---: | --- |
| Primary | 10,250,906 | `bf9dcfb9782e335aed6276147c3365c2ab1575d1a96403e35abbd99a4758cdb9` |
| Secondary | 10,250,908 | `bb9090b2b6ce7671666f4ce7c7205b21121ce79e17a0bfb6ec8c88818f505123` |

The primary descriptor hash was `07a362e1198c2011760f0dd82024c117aa5ef43dff604eee295a36c7d1df609e`; the secondary's was `c393c18864e09dcfdff7c8c36e608c917445a75a870f3018f90ca475cdf902ed`. Sealed staging was released after local inspection; source records were not deleted. The initial secondary transport logged three transient Cloudflare internal errors but completed all checks. A subsequent sequential export completed without error/warning markers and passed independent inspection. No cause for those transient service errors is asserted.

Both restored streaming studies scanned the complete 103-cycle journals without truncation. The primary covered about 8.55 hours, 64 source/SKU/commercial-term series and three sources; all 6,372 observations linked to retained evidence, no configured anomalies were detected and no completed cadence bucket was empty at the study cutoff. Oracle/Azure appeared in 103 cycles and Verda in 93. These are private descriptive findings, not provider uptime or benchmark qualification. No gaps were filled; thirty-day qualification remains `NOT_ESTABLISHED`.

## Remaining launch work

V1 keeps its original 8 MiB logical-export and whole-database limits. V2 removes that total-buffer dependency for the tested workload; it does not create unlimited retention. Confirm the account-specific storage/CPU allowance, monitor growth and existing report limits, implement local V2 re-backup before activating a restored node, and complete offsite/key-custody/host-loss operations. Do not delete evidence or counters to fit a cap. The [streaming recovery plan](STREAMING_RECOVERY_PLAN.md) retains these acceptance boundaries.

The [launch requirements](LAUNCH_TODO.md) remain open: source accounts and usage rights, Pyth publisher/feed admission and production readback, verified independent operators, approved source groups and weights, external review, sustained real history, offsite destination, separate key custody, paging and recovery ownership. See [hosted recovery](HOSTED_RECOVERY.md) and [operating-study limits](OPERATING_STUDY.md).
