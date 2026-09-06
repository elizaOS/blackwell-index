# Pricing providers

Research and diagnostic observation date: **September 6, 2026**. An implemented connector, an approved contributor, and a currently available price are separate states. `config/catalog.json` is a discovery inventory; the network registry controls accepted sources and rights. An empty model list means coverage has not been verified, rather than a claim that a provider has no Blackwell hardware.

The repository implements eleven collectors, including three public catalog sources. It does not yet cover every provider. Additional official APIs and commercial feeds are listed below with their outstanding work. Test fixtures exercise parsing and failures; no fixture is used as a live data source.

## Implemented collectors

| Collector | Credentials | Prices represented | Availability evidence | Live verification |
|---|---|---|---|---|
| `oracle-public` | None | B200, B300, GB200 and GB300 public pay-as-you-go list rates | Unknown | All four API responses HTTP 200 on September 6 |
| `azure-retail` | None | Exact supported GB200/GB300 Linux consumption SKUs; regular and Spot stay separate | Unknown | GB200 returned prices; separate GB300 query returned zero rows |
| `verda-public` | None | B200, B300 and GB300 USD instance list rates; on-demand and Spot stay separate | Unknown | Public catalog returned 22 observations across 11 supported configurations on September 6 |
| `lambda-cloud` | `LAMBDA_API_KEY` | Public instance catalog rate | Regional available/unavailable; no quantity supplied | Implemented against official schema; operator key required for live validation |
| `runpod-secure` | `RUNPOD_API_KEY` | Lowest advertised Secure Cloud rate for the one-GPU query | Qualitative stock plus supported deployment sizes | Implemented against official schema; operator key and permission required for live validation |
| `vast-offers` | `VAST_API_KEY` | Verified currently rentable noninterruptible offers | Offer GPU count | Implemented against official schema; operator key and written data permission required for live validation |
| `google-billing` | `GOOGLE_CLOUD_BILLING_API_KEY` | Catalog discovery; complete instance composition after explicit SKU mapping | Unknown | Key and reviewed billing-component mapping required for live validation |
| `aws-pricing` | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`; `AWS_SESSION_TOKEN` for temporary credentials | Supported Linux P6 instance catalog prices; Capacity Block metadata retained | Unknown | Implemented with the official AWS SDK; live account credentials required |
| `hyperstack-pricebook` | `HYPERSTACK_API_KEY` | Documented eight-GPU B200/B300 configurations; undiscounted open-ended list rates | Qualitative configuration stock | Implemented against official schemas; no live authenticated verification |
| `shadeform-instances` | `SHADEFORM_API_KEY` plus reviewed billing currency and evidence | B200/B300 account-specific reseller quotes, excluded from the public-list cohort | Regional available/unavailable | No live key or written currency confirmation supplied |
| `prime-intellect-availability` | `PRIME_INTELLECT_API_KEY`, Availability → Read | Complete supported B200/B300 USD account-specific bundles; GB200/GB300 discovery only | Qualitative configuration stock; no fleet quantity | Implemented against official schema and SDK; no live authenticated verification |

Collection never provisions, reserves, or purchases GPU capacity. API keys remain in the operator's environment. The collector returns `NO_KEY` without a request when credentials are absent. Do not paste credentials into a registry, observation, issue, or source URL. Runpod requires its key in the documented query parameter; evidence URLs remove that parameter.

Successful responses are archived as exact bytes before parsing. Every observation references the response SHA-256 or a labeled composition receipt that references each original response. A malformed successful response is still available for diagnosis. HTTP failures produce explicit errors; a 429 response is not parsed as JSON. CLI and hosted collection persist per-collector backoff: 429/503 `Retry-After` deadlines survive restarts, and missing or invalid retry headers use bounded exponential backoff. Collectors reject redirects, oversized responses, unsupported units and invalid decimal prices. Requests identify the client with the honest `blackwell-index/0.1` User-Agent. Oracle's API rejected Bun's default client header during diagnostics but accepted this identified API client.

### Oracle

The [official Price List API](https://docs.oracle.com/en-us/iaas/Content/Billing/Tasks/signingup_topic-Estimating_Costs.htm) is public. Oracle also [documents that no API key is required](https://docs.oracle.com/en/learn/opencost-oke/index.html). Query `https://apexapps.oracle.com/pls/apex/cetools/api/v1/products/?partNumber=PART&currencyCode=USD`.

