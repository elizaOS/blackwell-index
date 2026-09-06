# Blackwell Index

Open source collectors and reproducible price feeds for NVIDIA B200, B300, GB200 and GB300 rental rates. The Blackwell Index (SBX) combines four model feeds using disclosed fixed weights. ALTX is the product website.

**Status: development network. Pyth publication is pending onboarding and feed approval.** Public pages never substitute generated prices. An unavailable feed has no current value.

## Run a node

Install [Bun](https://bun.sh) 1.3.14, then:

```sh
git clone https://github.com/elizaOS/blackwell-index.git
cd blackwell-index
bun install --frozen-lockfile
bun run setup
bun run collect
bun start
```

Open `http://127.0.0.1:3410`. Setup generates a random Ed25519 collector key, private local configuration and a persistent SQLite journal. Oracle, Azure and Verda public catalog collectors are enabled for local research. Source publication permissions, provider weights and trusted operator identities start unconfigured. That means real local collection can succeed while public prices remain unavailable.

List collectors with `bun src/cli.ts providers`. Enable selected collectors at setup:

```sh
bun src/cli.ts setup --dir ./operator-two \
  --providers oracle-public,azure-retail,lambda-cloud \
  --peers https://your-bootstrap-node.example
```

API keys belong in environment variables or a secret manager. `bun src/cli.ts credentials lambda-cloud` accepts a hidden terminal entry and writes private `data/credentials.json`, excluded from Git. JSON storage preserves special characters without shell expansion. An existing node-local `.env` is also supported. The provider documentation explains multi-field credentials and mappings. Never submit credentials to another node or commit local configuration.

Eleven collectors are implemented. Oracle, Azure and Verda have real public retrieval evidence; authenticated sources still require live account verification. [Prime Intellect](docs/PRIME_INTELLECT.md) is registered but disabled, with no approved collection or publication rights. Its supported account-specific B200/B300 quotes are outside the public-list cohort; GB200/GB300 remain discovery-only.

Anyone can run a node, select sources, submit signed reports and independently reproduce calculations. A new identity joins as a candidate. It does not gain benchmark voting power by creating additional keys. Source approval and verified operator independence live in an explicit registry. Operators can use their own registry; its hash is published with every snapshot. This is an open collector network with governed admission to the benchmark, not permissionless Pyth publisher admission.

## Feeds

| Output | Meaning |
| --- | --- |
| `SBX:<provider>:<model>` | Comparable prices collected from that provider, with independent collector agreement |
| `SBX:B200`, `SBX:B300`, `SBX:GB200`, `SBX:GB300` | Fixed-weight averages of configured independent provider groups |
| `SBX` | Fixed-weight average of all four model feeds |

The current default registry defines 49 feed slots: 44 provider/model combinations, four model feeds and one composite. These are output definitions, not 49 available prices or evidence of 11 independent supply groups. Existing local registries are not silently migrated.

The draft cohort is global, public, on-demand, exclusive-instance list pricing in USD per physical GPU-hour. Dividing an instance tariff by GPU count includes the bundled host services. It does not measure GPU-only hardware price, performance-equivalent compute, or guaranteed available capacity. Spot, reservations, scheduled capacity, account-specific rates and fractional tenancy are retained separately and excluded from this cohort.

Each matched SKU needs reports from at least the configured minimum independent operator groups and more than two-thirds of all admitted operator groups. Repeated keys, scraped copies and upstream resellers do not create additional economic weight. Within a provider, SKU prices are summarized within regions and then across regions. Model weights refer to provider economic groups, not node counts, advertised fleet size or listing count. All fixed-weight constituents must be present. The four model weights initially equal 25% each as a research choice. Production provider weights remain unset until evidence is available.

Read the [methodology](docs/METHODOLOGY.md), [source research](docs/PROVIDERS.md), [security model](docs/SECURITY.md), and [implementation plan](docs/IMPLEMENTATION_PLAN.md).

## API

| Endpoint | Purpose |
| --- | --- |
| `GET /healthz` | Process liveness |
| `GET /v1/ready` | Benchmark publication readiness; 503 when unavailable |
| `GET /v1/status` | Node identity, configuration hashes and local counts |
| `GET /v1/feeds` | Provider feeds, four model feeds, SBX and reasons for missing values |
| `GET /v1/feeds/SBX` | One feed; 503 when it has no current price |
| `GET /v1/methodology` | Versioned calculation rules |
| `GET /v1/registry` | Provider and admitted operator registry |
| `POST /v1/join`, `POST /v1/reports` | Signed batch submission |
| `GET /v1/reports` | Currently shareable admitted reports |
| `GET /v1/history?after=0&limit=100` | Explicitly paginated snapshot history |

Collector signatures bind exact bytes to keys. They do not prove that a provider really returned the claimed value. Independent collection, source checks, governance, retained raw responses and supplier participation address that separate problem. Public peer URLs are explicitly configured; candidate-supplied destinations are never fetched automatically.

## Pyth

The adapter targets the current official `pyth-lazer-agent` 0.16.0. It prepares signed-agent submissions only for approved feed bindings, exact units and current data. Pyth Core migrated to Pro infrastructure in August 2026; the old Pythnet validator workflow is not the deployment plan.

No SBX feed IDs, publisher credentials or Pyth approvals are bundled. Pyth acceptance is required for each publisher and feed. A local agent acknowledgement is labeled `QUEUED_LOCAL`; it is not proof of a published oracle. See [Pyth architecture, setup and readback requirements](docs/PYTH.md).

The separate [authenticated readback monitor](docs/PYTH_READBACK.md) checks approved Pro feeds against retained local snapshots. It uses a backend `PYTH_PRO_API_KEY`, a private state database and the node's approved Pyth manifest. The supplied configuration is disabled; its example thresholds require review. No signed payload or chain transaction is verified by this offchain monitor.

```sh
bun run pyth:readback --dir /absolute/private/node \
  --node-config config/node.local.json --config config/pyth-readback.json \
  --state data/pyth-readback.sqlite --init-state --once
```

Use `--init-state` only for a reviewed first bootstrap; omit it on restart to preserve accepted timestamps and retry deadlines. Omit `--once` for an abortable continuous monitor under an operator-owned supervisor. See [Pyth recovery](docs/PYTH_RECOVERY.md) before restoring any publishing node; collector identity rotation alone does not revoke the previous Pyth publisher.

The first chain target is **Base Sepolia, followed by Base mainnet**. Solana and Robinhood Chain follow with separate verification tests. [Chain selection and implementation gates](docs/PYTH_CHAIN_SELECTION.md) distinguishes supported Pyth contracts from an actual SBX integration; no SBX transaction has been verified yet.

`bun run pyth:chain-preflight` checks Base Sepolia's network and Pyth deployment through its fixed public RPC; add `--network base` for Base mainnet. It requires no credentials or gas, submits no transactions and does not verify any price or signed payload. A passed deployment check is not oracle readiness.

A self-hosted node can set `pythManifestPath` in its private configuration to attempt publication after each eligible collection cycle. The runtime checks current feed metadata, keeps durable per-feed timestamps, and connects to a separately running local Pyth agent. Hosted collector nodes do not hold Pyth signing keys.

## Verification

```sh
bun run verify
```

The suite checks exact arithmetic, all four models, fixed-weight missing-data behavior, quorum and duplicate identities, signed report validation, replay after restart, retained evidence, API failures and public UI behavior. Three real local HTTP node instances exchange signed test reports and reproduce the same snapshot. Test values are isolated to test files.

The additional protocol conformance test uses the actual official Rust Pyth agent:

```sh
cargo install pyth-lazer-agent --version 0.16.0 --locked
PYTH_AGENT_BIN="$(command -v pyth-lazer-agent)" bun test test/pyth.test.ts
```

That test verifies the agent's real encoded transaction and signature against a local test receiver. It does not connect to Pyth production. [Validation and experiment plan](docs/VALIDATION.md).

## Deployment and remaining setup

The repository includes a container deployment and a Cloudflare node deployment. Separate nodes in the same account belong to one operator group. Independent operators and distinct source organizations must be established before claiming production decentralization.

Initialize the persistent container volume before its first start:

```sh
docker compose build
docker compose run --rm node setup --dir /var/lib/sbx --host 0.0.0.0
docker compose up -d
```

The published port binds to localhost; use an HTTPS reverse proxy for public peer access. Repeat setup only for a new volume. Collector identities and replay state must survive container upgrades. See [Cloudflare deployment](docs/CLOUDFLARE.md) for managed durable nodes and domain routing.

Self-hosted nodes support encrypted V1 journal backups and verified restoration into a new, disabled identity. [Streaming recovery](docs/STREAMING_RECOVERY.md) adds bounded V2 checkpoint export through a private Cloudflare service binding, encryption, inspection and chunk-aware restore. Recovered local nodes use `backup-stream` for subsequent backups, preserving previous recovery receipts without modifying the running journal. The [original hosted V1 format](docs/HOSTED_RECOVERY.md) retains its 8 MiB limit. Restore never resumes an old signer, copies provider credentials or replaces a live Durable Object. Offsite custody, recurring backups and a host-loss exercise remain operating requirements; check the exact [acceptance evidence](docs/HOSTED_ACCEPTANCE_2026-09-06.md).

The [retained-data operating study](docs/OPERATING_STUDY.md) analyzes private captured observations without fetching prices or filling gaps. `study --stream` supports full-period aggregates without retaining point arrays. It reports coverage, cadence and dated changes, not trading returns or benchmark approval. Thirty-day qualification remains `NOT_ESTABLISHED`; parser tests and calendar span do not complete that gate.

The [launch checklist](docs/LAUNCH_TODO.md) names the required accounts, source permissions, Pyth onboarding, external verification and operating evidence. [Domain status](docs/DOMAIN_STATUS.md) records the four requested registrations. Private keys, raw account data and private business documents are not included in this repository.

Live development sites: [Blackwell Index](https://blackwellindex.com) and [ALTX](https://altx.exchange). See the [initial release evidence](docs/RELEASE_2026-09-06.md), [provider and recovery expansion](docs/EXPANSION_2026-09-06.md) and [operating costs](docs/OPERATING_COSTS.md). The deployed nodes collect real data but do not publish prices while the launch requirements remain unmet.

After deployment, verify the committed source, both nodes and the explicitly unavailable public feeds:

```sh
bun scripts/verify-deployment.ts --release <deployed-40-character-commit-SHA>
```

This read-only check targets the development-network contract, not a production benchmark. It must be revised when an approved public feed is deliberately launched.

MIT licensed. Contributions should include official source documentation, exact unit/model mapping and tests covering missing, changed and invalid responses.
