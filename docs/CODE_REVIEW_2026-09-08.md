# Local code review — September 8, 2026

This review covers the combined B200/Pyth changes and the shared runtime they use. It prepares code for review; it does not approve source rights, a Pyth product, a production deployment or a market launch. Publication update, September 10: the owner authorized pushing review branches and opening PRs. The original local verification below remains a historical checkpoint.

## Findings addressed

- Collection rights now expire at the exact configured timestamp. Local and hosted collection use one execution path for rights, backoff and observation validation, with separate capture persistence and public error redaction.
- A malformed decimal now returns a schema-validation failure instead of throwing from `safeParse` and interrupting valid neighboring observations.
- Conflicting Vast rows with the same offer ID reject the response rather than selecting the first price. Identical repeated offers still deduplicate.
- Archive block parsing has one implementation; export validation and restore share one bounded fragment assembler. Checkpoint generation validates source rows and final transport size without cloning and decoding its own freshly constructed blocks. Consumers still verify hashes, framing, order, records and seals.
- Eighteen private types used only once were inlined. Meaningful shared and exported domain contracts remain named. Collection accepts collector IDs instead of an entire node configuration; unused SQL-alias parameters were removed.
- The HTTP and resolver harnesses reuse pinned-source helpers. Their default output directories are reusable names rather than historical review dates.
- Type checking now rejects unused locals and parameters. The standard test command targets the real test directories, excluding copied historical tests under ignored artifacts.
- CI actions are pinned to commit SHAs. A new job prepares the pinned official HIP-3 resolver, then runs offline calculation and actual loopback HTTP/refusal/lifecycle acceptance without a publisher or venue submission.
- `sharp` is overridden to 0.35.4 because Miniflare pins the affected 0.35.2 version. This is a tooling dependency; the lockfile includes the patched native packages. See [the upstream advisory](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c). Remove the override when the selected upstream tooling includes a patched compatible version.

## Design assessment

SBX should own compute-source normalization, commercial comparability, methodology, signed-input admission and reproducible evidence. Pyth should supply the agreed distribution and verification service. The local HTTP listener remains a narrowly scoped integration candidate; it is not represented as accepted managed ingestion or a native Pyth feed.

Database adapters, versioned recovery formats and distinct transport policies retain separate responsibilities. Similar syntax is not sufficient reason to combine interfaces with different trust, persistence or compatibility requirements. No new general-purpose framework is needed for Phase 0.

## Verification

Final receipts are kept in the operator's private review directory. They record exact source hashes, runtime versions, test outcomes and the fetched upstream revision. Earlier checkpoint reports remain historical, not current release assertions.

The review includes the Bun suite with the actual pinned local Pyth agent, strict TypeScript checks, actionlint, pinned official-resolver acceptance, the actual HTTP route and lifecycle cases, actual workerd private-export/recovery checks, Docker smoke tests, retained-source replay and cross-revision compatibility comparisons. The full 31-day synthetic recovery fixture has a 384 MiB per-process budget; failed attempts are retained alongside the final result rather than hidden or reclassified.

Credential-pattern scanning covers the tracked working tree and local commit blobs. It is a bounded automated check, not proof that every possible secret or vulnerability is absent. A clean review branch preserves the tested final tree without publishing intermediate local-history machine paths.

## Remaining release gates

- Pyth must confirm the delivery route, authentication, identifiers, freshness/unavailability behavior and acceptance environment.
- Source rights, comparable fixed constituents and independently controlled providers/operators require evidence and approval. Retained research currently does not establish those requirements.
- Genuine operating history and an accepted venue's complete price-consumption, outage and risk behavior remain necessary. Synthetic capacity is not 30 days of market history.
- Remote CI must verify the submitted revisions. Deployment and live-feed/venue acceptance remain separate from publishing review branches and PRs.
