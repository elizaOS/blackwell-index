# Private B200 qualification and stress report

Run against the existing local journal:

```sh
bun src/cli.ts shadow --output data/studies/b200-shadow.json
# Reproduce a fixed knowledge window with the same registry/methodology files:
bun src/cli.ts shadow --from EPOCH_MS --at EPOCH_MS --output data/studies/b200-window.json
```

The command performs SELECTs in one consistent read transaction. It does not initialize the journal, load the private identity, fetch providers, submit updates or enter orders. Stdout contains counts and readiness diagnostics. Full results are private, new-only mode-0600 files; an existing output is never overwritten. Keep these reports out of Git and public attachments.

The report contains:

- Production diagnostics for `SBX:B200`, recalculated from the latest archived signed reports known by the cutoff, excluding quarantined operators known at that time. Methodology and registry are the supplied current configuration, not reconstructed historical admission.
- A descriptive private capture curve, restricted to public on-demand exclusive B200 tariffs. It uses the current configured panel when present; otherwise it freezes the first observed economic-provider panel at equal research weights. Later providers cannot silently change those weights.
- Missing-constituent gaps, oldest eligible source age, expiry boundaries between capture cycles, economic-group dispersion, capture cadence, source evidence-link counts and the existing sustained-study result. Group dispersion is not the production engine's full propagated confidence bound.
- Separate source-removal, ±50% source-price, full-source-loss, mark-premium and simple-funding scenarios. Source removal reports the accidental reweighted price for comparison, but never uses that value for simulated positions.

`publishable` and `liveMarketQualified` are always false for this research artifact. `complete` means the bounded scan and signed-report reading completed without the detected anomalies; it does not mean qualified data, verified source rights, authenticated evidence bodies, successful trading or 30 days of operation. `candidatePrice` can exist when the dispersion gate blocks the research print; no position stress is calculated from a blocked print. The stress reference may be historical and is labeled with its timestamp; it is not the current oracle price.

Capture-cycle rows are combined, repeated commercial series are deduplicated, conflicting duplicates are flagged, and observations after the knowledge cutoff cannot enter the curve. An empty capture is a gap. Between captures only the last cycle can age; a new transport time never refreshes its observation time. An anomaly or truncated capture scan blocks the research curve rather than silently ignoring bad input. The report describes a retrospective window; it is not a strategy backtest.

The curve intentionally does not assert source-host authenticity, licensing or signed quorum. The production qualification result uses the original engine for those configured checks. Evidence-link existence in the operating study is not response-body hash verification. Source permissions and financial-reference rights require separate review.

## Bounds and verification

The command reuses the operating study's row/byte/observation limits, with at most 5,000 capture rows/cycles, and reads at most 1,000 latest signed reports totaling 16 MiB. Truncation is explicit. Narrow a large journal using `--from`; use `study --stream` for full-period operating aggregates. The shadow command supports the ordinary local SQLite journal, not direct hosted V2 frame input.

Cost path: read bounded capture headers → parse each bounded retained observation once through the operating study → group B200 points by capture → calculate fixed-panel prints → small stress matrix. No new dependencies, background process, network request or synthetic journal rows. Price arithmetic uses integer millionths; mark and source shocks round half up, simple funding truncates toward zero, and maintenance rounds up. Scenarios outside the decimal parser's supported range are explicitly unavailable. Risk values are illustrative and are documented in [the contract proposal](B200_CONTRACT_PROPOSAL.md).

Tests cover signed quorum and rights failures, separate model/composite readiness, exact long/short PnL, source loss, new-source isolation, expiry, empty captures, commercial-cohort filtering, corruption, truncation, knowledge cutoffs, deterministic replay and private read-only CLI execution.
