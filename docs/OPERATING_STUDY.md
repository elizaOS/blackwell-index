# Retained-data operating study

The operating study describes observations already retained in a node's local `captures` table. It does not request prices, modify journal records or schema, synthesize missing data, publish a feed, or approve source rights. Its output is private research data and may include account-specific prices.

As of September 6, 2026, the proposed study of at least 30 consecutive days has **not** been demonstrated. A successful real-source collection, a recovery drill, and tests containing 30-day timestamp ranges do not satisfy that requirement. See [validation requirements](VALIDATION.md).

## CLI

Run from the code checkout containing `src/cli.ts`; use `--dir` when the initialized node journal is elsewhere.

```sh
bun src/cli.ts study --dir /absolute/node/path
bun src/cli.ts study --dir /absolute/node/path --at 1788739200000 \
  --from 1788652800000 --output data/operating-study.json
```

The dated example selects a window; it does not assert that observations exist for those dates. `--at` and `--from` accept only positive, safe-integer epoch milliseconds, without decimal, exponent or whitespace notation. The expected cadence comes from the node configuration. Without `--at`, the cutoff is the current time.

The command prints a count-only summary. It never prints raw SKU records or prices to standard output. `--output` writes the full private report to a new mode-0600 JSON file; existing files are never overwritten. Relative output paths resolve inside `--dir`. New output directories are mode 0700, but already-existing directories are not changed. Keep report files outside publicly served paths.

Study uses a read-only SQLite connection, does not initialize a missing journal, and does not load the node's provider credential files, signer or Pyth manifest. It is available while the recovery review marker blocks serving and collection. Bun may independently load `.env` from its working directory before the CLI starts; use the code checkout and an appropriate process environment when isolating credentials.

Read-only describes database operations, not an absence of every filesystem change: SQLite may create or update WAL/SHM reader-coordination sidecars while opening a live journal. The study preserves journal records, schema, main-database permissions and private configuration files. It reads committed WAL data; it does not use SQLite's immutable mode, which is inappropriate for a journal that can still change.

## Interface

`operatingStudy(journalOrSqlDriver, options)` in `src/study.ts` runs synchronous read-only SQL queries in one driver transaction. It accepts an existing `Journal`, or its `SqlDriver`, and returns a JSON-serializable report. It does not open files, create tables, read credentials, or make network requests. The caller controls the database connection and whether the private report is displayed or saved.

Required option: `expectedIntervalMs`, the cadence being evaluated. Set it to the node's configured collection interval. Optional `asOf` pins the knowledge cutoff; its default is the current time. Optional `from` narrows the capture window; its default is the first retained capture at or before the cutoff. For reproducible comparisons, supply both bounds explicitly.

The report includes:

- Actual first and last retained capture times, selected-window bounds, first and last valid observation times, and observation-to-capture lag.
- Nominal cadence gaps, capture errors as counts, and source/model coverage counts.
- Per-SKU price records with capture identity, knowledge time, observation time, commercial terms, and source-evidence hashes.
- Schema failures, hardware mapping changes, contradictory prices at one observation timestamp, date regressions, expired observations, and tariffs not yet effective when observed.
- Exact-decimal first-to-last dated price change where the series has distinct observation times and no series-level blocking anomaly.
- Every applied analysis limit, incomplete scan, and clipped sample list.

Raw error messages, source URLs, source record identifiers, and credential files are not copied into the report. The report still contains potentially confidential SKU names, account scope and prices. Do not expose it on a public endpoint without a separate rights and privacy review.

## Interpretation

### Collection cadence

Cadence uses completed half-open time buckets anchored at `from`. With a five-minute interval, a capture in `[from, from + five minutes)` occupies the first bucket. Multiple captures in that bucket count once. The last unfinished bucket is not expected yet; a capture exactly at the study cutoff remains a retained observation but does not occupy a completed bucket beginning at that cutoff.

