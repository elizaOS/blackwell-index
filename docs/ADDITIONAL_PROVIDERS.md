# Additional provider adapters

Research date: September 6, 2026. Hyperstack and Shadeform require operator accounts and keys. **Neither adapter has been validated against a live authenticated response.** The fixtures test parsing and failure handling only. Neither source should be enabled for collection, redistribution or benchmark derivation without the applicable permissions and review.

| Adapter | Required environment | Supported scope | Live status |
| --- | --- | --- | --- |
| `hyperstack-pricebook` | `HYPERSTACK_API_KEY` | Documented eight-GPU B200/B300 flavors; undiscounted, open-ended list rates only | No key supplied; unverified live |
| `shadeform-instances` | `SHADEFORM_API_KEY`, `SHADEFORM_BILLING_CURRENCY=USD`, `SHADEFORM_BILLING_EVIDENCE` | B200/B300 whole-GPU VM or bare-metal instance catalog; account-specific reseller quotes only | No key or currency confirmation supplied; unverified live |

Both adapters return `NO_KEY` without making a request when their key is absent. Shadeform also makes no request while currency review is unconfigured. No adapter allocates, reserves or purchases compute.

## Hyperstack

Three authenticated GET endpoints are joined by exact resource name and region:

- `https://infrahub-api.nexgencloud.com/v1/pricebook`
- `https://infrahub-api.nexgencloud.com/v1/core/flavors`
- `https://infrahub-api.nexgencloud.com/v1/core/stocks`

