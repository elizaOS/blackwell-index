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

## First retained-data study

Each restored journal contained 5,476 real observations across 64 distinct source/SKU/commercial-term series. The private study scanned all retained observations without truncation, detected no configured anomalies, and found a retained evidence reference for every observation. The separate recovery verifier authenticated the evidence bodies; the study itself checks only links and receipt times.

The primary's retained span was about 7.38 hours. At each study's actual cutoff there were no empty completed cadence buckets. This is a short scheduling diagnostic, not provider uptime, market representativeness, price accuracy, liquidity, returns or hedge effectiveness. Verda began later in the retained history: Oracle and Azure appeared in 89 captures, Verda in 79. No missing data was filled or backdated. Thirty-day qualification remains `NOT_ESTABLISHED`.

## Outstanding requirements

The primary signed logical export was 6,600,693 bytes against an 8,388,608-byte cap. Larger-journal streaming/archive support is an immediate capacity task, not an optional long-term enhancement. Do not delete retained evidence or counters to fit the cap. No sustained recovery capacity is claimed.

The [launch requirements](LAUNCH_TODO.md) remain open: source accounts and usage rights, Pyth publisher/feed admission and production readback, verified independent operators, approved source groups and weights, external review, sustained real history, offsite destination, separate key custody, paging and recovery ownership. See [hosted recovery](HOSTED_RECOVERY.md) and [operating-study limits](OPERATING_STUDY.md).