Empty buckets are reported as dated gaps, not filled with prices. This is a collection-scheduling diagnostic, not provider uptime, market availability, or the success rate of an individual adapter. Timer jitter near bucket boundaries can change occupancy. A node that captures only errors can have complete capture cadence and no usable price coverage. Coverage lists sources actually present; it does not invent an expected provider universe or identify independent economic owners.

When the capture-row limit is reached, cadence completeness is false and empty-bucket/gap totals are withheld. Unexamined captures are not mislabeled as outages. Malformed capture timestamps cannot be placed in any historical window; their global count is disclosed separately and prevents a complete analysis.

### Commercial terms and dated changes

A price series has a fixed provider, source, model, SKU, region, procurement class, price basis, tenancy, physical GPU count, included services, account scope, topology, minimum order, currency and unit. Different series are not averaged. In particular, spot, on-demand, executable, list, fractional and account-specific prices are not interchangeable.

Every point retains both `knownAt` (capture time) and `observedAt`. A later-arriving capture cannot contribute to an earlier cutoff, even if its tariff effective date or claimed observation time is older. An observation dated after its capture is excluded. Date regressions and future-effective or already-expired observations remain visible where applicable but block that series' drift calculation.

`firstToLastChangeBps` is `(last price - first price) / first price × 10,000`, rounded to four decimal basis points using integer arithmetic. It compares only retained endpoints of the same series. The actual elapsed knowledge and observation times are reported. It is not an annualized return, volatility estimate, trading profit, hedge effectiveness result, or continuous path between the endpoints. Repeated copies of the same observation timestamp do not create additional history. Any intervening gaps remain gaps.

Source-evidence linkage means a matching archive row existed with a receipt time no later than the capture. The study does not read and authenticate response bodies or prove that the provider supplied the recorded price. Recovery verification and independent source checks remain separate controls. Capture records also are not signed operator votes or evidence of quorum.

## Bounds and incomplete analysis

| Limit | Default | Maximum |
| --- | ---: | ---: |
| Capture rows selected | 10,000 | 100,000 |
| Observations examined | 50,000 | 100,000 |
| Cumulative decoded input bytes | 32 MiB | 256 MiB |
| One capture row's observations and errors | 4 MiB | 4 MiB |
| Distinct SKU/term series | 1,000 | 2,000 |
| Anomaly samples | 100 | 1,000 |
| Gap samples | 100 | 1,000 |

The query selects bounded row headers before retrieving payloads. An oversized row is not decoded; later bounded rows can still be examined. Metadata counts and bounds are SQL aggregates over the retained journal, so they can describe more history than the bounded payload scan. These limits bound decoded work and result size, not database query-planner time.

`completeness.dataScanComplete` describes whether the selected data could be fully examined. `completeness.complete` also requires untruncated sample detail. An analysis can completely scan its inputs and still discover invalid data; completeness does not certify data quality. Source/model counts and price summaries from a partial scan are partial results, not estimates of the omitted records. Raising limits or reviewing smaller dated windows can support further investigation; do not silently stitch overlapping windows or claim that omitted intervals passed validation.

## Work still required

1. Retain at least 30 consecutive days of genuine observations with documented cadence, source failures and corrections. Extend the period if coverage or hardware changes make it unrepresentative.
2. Establish data collection, derivation and redistribution rights for each intended use. Research access is not benchmark publication approval.
3. Review SKU mappings, physical GPU counts, commercial terms and provider economic ownership. Investigate missing models and contradictory observations.
4. Obtain any historical records through authorized sources. Preserve when records became available; do not synthesize backfill or use future membership and prices in historical decisions.
5. Compare retained snapshots against an independent calculation and validate failure behavior. This descriptive study does not replace the [validation plan](VALIDATION.md).
6. Design any later trading, financing or hedge experiment separately, with dated executable instruments, liquidity, costs and an explicit holdout methodology. No market weights or revenue forecasts are inferred from capture frequency.

`proposedThirtyDayStudy.qualification` deliberately remains `NOT_ESTABLISHED`. Calendar span and populated capture buckets are diagnostic observations, not automatic approval of a benchmark or completion of the operating-study gate.
