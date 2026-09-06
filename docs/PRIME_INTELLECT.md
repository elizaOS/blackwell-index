# Prime Intellect availability source

Reviewed: September 6, 2026.

Status: adapter implemented, registered and tested with synthetic parser fixtures. It remains disabled by default, with collection, derivation and redistribution rights unapproved. No Prime Intellect account, API key, authenticated availability response, compute order, or payment was used. Only public documentation, the public OpenAPI schema, and official SDK source were inspected. This is not live provider verification or evidence of deployment.

## Verified interface

The current official schema specifies the following interface. `totalCount` counts matching configurations, not GPUs in stock. The model enum establishes a query vocabulary, not actual availability. [Live OpenAPI](https://api.primeintellect.ai/openapi.json), [GPU availability reference](https://docs.primeintellect.ai/api-reference/availability/get-gpu-availability)

| Field | Documented semantics |
| --- | --- |
| Endpoint | `GET https://api.primeintellect.ai/api/v1/availability/gpus` |
| Authentication | `Authorization: Bearer API_KEY` |
| Pagination | `page` starts at 1; `page_size` is at most 100; response contains `items` and `totalCount` |
| Blackwell queries | `B200_180GB`, `B300_262GB`, `GB200`, `GB300` |
| Hardware | `gpuType`, integer `gpuCount`, memory per GPU in `gpuMemory`, and `socket` |
| Provenance | `provider`, provider-defined `cloudId`, optional `dataCenter`, and `region` |
| Pricing | `prices` contains hourly pricing; `currency` explicitly distinguishes USD/EUR; `onDemand` belongs to secure-cloud offers |
| Commercial caveats | `isVariable` permits changing prices; `isSpot` describes spot capability; `prepaidTime` imposes an upfront-hour charge when set |
| Availability | `Available`, `Low`, `Medium`, `High`, or `Unavailable`; no reliable fleet quantity |

CPU, memory, local disk, and shared disk can carry separate per-unit hourly charges. The inclusion flag determines whether the default allocation is already covered by the base price. A GPU headline price alone is therefore not necessarily the full instance price. [Availability and cost-composition guide](https://docs.primeintellect.ai/api-reference/check-gpu-availability)

The official CLI displays the returned base price per configuration-hour alongside its GPU count; it does not multiply that base price by the GPU count. Our adapter adds supported host-resource charges before dividing the instance total by the GPU count. The CLI display itself is not an all-in bill. [Official CLI source, reviewed revision](https://github.com/PrimeIntellect-ai/prime/blob/d3811ca40672ca00240064aa41d10e5c822d906c/packages/prime/src/prime_cli/commands/availability.py), [SDK response models and pagination](https://github.com/PrimeIntellect-ai/prime/blob/d3811ca40672ca00240064aa41d10e5c822d906c/packages/prime/src/prime_cli/api/availability.py)

## Adapter policy

These are conservative implementation restrictions, not claims that every provider response satisfies them:

- Query the four documented Blackwell families separately, with `security=secure_cloud`. Use only sequential GET requests to the fixed HTTPS endpoint; never provision, top up, attach a disk, or follow a provider-supplied URL.
- Normalize only B200/B300 records with exact API model labels, full advertised 180/262 GB memory, SXM6, and a positive whole-GPU count. A conflicting Blackwell family in the upstream SKU is rejected. Topology stays `UNKNOWN`.
- Keep GB200/GB300 records as archived discovery only, with `HARDWARE_METADATA_REQUIRED`. Their reported count does not bypass the need to review physical configuration, minimum order and procurement terms.
- Require explicit USD, fixed secure-cloud on-demand pricing, `isSpot=false`, and `prepaidTime=null`. Missing flags, community pricing, variable rates and new unit metadata require review. Do not substitute a spot price or convert EUR with an invented exchange rate.
- Require explicit default allocations and inclusion flags for CPU, RAM, local disk and shared disk, including an explicit zero shared-disk allocation where applicable. Missing or empty resource objects do not mean free resources. Separately billed defaults must equal the documented minimum allocation and have a known nonnegative hourly unit rate. Extra billing notes are rejected pending review.
- Calculate `instancePrice = base instance-hour price + separately billed default resource costs`, then normalize by `gpuCount` using the repository's fixed-point rules. Included default resources are not charged twice. The number of GPUs in a configuration is never reused as stock quantity.
- Mark accepted records `LIST` and `ACCOUNT_SPECIFIC`, not transaction or guaranteed executable prices. Preserve the underlying provider and data center. Keep `availableGpuCount=null`, source effective time unknown, and qualitative availability separate from the price.
- Reconcile every page against a stable total. Reject short, repeated, changed or oversized catalogs. Limits are 2,000 rows per model and 2,000 normalized observations per cycle. Any transport, schema, billing, duplication or pagination failure returns no normalized subset; already received original evidence remains private.
- Archive exact original response bytes and labeled `PRIME_INTELLECT_BUNDLE_COMPOSITION_V1` receipts that link each observation to its source response and billing components. Request headers and credentials are not placed in receipts or observations.

The acceptance subset is intentionally stricter than the API's nullable schema. A valid account may consequently return only raw evidence and explicit errors. Do not relax these gates merely to obtain a price. An authenticated sample and commercial review should determine whether additional configurations are safe to support.

## Account and data-rights requirements

1. Create or use an authorized Prime Intellect account. In Settings → API Keys, generate an expiring key with only **Availability → Read**. Store it as `PRIME_INTELLECT_API_KEY` in the node's protected credential store or secret manager. Availability collection does not need instance-write or billing permissions. [API-key management](https://docs.primeintellect.ai/api-reference/api-keys), [Required availability scope](https://docs.primeintellect.ai/api-reference/check-gpu-availability)
2. Obtain written approval for the intended automated collection, evidence retention, benchmark derivation and redistribution. The posted terms restrict commercial aggregation, systematic retrieval and automated collection; an API key is not evidence of an oracle-data license. Resolve the applicable API/commercial agreement with Prime Intellect before enabling collection. This is an operational requirement, not a legal opinion. [Terms of Service, sections 3, 4 and 9](https://www.primeintellect.ai/terms-of-service)
3. Confirm API request limits, allowed polling frequency, account/team price scope, taxes and mandatory fees. Document whether any account-specific discount or additional charge changes the reported configuration price. The FAQ describes account credits and provider-dependent instance billing; it does not establish a blanket permission to publish quotes. [Billing and platform FAQ](https://docs.primeintellect.ai/faq)
4. With permission and a read-only key, run an authenticated collection into private evidence storage. Reconcile at least one B200 and one B300 record against the account's complete instance cost without creating an instance. If fields remain ambiguous, request clarification and keep them discovery-only.
5. Review upstream economic ownership before any benchmark inclusion. Prime Intellect resells/aggregates other providers; a Runpod, Hyperstack, Nebius or other upstream quote does not create an additional independent supply group. These account-scoped observations are excluded from the current public list-price cohort.

No funding amount, paid API plan requirement or collection quota was verified. Do not fund an account or enable auto-top-up for this read-only adapter without a separate decision.

## Configuration

The collector catalog contains this descriptor:

```json
{
  "id": "prime-intellect-availability",
  "provider": "prime-intellect",
  "credentialEnv": "PRIME_INTELLECT_API_KEY",
  "documentation": "https://docs.primeintellect.ai/api-reference/availability/get-gpu-availability",
  "defaultEnabled": false
}
```

Export: `primeIntellect` from `src/collectors/prime-intellect.ts`. Allowed host: `api.primeintellect.ai`. Default registry `0.3.0-draft` records `collect=false`, `derive=false`, `redistribute=false`, with no approval evidence. The provider ID and provisional reseller economic-group label are `prime-intellect`; this label is not verification of independent upstream supply. CLI and hosted collection use the shared durable rate-control wrapper.

Adding the registered source does not enable it or alter an existing node's pinned local registry. After account and rights review, select `prime-intellect-availability`, store the key with `bun src/cli.ts credentials prime-intellect-availability`, and explicitly update the node's collector configuration and applicable collection-rights evidence. Keep derivation and redistribution disabled unless separately approved. The current default registry defines 11 providers and 49 possible feed slots; those counts do not imply live quotes or benchmark eligibility.

Verification command: `bun test test/prime-intellect.test.ts`. These offline tests cover authentication gating, full pagination, exact bundle arithmetic, distinct model handling, raw GB discovery, incomplete and conflicting data, throttling, credential-safe errors and evidence-archive failures. Passing tests do not prove account access, live stock, data rights or production readiness.