| Product | Part number | Shape | GPUs per instance | Observed USD/GPU-hour |
|---|---|---|---:|---:|
| B200 | B110978 | BM.GPU.B200.8 | 8 | 14 |
| B300 | B112237 | BM.GPU.B300.8 | 8 | 15 |
| GB200 | B110979 | BM.GPU.GB200.4 | 4 | 16 |
| GB300 | B112140 | BM.GPU.GB300.4 | 4 | 18 |

These values are dated research observations, not fallback constants. The collector always requests the current rate. Live responses use `items[].currencyCodeLocalizations[].prices[]`, while the documentation example has an older envelope. The adapter requires `metricName == "GPU Per Hour"`, USD, and `model == "PAY_AS_YOU_GO"`. It multiplies by the shape's GPU count only to report the corresponding instance price; it does not divide an already normalized price again.

The response `lastUpdated` was `2026-09-01T14:26:53.943Z`. That describes the catalog snapshot, not necessarily the date a particular tariff changed. It remains in raw evidence; the observation's `priceEffectiveAt` is null. The [OCI price list](https://www.oracle.com/cloud/price-list/) supplies shape context. The collector does not assert immediate capacity, a region-specific offer, or a minimum purchasable NVL72 rack size. These require operator/account confirmation.

### Azure

The [Retail Prices API](https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices) requires no credentials and returns list tariffs. The collector queries Blackwell consumption rows at `https://prices.azure.com/api/retail/prices` and follows `NextPageLink` sequentially. Each continuation must remain HTTPS on the exact public pricing endpoint. Failed or incomplete pagination discards the partial observation set.

Exact mappings currently accepted:

