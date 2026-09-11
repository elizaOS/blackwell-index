# Transaction data intake

Complete one private copy per source. This checklist is not a grant of permission. Do not put customer identities, invoices, agreement text or credentials in the public repository.

## Commercial review

- Source and legal entity:
- Economic provider and upstream host:
- Existing account owner and introduction route:
- Provider commercial contact, billing engineering contact and legal contact:
- Dataset requested: model, geography, bundle, tenancy, procurement mode:
- Evidence offered: order / delivered usage / invoice / paid allocation:
- First available date, cadence, latency and revision window:
- Historical and ongoing delivery mechanism:
- Evaluation and benchmark-validation rights, agreement ID and evidence digest:
- Public derived-index / API / oracle / financial-reference rights, separately:
- Retention, audit, correction, termination and downstream rights:
- Upstream consents and customer disclosure restrictions:
- Setup, history, recurring license, usage/notional fees and minimum guarantees:
- Security and legal reviewer; approval date; expiry and renewal owner:

An API key, dashboard subscription or ordinary purchase agreement is not approval. Leave permission absent until its scope has been reviewed. Do not pay incentives according to submitted prices or purported transaction volume.

## Sample acceptance

- [ ] Schema and units are documented; source IDs are stable.
- [ ] Physical GPU count and system SKU are verified; Grace systems are not duplicated as standalone B-series rentals.
- [ ] Commercial terms distinguish on-demand, interruptible, reserved and future capacity.
- [ ] Bundled components, compulsory fees and excluded charges are explicit.
- [ ] Service segments identify actual start/end timestamps and meter duration.
- [ ] Net compute charges reconcile to gross less discounts/refunds plus mandatory compute fees.
- [ ] Shared invoice/commitment discounts have an approved segment-allocation policy.
- [ ] Documentary invoice evidence is matched; paid claims reconcile to allocated receipts.
- [ ] Canonical deal/allocation IDs deduplicate provider, marketplace and customer reports.
- [ ] Provider ownership, related buyers and affiliated transactions are reviewed independently.
- [ ] Corrections use increasing revisions; cancellation/refund effects are retained.
- [ ] Source completeness can be checked; selective omission and late reporting are monitored.
- [ ] Input access, retention and logs meet contractual confidentiality requirements.

## Mapping acceptance

Record the source column corresponding to every `TransactionRecord` field. Explicitly document each transformation rather than guessing:

| Transformation | Required decision |
| --- | --- |
| Instance time to GPU time | Verified physical count; distinguish GPU-hours from instance-hours |
| Commitments | Separate cohort; approved amortization method, never silently treat as on-demand |
| Currency | Current implementation accepts USD only; other currencies require a licensed FX specification |
| Discounts and credits | Classify contractual discounts separately from promotional credits and refunds |
| Partial windows | Metered split and charge allocation required; no automatic proration |
| Payment | Invoice allocation and receipt evidence, not account balance or payment initiation |
| Correction | Stable segment identity and explicit revision; retain original evidence |

## Launch decision

Record the reviewer, evidence, decision and remaining conditions for: evaluation intake; historical qualification; source admission; publication; financial-reference use. These are separate decisions. The research program implements only the first two technical workflows and cannot approve the remaining stages.

Compare supplier proposals with the September 10 strategy review. Published dashboard prices are not production license quotes. Do not commit all four developers to provider-specific adapters before samples and rights are available.
