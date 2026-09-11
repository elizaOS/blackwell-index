# Transaction research

## Scope

This private, offline research lane implements the internal preparation from the September 10 weighting review. It does not change production methodology, provider weights, public endpoints or Pyth publication. No supplier records, credentials or invented market history are bundled. Synthetic records exist only in unit tests.

The first target is one B200 geography, bundle, topology and procurement cohort. Operators must explicitly configure these; no region, concentration threshold or winsorization parameter is presented as approved. Separate model feeds already exist in the production engine, so B200 research need not depend on all four families being available.

## Input and calculation

`src/transaction-research.ts` exports strict Zod schemas `TransactionRecord` and `ResearchConfig`. Generate integrations against these schemas rather than assuming an invoice format from an unconnected provider.

Each record represents one uniquely identified delivered service segment with its associated charges, not an entire invoice or an unbounded active-rental snapshot. The importer must allocate discounts, refunds and mandatory compute fees to that segment. Tax, support, unrelated storage and non-compute charges must be excluded upstream. Evidence states distinguish tariffs, offers, orders, delivered usage, invoices and payment. Invoice and payment states require documentary digests; these declarations are not cryptographic proof of a truthful invoice or completed bank transfer.

`dealId` must be normalized across resellers, providers and buyer submissions; `economicProvider` must use the reviewed ownership registry. The analyzer cannot infer common ownership or discover duplicate deals with unrelated IDs. All corrections retain the same deal and segment identifiers and increase revision. Corrections changing identity or interval boundaries require upstream reconciliation. Overlapping segments are rejected conservatively, including legitimate parallel allocations until given separate canonical allocation/deal IDs.

The most recent revision known at `asOf` is used. A record with the same revision twice fails closed. Future revisions are excluded. The entire delivered interval must fit inside the analysis window, and service must have ended before the record was recorded. Partial windows are excluded rather than silently prorated: request metered splits from the source. Do not represent bookings or expected future usage as delivered segments.

Quantity is exact integer GPU-milliseconds. VWAP is total net compute charges divided by delivered GPU-hours, using integer microdollars and round-half-up output. Candidate weighted median and winsorized VWAP operate on segment rates rounded to microdollars. Bounds use the generalized-inverse weighted empirical distribution. These are estimator comparisons, not approved production weights.

The report includes exclusion counts, concentration, effective provider count, coverage failures and leave-one-provider-out VWAP values. It deliberately omits buyer/deal identifiers. All values remain confidential and non-publishable. A coverage pass returns `RESEARCH_ONLY`, never production readiness. Coverage failures retain explicitly labeled candidate diagnostics for private analysis, never a public feed value.

Input/configuration hashes and the winsorization parameter bind each report to its private inputs. Hashes establish reproducibility, not source authenticity. Segment overlap checks sort intervals; leave-one-provider-out VWAP uses group totals rather than repeatedly sorting the full dataset.

Evaluation permissions are checked against the actual evaluation clock, independently of the historical `asOf` cutoff, and that clock is recorded in the report. Selecting an old observation window cannot revive an expired license. The library clock parameter exists for deterministic tests; the CLI always uses the current time.

## Running

Run `bun run research:transactions /absolute/private/records.json /absolute/private/config.json /absolute/private/new-report.json`.

The configuration file may contain an array of configurations for an offline historical study. Each window has an explicit `asOf`; cohort and estimator parameters must remain fixed and windows must be ordered and non-overlapping. Missing windows remain missing. The coverage result describes only supplied windows, not an assumed full calendar. This intentionally avoids invented history, look-ahead corrections, smoothing and list-price fallbacks. Use short metered segments for hourly studies; an unsplit monthly invoice cannot produce an hourly history.

Use an existing access-controlled directory, keep inputs mode 0600, and do not commit them. The command creates a new mode-0600 report and refuses to overwrite any existing file. It prints no prices or identifiers to stdout. Records are limited to 64 MiB and configuration to 1 MiB before parsing. Exit 0 means research gates passed; 2 means insufficient data or incorrect CLI usage; 1 means rejected input or output failure. The command performs no network calls, purchases, credential discovery or publication. Error output suppresses record contents and file paths.

Every source needs a current explicit evaluation permission entry with agreement ID and evidence digest. This is an operator-reviewed permission register, not automatic contract verification. Dashboard subscriptions may prohibit index validation; obtain specific rights. Do not import data before permission is established. The required permission covers retained historical use too; the code checks the permission at analysis time, not whether a lawyer has approved its scope.

## Internal acceptance checklist

- Implemented: strict evidence states, charge reconciliation, paid-allocation checks, revision/as-of handling, overlap rejection, duration weighting, cohort separation and evaluation permission gate.
- Implemented: private candidate VWAP/weighted median/winsorized comparison, coverage and concentration gates, leave-one-provider-out diagnostics, CLI and unit tests.
- Unchanged: production collector admission, provider/model weights, four-model composite and all publishing safeguards.
- Pending source samples: AWS CUR, Google billing export, Azure cost/price-sheet and provider invoice adapters. Mapping unidentified fields now would fabricate accounting assumptions.
- Pending licensed history: calibrated parameters, representative historical backtests, price/composition attribution and continuity studies. Unit tests do not qualify a benchmark.
- Pending independent evidence: ownership verification, buyer independence, invoice audit, payment reconciliation to bank records and manipulation review.
- Pending external approval: source agreements, audit, legal benchmark review, Pyth admission and independent operator qualification.

## Acquisition packet

For Ornn and Silicon Data request separate written quotes for evaluation, raw records, hourly values, historical retention, public display, onchain distribution and financial settlement. Request a schema, history inception, revision policy, contributor concentration, SLA and termination rights. Do not assume the ordinary subscription includes benchmark validation.

For AWS, Google Cloud, Azure and OCI ask the existing account owner for a GPU infrastructure specialist, commercial pricing owner and data-use counsel. Request customer price sheets plus usage/invoice exports separately from public catalog access. Specify exact GPU/system SKU, geography, bundle, tenancy, quantity, start date, procurement mode, term, discounts, mandatory fees, prepayment and quote expiry. A quote does not establish delivery or payment.

For direct providers, marketplaces and buyers request anonymized segment-level records and documentary reconciliation. Confirm upstream host rights and canonical IDs before integration. Use fixed service fees or reciprocal analytics proposals rather than paying for claimed volume. No outreach is sent by this implementation.