- `Standard_ND128isr_NDR_GB200_v6` to GB200, four GPUs.
- `Standard_ND128isr_GB300_v6` to GB300, four GPUs, as documented in [GB300 machine specifications](https://learn.microsoft.com/en-us/azure/virtual-machines/sizes/gpu-accelerated/nd-gb300-v6-series).

The GB200 diagnostic returned 80 records, including Windows and Spot entries. One Linux regular westus3 row was $108.16 per instance-hour, or $27.04 per GPU-hour. The GB300 diagnostic returned HTTP 200 with zero rows. The collector never substitutes GB200 for absent GB300 pricing. It filters Windows, DevTest, non-USD, nonprimary meters and tiered usage, then requires an hourly billing unit. Reserved and savings-plan pricing is outside this collector's consumption query.

The diagnostic also confirmed that a substring filter for B200 matches GB200. Only an explicit SKU map decides the model. Old `effectiveStartDate` values remain valid if a current successful retrieval still presents that tariff. No current-capacity statement is inferred from a catalog row.

### Verda

The [official OpenAPI schema](https://api.verda.com/v1/openapi.json) explicitly permits unauthenticated `GET /v1/instance-types`. The collector requests `currency=usd`, verifies model, physical GPU count, hardware and billing fields, and preserves `price_per_hour` and `spot_price` as separate procurement classes. September 6 retrieval produced eight B200, eight B300 and six GB300 observations. These counts reflect that catalog response, not fixed coverage or confirmed stock. No GB200 price was returned.

The catalog does not establish current availability, location or complete rack-level procurement terms. Those fields remain unknown. Public access also does not establish redistribution or derivative-index rights; [Verda's terms](https://verda.com/terms-and-conditions) require review before publication. See [public source discovery](PUBLIC_SOURCE_DISCOVERY.md) for exact mappings, exclusions and remaining evidence.

### Lambda

Create an API key in the Lambda Cloud dashboard and set `LAMBDA_API_KEY`. The [official API](https://docs.lambda.ai/public-cloud/cloud-api/) supports Bearer authentication on `GET https://cloud.lambda.ai/api/v1/instance-types` and documents approximately one request per second. The collector converts `instance_type.price_cents_per_hour` into dollars and divides by `instance_type.specs.gpus`. Each `regions_with_capacity_available` entry becomes a regional observation; an empty array produces an unavailable catalog observation with region `global`.

Capacity is qualitative. Eight GPUs per instance does not mean exactly eight GPUs remain in the provider fleet. No quantity is invented. The current [public instance page](https://lambda.ai/instances) identifies B200; the authenticated catalog determines which models are actually returned. A quote is retained as `LIST` until live allocation/invoice validation justifies a stronger executable classification.

### Runpod

Set `RUNPOD_API_KEY` after confirming systematic collection and publication permission. The [documented GraphQL API](https://docs.runpod.io/sdks/graphql/manage-pods) is `POST https://api.runpod.io/graphql?api_key=KEY`. The collector requests `gpuTypes` and `lowestPrice(input: { gpuCount: 1, secureCloud: true })`, including `stockStatus`, `uninterruptablePrice` and `availableGpuCounts`.

This is a lowest advertised one-GPU Secure Cloud offer, not an average of Runpod inventory. Community Cloud does not enter this collector. Stock labels are qualitative; supported sizes such as `[1,2,4]` are not a fleet inventory count. If the provider lists only eight-GPU deployments, the one-GPU observation is unavailable. The current implementation cannot represent the regional or configuration composition behind the lowest global rate. It remains `LIST`, carries unknown fleet quantity, and must not be mixed into a representative regional average without an approved selection rule.

### Vast

Set `VAST_API_KEY` only after written data permission. The [offer search API](https://docs.vast.ai/api-reference/search/search-offers) uses Bearer authentication on `POST https://console.vast.ai/api/v0/bundles`. The collector queries verified, rentable, not-already-rented, on-demand Blackwell offers and normalizes `dph_total / num_gpus`. Raw evidence preserves offer, host, machine, storage and fee fields. `sourceRecordId` retains the host and offer IDs for provenance; the network still treats Vast as one economic source group until independent host ownership is verified.

The current conservative tenancy rule requires `gpu_frac == 1`. The API calls this a fraction of total GPU resources, without resolving all partial-host versus fractional-device cases. Some valid whole-GPU offers can therefore be excluded. Confirm that field's semantics and exact Blackwell model strings using a licensed live account before widening admission. The collector stops with `INCOMPLETE_COVERAGE` when its result limit is reached, rather than claiming a truncated offer list is the complete market. It does not claim the selected hosts are all datacenter-grade.

## Additional provider work

### AWS account setup

Create an IAM principal permitted to call `pricing:GetProducts` and supply `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`. Temporary credentials also need `AWS_SESSION_TOKEN`. The collector uses the official pinned AWS Pricing SDK to sign requests, with an injected fetch transport that archives the original JSON response. It does not read a local credentials file, contact instance metadata, or require Node filesystem access, so the same explicit environment credentials work for desktop and Worker deployments.

The collector queries `AmazonEC2` for exact supported P6 instance types, Linux, Shared tenancy and no preinstalled commercial software. It follows every result page and accepts flat hourly OnDemand or CapacityBlock terms. It preserves detected capacity-block classification and excludes unsupported reserved payment schedules rather than converting an upfront fee into a misleading hourly price. It uses fixed hardware maps verified against provider specifications, checks the API's GPU count when present, and rejects inconsistencies.

Verified normalized mappings cover `p6-b200.48xlarge` and `p6-b300.48xlarge` at eight GPUs, and `p6e-gb200.36xlarge` at four GPUs. [AWS P6 specifications](https://aws.amazon.com/ec2/instance-types/p6/) distinguish a four-GPU GB200 node from the enclosing 36- or 72-GPU UltraServer. The minimum order is not inferred from node size. GB300 `.36xlarge` and `.72xlarge` names are queried for discovery only: their GPU count must be confirmed through authoritative instance metadata before any quote is normalized. A Kubernetes workload's requested GPU count is not a hardware specification. Matching GB300 products return `HARDWARE_METADATA_REQUIRED`; an absent requested type returns `NO_DATA`. Obtain `ec2:DescribeInstanceTypes` access for mapping validation. Spot history and executable Capacity Block offerings need separate EC2 API adapters.

### Google catalog setup

Enable Cloud Billing API in a Google Cloud project and create an API key restricted to that API. Set `GOOGLE_CLOUD_BILLING_API_KEY`. Without an instance map, `google-billing` discovers the Compute Engine service, archives every page of its official SKU catalog, and returns `NO_MAPPING`. It does not reinterpret a GPU-only billing component as a full VM price.

After reviewing real catalog responses, set `GOOGLE_BILLING_SKU_MAP_JSON` to an array of machine mappings. Each mapping needs `model`, `sku`, `region`, `gpuCount`, `procurement`, `includes`, and a `components` array. Each component contains the actual catalog `skuId`, a positive integer `quantity` per VM, the exact hourly `usageUnit`, and exact `usageType`. Supported hardware mappings are A4 B200 with eight GPUs, A4X GB200 with four GPUs, and A4X Max GB300 with four GPUs. Billing components and actual procurement classes still require provider confirmation; no default components or fabricated SKU IDs are shipped.

The collector requires every component's current price, region and unit to match. It rejects tiered rates rather than assuming a usage threshold. It sums the API's integer nanos exactly and rounds the total instance price to six decimals before normalizing by GPU count. `displayQuantity` is a display aid and does not multiply the bill. A distinct composition receipt references every original archived response hash. This receipt is labeled `GOOGLE_BILLING_COMPOSITION_V1` and is not represented as an upstream provider payload. A reviewed composition map must be part of the network's approved methodology release so operators agree on included components and procurement terms.

| Provider | Documented access | Remaining implementation or access work |
|---|---|---|
| AWS | [Pricing Query/Bulk APIs](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/price-changes.html); [public price-file downloads](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/using-the-aws-price-list-bulk-api-fetching-price-list-files-manually.html) | Pricing collector implemented; obtain IAM credentials and confirm real catalog schemas; add separate EC2 capacity-offering/Spot adapters |
| Google Cloud | [Cloud Billing Catalog API](https://docs.cloud.google.com/billing/v1/how-tos/catalog-api) | Collector implemented; enable API and key, capture real SKUs, approve complete machine component maps and actual consumption terms |
| Nebius | [Marketing prices](https://nebius.com/prices), [detailed billing docs](https://docs.nebius.com/compute/resources/pricing) | Resolve conflicting B200/B300 rates and obtain an authoritative provider quote feed; GB200/GB300 are sales-led |
| CoreWeave | [Public pricing](https://www.coreweave.com/pricing), [NVL72 constraints](https://docs.coreweave.com/platform/instances/nvl72) | Obtain current authenticated price/availability feed and contributor permission; preserve whole-rack minimums |
| Crusoe | [Customer API capacities integration](https://docs.crusoecloud.com/reference/mcp-server), [pricing](https://www.crusoe.ai/cloud/pricing) | API key pair, customer account and authoritative Blackwell price feed; capacity alone is not a price |
| Hyperstack | [Pricebook API](https://docs.hyperstack.cloud/docs/api-reference/get-pricebook/) | Three-endpoint collector implemented; obtain key, live schema verification and source rights; discounted/dated rates remain excluded |
| Shadeform | [Instance types API](https://docs.shadeform.ai/api-reference/instances/instances-types) | Collector implemented; obtain key, written USD billing confirmation and retrieval/publication permission; verify underlying provider ownership |
| Prime Intellect | [Availability API](https://docs.primeintellect.ai/api-reference/availability/get-gpu-availability) | Collector implemented and disabled; obtain Availability Read key, written data rights and live complete-bundle reconciliation; verify GB hardware/procurement and underlying provider ownership |
| TensorDock | [Provider documentation](https://docs.tensordock.com/) | Obtain current API schema and verify Blackwell inventory; no guessed legacy endpoint is implemented |
| Verda | [Pricing and billing](https://docs.verda.com/welcome-to-verda/pricing-and-billing) | Public collector live-verified; confirm publication rights, location/availability semantics and procurement minimums |
| Gcore | [GPU price list](https://gcore.com/pricing/ai) | Public B300 EUR pricing and GB300 sales contact; approved currency conversion and contract cohort required |
| STN | [Pricing](https://www.stninc.com/pricing) | B300/GB300 rates vary by contract length; source feed and procurement classification required |
| Together AI | [GPU clusters](https://www.together.ai/gpu-clusters) | Confirm current price/availability API and rights; keep cluster reservation terms explicit |
| Fluidstack, Voltage Park, NVIDIA Lepton | Sales/workspace onboarding | Current signed contributor feed, underlying operator identity and provider permissions |

AWS's [Capacity Blocks page](https://aws.amazon.com/ec2/capacityblocks/pricing/) lists scheduled block rates for B200, B300 and GB200. GB300 has [sales-led general availability](https://aws.amazon.com/about-aws/whats-new/2025/12/amazon-ec2-p6e-gb300-ultraservers-nvidia-gb300-nvl72-generally-available/). These are different from ordinary immediately available on-demand compute. Google's [A4 pricing](https://cloud.google.com/products/compute/pricing/accelerator-optimized?hl=en) includes Flex-start, Calendar, Spot and commitment options while regular on-demand is shown as N/A. Its [GB200 deployment documentation](https://docs.cloud.google.com/ai-hypercomputer/docs/create/create-vm-a4x) requires reserved sub-blocks even when individual four-GPU nodes are deployed. A scalar hourly rate must retain these constraints.

## Normalization and source independence

[Hyperstack and Shadeform implementation notes](ADDITIONAL_PROVIDERS.md) document credential setup, exact joins, currency requirements and unsupported cases. Existing local node configurations are not silently migrated: explicitly add new collector IDs and reviewed registry entries before enabling them.

[Prime Intellect implementation notes](PRIME_INTELLECT.md) document exact USD bundle composition, sequential pagination and account scope. The source starts disabled with all data rights unapproved. Its B200/B300 account-specific observations cannot enter the current public-list cohort. GB200/GB300 responses remain private discovery evidence until hardware and procurement details are reviewed.

The intended unit is the rental bundle's USD cost divided by physical accelerator-hours. CPU, memory, interconnect and local storage can be bundled differently by provider; this is not a separately priced bare GPU chip. Preserve included resources, topology and minimum order. Optional egress, taxes, enterprise software and persistent storage are not silently added or subtracted.

GB200 and GB300 denote Grace Blackwell system families. Their documentation can describe the contained accelerators as B200 or B300. Classification follows the system SKU first: a GB200 observation belongs only to GB200. An NVL72 rack has 72 accelerators; a four-GPU node inside that rack has four. Minimum order and instance GPU count are different fields.

Multiple nodes collecting one provider do not create multiple economic providers. Neither API pagination nor a large regional catalog earns additional market weight. Shadeform, Prime Intellect and Lepton quotes can refer to the same underlying compute provider, and Vast/TensorDock hosts can resell common supply. The approved registry must resolve those dependencies.

The [IOSCO benchmark principles](https://www.iosco.org/library/pubdocs/pdf/IOSCOPD415.pdf) support transparent data sufficiency, input hierarchy, governance, review and audit. They do not supply a universal GPU weighting formula. [Equal weighting is a conventional index choice](https://www.spglobal.com/spdji/en/methodology/article/index-mathematics-methodology/), but a 25% weight for each Blackwell family is a disclosed basket design, not an observed market share. Transaction-volume weighting requires verified executed GPU-hours; listing counts and advertised fleet capacity are insufficient.

## Permissions and validation before publication

Public API access proves a technical access path. It does not alone establish redistribution, archival, derivative-index or onchain financial-reference rights. The registry should reference written agreements or reviewed license terms and expire grants when required. [Vast terms](https://console.vast.ai/terms/) and [Runpod terms](https://www.runpod.io/legal/terms-of-service) expressly restrict systematic retrieval/compilation without permission. Independent node operation does not remove those constraints.

Before promoting a source, obtain:

1. A permitted API/feed and current model/SKU schema, billing units, term, region, cancellation and availability semantics.
2. Exact collection, retention, audit, derived-index, publication and financial-reference rights, including any underlying host permission.
3. Read-only operator credentials with local secret storage and rotation instructions.
4. Real response captures from independent operators, parser reconciliation, and outage/rate-limit behavior.
5. Allocated-instance and invoice checks if the source will be labeled executable or transaction-backed.
6. An approved economic-owner mapping, constituent rule, weight policy and minimum data coverage.

A source can remain visible as unavailable or research-only while one of these conditions is unresolved. No fallback number or substituted GPU family is permitted.