Authentication uses the `api_key` header. The provider publishes its complete [OpenAPI specification](https://docs.hyperstack.cloud/openapi/hyperstack.json) and [machine-readable documentation entry points](https://docs.hyperstack.cloud/docs/libraries/agent-docs/). The pricebook is a bare array; flavors use `data[].flavors[]`; stock uses `stocks[].models[]`. These specific catalog operations do not document page parameters. Unexpected continuation metadata fails closed; the general [pagination guide](https://docs.hyperstack.cloud/docs/api-reference/pagination/) is not sufficient authority to invent pagination for these operations.

### Prices and physical counts

The [billing documentation](https://docs.hyperstack.cloud/docs/billing/pricebook/) defines `value` as the account's current resource rate and `original_value` as its undiscounted rate. GPU instance cost is the per-GPU rate multiplied by the flavor's GPU count; CPU, RAM and local storage are included. Additional public IPs and attached volumes are separate charges. [Payment terms](https://www.hyperstack.cloud/terms-and-conditions) specify US-dollar prepayment.

The adapter requires the three included host-resource rates to be explicitly zero at both current and original prices, without discounts or date limits. The GPU rate also requires `discount_applied=false`, null start/end times, and equal current/original rates. The billing page identifies this combination as the open-ended list rate. Discounted or dated rates remain in private raw evidence but produce no normalized observation: a discount alone cannot distinguish a promotion from a reserved-capacity contract.

The [current flavor catalog](https://docs.hyperstack.cloud/docs/hardware/flavors/) documents `n3-B200-SXM6x8` and `n3-B300-SXM6x8`, each with eight GPUs. These are the only shipped mappings. Flavor/group model, physical count and region must agree. GB200, GB300 and additional configurations need documented mappings before admission; neither chip nor rack counts are guessed.

### Availability and evidence

The [stock guide](https://docs.hyperstack.cloud/docs/hardware/gpu-stock-information/) distinguishes conservative stock labels such as `10+` from `configurations`, which count deployable VMs at each GPU count. Different configuration counts draw on overlapping physical stock. The adapter uses the matching configuration only for available/unavailable status; `availableGpuCount` remains null. It never sums configuration counts or turns `10+` into exactly ten GPUs. A conflict with the flavor's stock flag rejects the cycle rather than selecting whichever read looks better.

Every original response is archived. Each observation references a separately labeled `HYPERSTACK_PRICEBOOK_COMPOSITION_V1` receipt that identifies its flavor/resource and all three original hashes. The receipt is a local composition record, not an upstream API response. A failed request, missing join or ambiguous Blackwell row discards the cycle's normalized observations while retaining received evidence.

## Shadeform

The [instance-types API](https://docs.shadeform.ai/api-reference/instances/instances-types) is `GET https://api.shadeform.ai/v1/instances/types` with `X-API-KEY`. Its [OpenAPI-bearing Markdown representation](https://docs.shadeform.ai/api-reference/instances/instances-types.md) defines `hourly_price` as integer cents per instance-hour, `configuration.num_gpus` as GPUs per instance, and boolean availability for each region. It documents no pagination or exact fleet quantity. The adapter divides integer cents by 100 and then by physical GPUs, preserving exact fixed-point arithmetic.

### Required currency review

The API schema does not identify an ISO currency. Before enabling collection, obtain written confirmation of the account's billing currency and record the provider case, agreement or reviewed document in `SHADEFORM_BILLING_EVIDENCE`; set `SHADEFORM_BILLING_CURRENCY=USD` only for confirmed USD instance-cent billing. These settings are **operator declarations, not proof of provider verification**. A labeled local normalization receipt binds the raw provider response hash to USD and the hash of the protected billing-evidence reference; it never describes that assertion as provider-supplied currency. The actual confirmation must be retained and referenced in the approved source-rights/methodology records. Never put account secrets or signed access URLs in an evidence reference. Non-USD accounts require a separate currency methodology; this adapter does not perform FX conversion.

### Reseller and procurement limits

Shadeform's [core concepts](https://docs.shadeform.ai/getting-started/concepts) identify `cloud` as the underlying supplier. The adapter preserves it in the SKU, `sourceRecordId` and included-resource metadata. A Shadeform quote for Hyperstack is not a second independent Hyperstack supply pool. Keep collection, reseller and ultimate economic-owner mappings separate before choosing benchmark weights.

The [FAQ](https://docs.shadeform.ai/getting-started/faq) describes access to providers' on-demand pools, with reservations arranged separately. It also distinguishes Shadeform billing from management of an operator's existing cloud account. All emitted quotes remain `LIST`, `ACCOUNT_SPECIFIC` and excluded from the draft public-list cohort. Available does not mean allocated, invoiced or guaranteed executable. Only VM/bare-metal B200/B300 rows are supported; containers, fractional or inconsistent counts, new procurement metadata, and GB systems are rejected. Shadeform's [Blackwell Ultra announcement](https://www.shadeform.ai/resources/articles/nvidia-blackwell-ultra-b300s-now-available-on-shadeform) distinguishes on-demand B300 from inquiry-based reserved HGX/GB300 clusters; a common generation name does not establish equal commercial terms.

## Accounts, permission and release checklist

1. Obtain organizational accounts and least-privilege API keys for the three Hyperstack reads or Shadeform instance-types read. Confirm whether account funding is required for read access; Shadeform's [quickstart](https://docs.shadeform.ai/getting-started/quickstart) places wallet funding before API-key creation. This repository does not fund accounts.
2. Obtain terms covering automated collection, private retention, redistribution, derived indexes and financial-reference use. [Shadeform's terms](https://www.shadeform.ai/terms-of-service) restrict systematic database compilation and automated access without permission. Ordinary API access is not benchmark publication permission. Obtain Hyperstack's applicable agreement review as well.
3. For Shadeform, obtain actual currency confirmation, clarify discounts/linked-account behavior, and reconcile upstream supplier ownership. Setting configuration strings is not completion of this step.
4. Capture licensed real responses; check exact SKU names, unit precision, endpoint completeness, stock races, throttling and source timestamps. Compare provider allocations/invoices only with a separately approved budget.
5. Approve source provenance and constituent rules. Keep registry collection, derivation and redistribution flags false until each respective permission is documented. Do not count these adapters as live-verified sources based on test results.

Both collectors are registered with the exact API hosts above and default to disabled. Shadeform's configuration descriptor includes both `SHADEFORM_BILLING_CURRENCY` and `SHADEFORM_BILLING_EVIDENCE`. The hosted configuration enables only Oracle, Azure and Verda research collection. Adding these authenticated adapters does not enable them or establish source rights.
