# Google catalog mapping review

Status: discovery verified September 10, 2026; production mapping not approved.

## Evidence

The authenticated Cloud Billing Catalog API returned 32,873 Compute Engine SKUs across eight successful requests. A description search for Blackwell, A4, B200, B300, GB200 and GB300 found 136 candidates. This search is discovery, not proof of complete hardware coverage. Responses were inspected in memory, not retained as a historical dataset.

For `us-central1`, the following B200 candidate IDs were observed:

| SKU ID | Description meaning | API usage type | Mapping status |
| --- | --- | --- | --- |
| `3000-4751-0A45` | A4 B200 one-GPU slice | OnDemand | Procurement and bundle composition unresolved |
| `816D-DB2C-4A30` | Spot Preemptible A4 B200 slice | OnDemand | Must not classify as ordinary on-demand |
| `0EFA-3A56-0BFC` | DWS Calendar A4 B200 slice | OnDemand | Scheduled capacity, not immediate inventory |
| `A0AD-E652-D4F9` | DWS Defined Duration A4 B200 slice | OnDemand | Duration and scheduling terms require review |
| `1DBB-13D9-B0DE` | One-year A4 B200 commitment | Commit1Yr | Commitment terms require review |
| `50E4-2D4A-7538` | Three-year A4 B200 commitment | Commit3Yr | Commitment terms require review |

All six reported hourly units. No numeric price is promoted into a production mapping by this document.

## Required validation

1. Establish whether a one-GPU slice includes proportional CPU, memory and local SSD or requires additional billing components. Do not multiply a GPU-only component into a full-VM price without this evidence.
2. Bind each approved SKU to its actual procurement terms. `category.usageType` alone cannot distinguish Spot, Calendar and ordinary-looking entries: all three observed candidates use `OnDemand`.
3. Verify the exact hardware denominator against the [official machine specifications](https://docs.cloud.google.com/compute/docs/accelerator-optimized-machines). The A4 table identifies eight B200 GPUs per `a4-highgpu-8g`; A4X Max identifies four GPUs per `a4x-maxgpu-4g-metal`.
4. Review capacity requirements separately from prices. Google's machine documentation requires supported reservation, Spot, Flex-start or resize-request paths for A4 and reserved capacity for A4X Max. Catalog presence does not establish available capacity.
5. Reconcile a composed price against the official pricing table or a provider-confirmed billing example for the same region, consumption model and date.
6. Add regression tests for changed description/procurement identity before enabling a reviewed mapping. The current component guard checks region, usage type, unit and current effective price; it does not independently prove procurement identity from a description.
7. Obtain source-use approval and install the restricted API key through the operator's protected secret workflow only after the mapping passes review.

Until these checks pass, leave `GOOGLE_BILLING_SKU_MAP_JSON` unset. Discovery success must continue to return `NO_MAPPING`, not an assumed normalized price. See [Catalog API documentation](https://docs.cloud.google.com/billing/v1/how-tos/catalog-api) and [provider setup](PROVIDERS.md#google-catalog-setup).
