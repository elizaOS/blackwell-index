# Optional fixed B200 offer schedule

The engine can enforce a fixed set of eight-GPU HGX B200 offers under the [optional B200 publication scope](MODEL_PUBLICATION_SCOPE.md). Both options are inactive in bundled configurations. This capability does not approve a real source panel, fill unknown commercial terms, or establish Pyth or venue acceptance.

## Contract

An optional `methodology.offerSchedule` contains `schemaVersion: 1`, `model: "B200"`, a nonblank `approvalEvidence` reference, and one to 256 exact offers. Each offer requires:

| Field | Matching rule |
| --- | --- |
| `provider`, `source` | Exact registered provider and admitted source |
| `sku`, `region` | Exact case-sensitive strings; no wildcards |
| `gpuCount`, `topology` | Exactly `8` and `HGX` |
| `includes` | Nonempty exact set of component labels; order is ignored, duplicates/additions/removals rejected |
| `minimumOrderGpuCount` | Exact positive count, or explicit `null` matching only absent/null observation metadata |
| `sourceRecordId` | Exact nonblank retained record identifier |
| `sourceUrl` | Exact HTTPS URL on an admitted host; credentials, sensitive query parameters and fragments rejected |
| `instanceResources` | Optional exact full-instance vCPU/RAM/storage quantities; omission matches only unreported quantities |

The schedule requires an explicit B200 publication scope and the public on-demand list cohort. Every scheduled region must also fit the methodology's cohort regions. A cohort-wide `*` allows named scheduled regions; individual scheduled offers never use wildcards. Literal `global` or `unspecified` matches only that label and does not prove geographic coverage. A null minimum order does not mean any known minimum order is acceptable.

Selected observations must explicitly declare `priceScope: PUBLIC`. Missing or unknown topology and missing public-price metadata fail admission. Existing signature, registry, source-rights, physical exclusivity, timestamp, price normalization, operator quorum and dispersion checks still apply. The engine does not infer HGX from a provider's marketing page or convert a one-GPU quote into a whole-node tariff.

## Fixed membership through calculation

1. Each exact scheduled offer must independently satisfy operator quorum and price/time validation. Distinct record IDs or provenance URLs cannot pool votes.
2. Every scheduled offer for a selected provider must qualify. A missing, expired or stale offer makes that provider unavailable; its remaining offers do not silently become a smaller basket.
3. Every selected provider in an economic group must be ready. Unscheduled sibling providers cannot alter or replace it. Scheduled economic groups must exactly equal the B200 weight keys; missing groups never redistribute weights.

These requirements preserve the existing regional/provider aggregation and fixed economic-group weighting. They do not add equal per-offer weighting or change source timestamps. Nonselected B200 provider diagnostics are unavailable with `PROVIDER_OUTSIDE_OFFER_SCHEDULE`; incomplete selected providers report `MISSING_SCHEDULED_OFFER`. Only the B200 model feed can publish under the scoped policy.

The complete schedule and evidence reference are part of `methodologyHash`. Existing Pyth publication/readback bindings therefore reject an edited schedule until the policy is reviewed and rebound. Both encrypted recovery formats retain it and reproduce the calculation; restoring an archive does not enable publication. No additional snapshot or wire-format field is required. When no schedule is present, legacy canonical methodology, snapshots, publication and readback remain unchanged.

## Limits and next evidence

`includes` contains component labels. The separate [optional resource quantities](INSTANCE_RESOURCES.md) bind full-instance vCPUs, RAM GiB and storage GiB into exact admission, rejecting an unchanged SKU with changed reported quantities. A schedule without that metadata cannot claim quantitative protection. Mandatory ancillary charges, billing rules, storage properties and contractual applicability still require provider-specific evidence. Unknown terms remain unknown. Availability is separate: this proposed product references tariffs and does not promise instantly rentable capacity. Discontinuation and prolonged unavailability need an approved policy.

No real schedule is shipped as an approved example. Signed synthetic examples and adversarial cases live in `test/offer-schedule.test.ts`; their providers, approvals and identifiers must not be reused for production. Current collectors can still emit unknown topology or incomplete bundle metadata, so activating this filter against today's research output is not a shortcut to a publishable panel.

The remaining sequence is to qualify the exact offers and rights, approve the methodology and source mappings, obtain Pyth's accepted ingestion/test contract, implement that agreed interface, then prove actual upstream and venue consumption including failure and recovery. See [source qualification](SOURCE_QUALIFICATION_PACKET.md), [methodology decisions](B200_METHODOLOGY_DECISIONS.md) and [Phase 0 engineering](PHASE_0_ENGINEERING.md).
