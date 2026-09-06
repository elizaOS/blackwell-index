# Public source discovery

Research and read-only probes: September 6, 2026. These findings establish access and available fields, not permission to publish a benchmark. No accounts were created, capacity purchased, or providers contacted. Raw catalogs and price observations remain in ignored local storage; this document contains metadata and coverage only.

## Recommended order

| Source | Verified public input | Blackwell coverage found | Next step |
| --- | --- | --- | --- |
| Verda | Documented unauthenticated JSON catalog; 91.6 KB | B200, B300, GB300 | Integrate the tested collector for private collection after source-policy review. |
| Nebius | Official pricing Markdown; 13.2 KB | B200, B300 | Verify machine presets, then implement a narrowly scoped documentation parser. |
| AWS | Documented unauthenticated regional price-list files | Official hardware documentation supports B200, B300, GB200 | Use authenticated Query for narrow requests, or design an external streaming bulk ingestion job. |

These are potential provider inputs, not three newly approved index constituents. Multiple SKUs, procurement terms, aliases, collectors, or nodes do not create independent providers. In particular, Verda and DataCrunch must remain one provider group.

## Verda

### Public access and schema

The official [resources page](https://docs.verda.com/resources/resources-overview/) links the [API reference](https://api.verda.com/v1/docs). Its [OpenAPI document](https://api.verda.com/v1/openapi.json) declares `GET /v1/instance-types` with `security: []`, overriding the global bearer requirement. `currency=usd` is a documented query parameter. Records include `instance_type`, `model`, physical `gpu.number_of_gpus`, CPU and memory specifications, `price_per_hour`, and separate `spot_price`. The old price-history endpoint and `dynamic_price` are deprecated. Availability and location endpoints require bearer authorization; they were not accessed.

Live probe metadata:

| Request | HTTP | Response bytes | SHA-256 |
| --- | --- | ---: | --- |
| [OpenAPI](https://api.verda.com/v1/openapi.json) | 200 | 189,192 | `3d7378032d26d4e91c8040413b6aa90ad5aa4de48eb90efb613f5d4f5f454005` |
| [USD instance types](https://api.verda.com/v1/instance-types?currency=usd) | 200 | 91,606 | `bb40c422f307e49b5aec31cfa21b54e0d205e26bcc2c45b316017be817b6ed78` |

The catalog contained 64 records. Exact target-family matching retained 11 SKUs: three GB300 sizes (1, 2, 4 GPUs), four B300 sizes (1, 2, 4, 8), and four B200 sizes (1, 2, 4, 8). No GB200 row was present. Confidential-computing variants were excluded. Region and stock counts were absent; GB300 `supported_os` was empty. None of this proves purchasable inventory. The [public GPU page](https://verda.com/gpu-instances) independently displayed the same model families, sizes, and normalized on-demand rates.

### Implementation and verification

The new `src/collectors/verda.ts` reads the public response, archives its original bytes, and normalizes each full-instance rate by the explicit physical GPU count. It cross-checks model, SKU, GPU description, CPU count, manufacturer, dedicated tenancy, and USD currency. On-demand and spot observations remain separate. Duplicate identifiers invalidate the ambiguous catalog. Invalid or missing prices never fall back to fixtures or deprecated fields.

Location, inventory, and topology remain unknown. CPU and memory are included; dynamically provisioned storage is not. A catalog listing is not a stock quote, and the adapter does not infer NVLink topology from a general product page.

Actual adapter run at `2026-09-06T09:16:51.988Z`:

- 22 schema-valid observations: GB300 6, B300 8, B200 8.
- 11 on-demand and 11 spot observations; zero collector errors.
- One original evidence response and one capture; no reports or public snapshots.
- Private probe journal: `data/verda-source-probe-20260906.sqlite`, excluded from Git.
- Dedicated tests: 10 passed, 73 assertions. TypeScript typecheck passed.

This is local collector acceptance, not evidence of production integration, rights approval, index eligibility, or purchasable capacity.

### Rights and operational dependencies

Unauthenticated access is explicit, but benchmark rights are not. Verda's [terms](https://verda.com/terms-and-conditions), last updated September 30, 2025, reserve intellectual-property rights in clause 3.3; clause 6.1.4 restricts copying, derivative works, and distribution, subject to non-excludable law; clause 6.1.5 restricts replicating or competing services. Clause 6.1.2 concerns malicious automation, not a blanket ban on every documented API request. These clauses require review for this use case. Keep benchmark derivation, raw redistribution, and public-price publication unapproved pending legal review or a written permission agreement. Verda is identified in these terms as DataCrunch Oy.

Before recurring collection, record the approved polling scope and cadence; use bounded requests and normal backoff. Obtaining account access for stock or location data would be a separate step and would not itself grant publication rights.

## Nebius

The [documentation index](https://docs.nebius.com/llms.txt) exposes an official, no-key [pricing Markdown document](https://docs.nebius.com/compute/resources/pricing.md). Its successful response was 13,232 bytes, SHA-256 `bfa58ca161baeaeba7a69041e18bf76846f4e53644b6a38cbb24ee49078b79c3`. The corresponding [rendered pricing page](https://docs.nebius.com/compute/resources/pricing) contains B200 and B300 GPU-compute prices, with regular and preemptible terms and separate currency tabs. It also distinguishes public and private regions. This is provider documentation, not an independently verified transaction feed.

No documented unauthenticated structured pricing API was found in this review. That is a research limit, not proof that none exists. General [API access-token documentation](https://docs.nebius.com/iam/authorization/access-tokens) describes authenticated access.

Parser requirements before integration:

- Restrict parsing to the exact USD compute section, explicit platform identifiers, and regular/preemptible columns. Do not blend storage or network tables into GPU rates.
- Preserve private-region scope; do not present it as a generally available public quote. Billing-currency eligibility is not the same as datacenter location.
- Resolve physical instance presets using [platform documentation](https://docs.nebius.com/compute/virtual-machines/list-platforms). A per-GPU table alone does not establish a purchasable instance size or minimum order.
- Keep stock unknown; archive the original Markdown; reject changed headings or ambiguous table structure.
- Review [legal documents](https://docs.nebius.com/legal) and obtain the necessary use and publication rights. No such approval was established here.

This is a promising small public document, but a Markdown parser has weaker schema guarantees than Verda's documented JSON endpoint. No Nebius collector was implemented in this lane.

## AWS

### No-key bulk access is real

AWS documents [manual public price-list retrieval](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/using-the-aws-price-list-bulk-api-fetching-price-list-files-manually.html): discover the service, obtain its regional index, and fetch the returned region/version path. The unauthenticated [current EC2 region index](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/region_index.json) returned HTTP 200, 18,705 bytes, and 106 region entries. Its publication time was `2026-09-04T23:11:17Z`, version `20260904231117`, SHA-256 `fb0828354b43adef86c7ed06044513a0bc3219904fb12514985ce5cb4d168c97`. Pin the URL returned by this index instead of combining mutable `current` paths or guessing region identifiers.

HEAD probes only; these large files were not downloaded:

| Region | Version-pinned JSON size | HTTP |
| --- | ---: | --- |
| `us-east-1` | 481,907,939 bytes | 200 |
| `us-west-2` | 475,326,252 bytes | 200 |
| `ap-south-2` | 201,730,298 bytes | 200 |
| `us-gov-east-1` | 206,546,799 bytes | 200 |
| `us-east-1-dfw-1` | 19,967,788 bytes | 200 |
| `us-east-1-atl-1` | 30,157,079 bytes | 200 |

Paths follow `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/20260904231117/<region>/index.json`. Responses supported byte ranges. The EC2 availability-zone identifier `us-east-1-dfw-2a` was not a listed regional file and a guessed file path returned 404. Availability zones and price-list region keys are not interchangeable.

### Product and procurement boundaries

Official [accelerated instance specifications](https://docs.aws.amazon.com/ec2/latest/instancetypes/ac.html) support these mappings:

| Instance type | GPU model | Physical GPUs per instance | Qualification |
| --- | --- | ---: | --- |
| `p6-b200.48xlarge` | B200 | 8 | Match exact product attributes and term. |
| `p6-b300.48xlarge` | B300 | 8 | Match exact product attributes and term. |
| `p6e-gb200.36xlarge` | GB200 | 4 | UltraServer order size may exceed one instance. |
| `p6e-gb300.36xlarge`, `p6e-gb300.72xlarge` | GB300 | Unverified | Names appear in official EKS/PCS documentation; physical GPU-count mappings were not established. |

AWS announced [P6e-GB300 general availability](https://aws.amazon.com/about-aws/whats-new/2025/12/amazon-ec2-p6e-gb300-ultraservers-nvidia-gb300-nvl72-generally-available/), and the [PCS guide](https://docs.aws.amazon.com/pcs/latest/userguide/capacity-blocks-nvidia-imex.html) names both sizes. An EKS workload requesting four GPUs does not establish an instance's total capacity. The collector therefore queries these names for private discovery but does not normalize GB300 until an authoritative [DescribeInstanceTypes](https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_DescribeInstanceTypes.html) response or hardware specification establishes the exact GPU count and commercial terms. No price is substituted.

AWS's [Capacity Blocks guide](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-capacity-blocks.html) and [pricing page](https://aws.amazon.com/ec2/capacityblocks/pricing/) describe a distinct reservation product, including GB200 UltraServer orders of 36 or 72 GPUs. A four-GPU instance denominator does not imply a four-GPU minimum purchase. Keep capacity-block quotes separate from on-demand and spot. A zero Linux software charge on the pricing page is not zero-cost GPU hardware.

AWS's [price-list format](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/reading-service-price-list-file-for-services.html) separates products and terms in JSON; join them by exact SKU. Preserve term type, effective date, currency, unit, operating system, tenancy, and software conditions. Do not infer spot prices from an on-demand or reserved catalog.

### Practical ingestion recommendation

The probed regional files exceed this collector's 10 MiB response cap, and several exceed the Worker runtime's memory budget. They are not suitable for repeated full-body parsing inside the current Durable Object cycle. Smaller local-zone files are not substitutes for the correct product region.

If no AWS pricing credentials are available, implement a separately budgeted streaming ingestion job: discover versions, select explicit regions, avoid unchanged downloads, cap download bytes and duration, and retain original versioned evidence in private object storage. Filter only after complete parsing and exact SKU/term joins. Partial byte ranges must not be represented as a complete catalog. Do not silently treat a HEAD recheck as a newly fetched price record. Independent nodes should verify original evidence, not merely trust a centrally filtered price feed.

For immediate narrow lookups, the existing authenticated Query adapter is the simpler operational route; it needs appropriate AWS credentials. Public file access does not establish benchmark redistribution rights. Review the applicable [AWS terms](https://aws.amazon.com/service-terms/) and pricing conditions before approving publication. No bulk collector was implemented or full regional catalog downloaded in this lane.

## Remaining decisions

- Approve private recurring-collection scope separately from public-price and derived-index rights.
- Integrate Verda in the catalog and registry without changing unknown inventory or adding fictitious region coverage.
- Check independent provider concentration by model; multiple SKU sizes must not increase provider votes.
- Decide whether Nebius's public documentation justifies a maintained parser after preset and scope verification.
- Obtain narrow AWS Query access, or fund the external bulk-ingestion and evidence-storage path.
- Re-run live collection and verify private evidence persistence in the deployed environment. Local success alone does not establish production acceptance.
