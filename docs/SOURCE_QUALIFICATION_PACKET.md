# B200 source qualification packet

Prepared September 8, 2026 from current official provider documentation and this local checkout. This is an unsent working packet for the SBX benchmark owner. It changes no collector configuration, source permission, constituent, weight or publishing setting. Named owner roles below are proposed responsibilities; individuals and legal entities still need to be assigned.

## Recommendation

**Qualify Lambda first for the proposed eight-GPU HGX B200 scope, with Hyperstack as the fallback.** This is a product-fit research priority, not constituent admission. Lambda's official on-demand announcement identifies eight-GPU HGX B200 instances, and its current specifications distinguish that configuration from smaller B200 sizes. Reconcile those public claims with a genuine retained response and an exact commercial offer before admitting it. [Lambda announcement](https://lambda.ai/blog/nvidia-b200-lambda-on-demand-cloud), [on-demand specifications](https://docs.lambda.ai/public-cloud/on-demand/).

The next step is a provider-approved, read-only sample identifying the full eight-GPU instance tariff, SKU and region, plus written confirmation of topology, physical exclusivity, billing bundle, price applicability and permitted use. No GPU purchase or deployment is needed. Lambda's existing collector now has archive-only replay coverage, but this review contains no genuine retained Lambda sample or authenticated API conformance evidence. See the [source audit](B200_SOURCE_AUDIT.md).

Hyperstack's catalog identifies the eight-GPU `n3-B200-SXM6x8` flavor in CANADA-1. Its exact HGX mapping, current stock, applicable tariff and required extra charges remain unresolved. If Lambda cannot supply suitable evidence, request Hyperstack's matching pricebook/flavor/stock responses. [Hyperstack flavors](https://docs.hyperstack.cloud/docs/hardware/flavors/), [pricebook semantics](https://docs.hyperstack.cloud/docs/billing/pricebook/).

Runpod remains a candidate only after it supplies an actual public on-demand eight-GPU offer. Its current collector requests one GPU; an HGX infrastructure description or a deployment-size list does not turn that quote into a full eight-GPU tariff. The previous Runpod-first recommendation reflected parser readiness, not fit to the now-proposed product. [Runpod B200 guide](https://www.runpod.io/articles/guides/nvidia-b200), [local qualification limits](RUNPOD_QUALIFICATION.md).

## Confirmed public information and its limits

| Source | Public statement checked on September 8 | What remains unproven |
| --- | --- | --- |
| Runpod hardware | Its GPU reference lists NVIDIA B200 with 180 GB memory. [GPU types](https://docs.runpod.io/references/gpu-types) | Exact host configuration, physical GPU exclusivity, interconnect, location and obtainable capacity for the returned quote |
| Runpod commercial terms | On-demand has no term commitment; compute and storage are billed separately. Enterprise custom pricing is available. [Pod pricing](https://docs.runpod.io/pods/pricing) | Whether our authenticated result is the public standard rate, what CPU/RAM it includes, and the complete required configuration charge |
| Runpod API | The documented GraphQL GPU query exposes `lowestPrice`; its schema has nullable `minMemory`, `minVcpu`, `minDisk`, `countryCode`, `stockStatus` and `availableGpuCounts`. [Query examples](https://docs.runpod.io/sdks/graphql/manage-pods), [schema](https://graphql-spec.runpod.io/) | Field semantics, units and whether those properties refer to one simultaneously rentable offer; nullable fields are not evidence of capacity |
| Runpod cloud classification | Its documentation distinguishes Secure Cloud data centers from Community Cloud peer-to-peer providers. [Choose a Pod](https://docs.runpod.io/pods/choose-a-pod) | The price-setting legal entity, ultimate control and upstream host overlap with other constituents; a Secure Cloud label is not an ownership audit |
| Lambda | Public on-demand specifications list an eight-B200 configuration with CPU, RAM and SSD entitlements; the earlier on-demand announcement explicitly identifies HGX. [Specifications](https://docs.lambda.ai/public-cloud/on-demand/), [announcement](https://lambda.ai/blog/nvidia-b200-lambda-on-demand-cloud), [pricing](https://lambda.ai/pricing) | Exact live SKU/region, current HGX mapping and physical exclusivity, public-versus-account pricing, mandatory charges, billing minimum and source license. Public documentation is not an authenticated API observation. |
| Hyperstack | The flavor catalog identifies `n3-B200-SXM6x8` in CANADA-1 with CPU, RAM, root and ephemeral disks. Its pricing documentation distinguishes base resources and additional charges. [Flavors](https://docs.hyperstack.cloud/docs/hardware/flavors/), [pricebook](https://docs.hyperstack.cloud/docs/billing/pricebook/) | HGX topology, physical exclusivity, VRAM reconciliation, actual stock, exact billing minimum/increment, required IP/storage treatment and permitted financial-reference use |
| Oracle | Official shape documentation specifies `BM.GPU.B200.8` with eight B200 GPUs and local NVMe storage. [Compute shapes](https://docs.oracle.com/en-us/iaas/Content/Compute/References/computeshapes.htm) | That a global catalog tariff is currently executable in the chosen region and has a bundle comparable to the other selected offers |
| Verda | Its separate Instant Clusters product documents B200 SXM6 and location/interconnect/storage details. [Instant Clusters](https://docs.verda.com/clusters/instant-clusters/) | Those cluster details cannot be transferred to the single-instance SKUs in our journal without a provider mapping |

Runpod's site terms address systematic data retrieval and automated access, including a written-permission requirement for compiling site data. Its API documentation separately provides programmatic queries. This is a reason to obtain and review the applicable API/data-use permission for SBX, not a conclusion that all documented API use is prohibited or that an existing account grants financial-reference rights. [Runpod terms, section 9](https://www.runpod.io/legal/terms-of-service).

## Match the commercial product before adding a third vote

The current research panel is Oracle and Verda. Oracle's collector represents an eight-GPU bundle with CPU, memory and local storage; Verda represents one-, two-, four- and eight-GPU bundles with CPU/memory and separately priced storage. Runpod currently asks for one GPU in Secure Cloud and records the GPU price component, a global region, and `PUBLIC`/`LIST` classifications. Those classifications are collector assumptions to verify, not provider attestations. [Collector comparison](RUNPOD_QUALIFICATION.md).

The benchmark owner must approve the product scope before admission. The current proposal is **public on-demand rental of an exclusive eight-physical-GPU HGX B200 instance, expressed per GPU-hour, retaining its full billed bundle and minimum order**. This follows the [methodology decision draft](B200_METHODOLOGY_DECISIONS.md) and [contract proposal](B200_CONTRACT_PROPOSAL.md); it does not claim a pure GPU commodity price. Freeze an evidenced provider/region/SKU schedule rather than broadening scope silently to find a third supplier. A B200-only publication policy does not itself establish eight-GPU HGX eligibility.

For each candidate, obtain the actual full-instance charge and included CPU, RAM, local disk, required extra storage and network terms. Keep separately priced storage separate unless a reviewed methodology specifies an evidence-backed standard configuration. Do not subtract a guessed Oracle disk value, multiply a one-GPU Runpod rate into an eight-GPU product, or infer that a minimum of eight rentable GPUs means an eight-GPU quote was returned. If the final scope requires a whole HGX node, request that exact offer rather than relabeling a single-GPU response.

Different product variants from one seller count within its economic group; reseller quotations must be mapped to the actual price-setting exposure. A company name, domain, registry label or extra collector is insufficient proof of an independent third economic source. Current `minProviderGroups: 3` and collector quorum are SBX rules in `src/config.ts`; this packet does not present them as Pyth's custom-feed admission requirements.

## Evidence and ownership checklist

| Deliverable | Proposed accountable owner | Present status | Completion evidence |
| --- | --- | --- | --- |
| SBX contracting identity and contact | Benchmark sponsor | UNASSIGNED | Named legal operator, commercial contact and technical contact |
| Read-only pricing access | Provider account owner + engineering | Lambda/Hyperstack/Runpod adapters exist; live access not validated by this review | Explicitly authorized account/key scope, documented endpoint and permitted rate; no key in this packet or Git |
| Commercial offer mapping | Provider technical contact + SBX methodology owner | OPEN | Exact SKU, physical GPU count/model/VRAM, tenancy, topology, location, minimum order, bundle and total invoice unit |
| Rate applicability | Provider pricing owner | OPEN | Public list or documented account/contract scope; exclusions for promotions, savings plans, taxes, credits and spot pricing |
| Data permissions | SBX rights/legal owner + provider | OPEN; registry flags do not prove a license | Reviewed evidence covering collection, retention, derivation, redistribution, history/corrections and intended financial-reference use; permitted recipients and expiry |
| Economic independence | SBX methodology owner + provider | NOT_ESTABLISHED | Price-setting entity, ultimate controller, reseller/host arrangement and overlap review with Oracle/Verda and other candidates |
| Genuine retained sample | Engineering | No genuine Lambda or Hyperstack sample reviewed here; Runpod absent from the last reviewed frozen journal | Request specification without secrets, response bytes/hash, actual retrieval time, normalized observations and collector/config revisions |
| Replay and semantics | Engineering + independent reviewer | Lambda and Runpod archive-only replay implemented and tested with synthetic fixtures; independent live semantics remain open | Deterministic replay plus independent review of unit, request, bundle, price scope, region and inventory interpretation; Hyperstack needs matching retained evidence and a reviewed replay extension |
| Sustained coverage | Collection operator | History contains a known collection gap | Actual scheduled captures, per-source failures/latency, response-change counts and coverage against the approved interval/window |
| Admission and weights | Benchmark administrator | DRAFT; no candidate approved here | Signed decision binding constituents, economic groups, evidence, weights, scope, effective time and versioned failure/correction policy |

Keep private agreements and account details in protected storage and put only an approved reference or digest in the public configuration. A source can allow private collection while withholding redistribution. Permission for a public demo also does not automatically cover a live derivative or independent SBX operators.

## Minimal engineering sequence after access and scope are confirmed

1. Use `lambda-cloud` for one supervised, explicitly permitted read-only sample from the supported instance-types endpoint. Confirm the least-privilege access and polling limits with Lambda; the public API browser is a reference, not evidence that the account or current response has been verified. No deployment mutation is needed. [Lambda API browser](https://docs-api.lambda.ai/).
2. Retain the credential-free endpoint/request specification with protected response bytes and actual retrieval time. The source audit verifies retained responses but does not independently attest the original request, account entitlements, or TLS session. Preserve real timestamps rather than regenerating historical captures.
3. Reconcile the exact eight-GPU SKU and full-instance amount with the provider's written topology, CPU/RAM/disk, geography, billing and price-applicability specification. Lambda's inactive [resource-quantity mode](INSTANCE_RESOURCES.md) validates documented full-instance vCPU/RAM/storage fields and preserves legacy records; it does not prove contractual entitlements or emit topology. Unknown fields remain unknown; do not import a marketing label into a retained observation or borrow 1-Click Cluster terms for an on-demand instance.
4. Run `audit-sources`, then compare eligibility and commercial terms with the existing sources. Preserve missing/unavailable states. A successful parse, response hash or available stock label alone does not admit a constituent.
5. Collect on the approved interval with supervision. Report coverage both since the new source started and over the full qualification window. Never fill the September 6–8 gap, copy another source's price, or treat repeated identical responses as independent trades.
6. Have the administrator review the evidence and freeze the panel/weights. Re-run the shadow study using the fixed decision. Production source settings remain unchanged until that decision is recorded.

Lambda's offline replay extension is implemented. It checks the canonical instance-types endpoint, uses a fixed non-secret Bearer placeholder and serves retained bytes in memory. Synthetic tests cover no available regions, one region and multiple regions, and reject forged topology, bundle, GPU count, region, source-record ID and price. A missing topology remains `TOPOLOGY_UNKNOWN`; successful reproduction does not supply commercial or rights approval.

For the Hyperstack fallback, reuse its existing collector and obtain the matching pricebook/flavor/stock triplet before extending archive-only replay. For Runpod, first obtain one actual eight-GPU full-instance offer; then reconcile request semantics and adjust its current one-GPU collection path if justified. Do not multiply a single-GPU price or infer a full-node quote from available deployment sizes.

## Unsent provider request

**Audience:** Lambda pricing/API owner and data licensing contact; use the equivalent Hyperstack contacts if the fallback is selected. **Sender:** the appointed SBX legal operator. No message has been sent and no specific person is asserted to have accepted ownership.

**Subject:** B200 pricing data qualification for the Blackwell Index

We are developing SBX, a proposed benchmark of public, on-demand, exclusive eight-physical-GPU HGX B200 instance tariffs normalized to USD per GPU-hour. We intend to use Pyth for an agreed delivery route and are evaluating a cash-settled compute market. No provider, Pyth integration or market admission is represented as approved.

Could you identify the right technical and licensing contacts and confirm:

- The supported read-only instance-types/pricing endpoint, least-privilege access, polling limits, and whether returned rates are standard public prices or account-specific. Please supply one redacted response identifying the exact commercial SKU, full-instance hourly total, retrieval time and applicable region.
- What that eight-GPU amount purchases: B200 model/count/VRAM, HGX topology and physical exclusivity, CPU, RAM, disk and required add-ons; currency, taxes, billing increment and minimum billable duration; location and minimum order.
- Whether the reported price and stock/location fields identify one simultaneously obtainable offer, what null inventory means, and whether a quote is a tariff or an executable offer. Can you supply a stable offer identifier and price-effective time?
- Which legal entity sets the rate, which entity controls it, and whether it is a reseller or shares underlying supply/price control with other clouds. Confidential evidence can be handled by our appointed reviewer.
- Whether you can authorize automated collection and retention, benchmark derivation, publication of the index and agreed source/history data, delivery through Pyth, and reference by the intended derivative market. Please specify attribution, recipients, limits, fees, expiry, corrections and termination requirements.
- How pricing/schema changes, outages and corrections are communicated, and whether a read-only sample or historical export is available for qualification.

We can provide a precise schema and intended-use description. We are not requesting GPU deployment or claiming an existing data license. Once the permitted scope is agreed, we will retain the evidence privately and return our mapping for technical review.

## Exit decision

Proceed with a candidate only when its permitted-use scope, commercial mapping and economic-group assignment are reviewable and its genuine data passes the agreed operational criteria. Otherwise retain it as a research candidate and pursue the fallback. Third-source qualification does not resolve Pyth service acceptance, independent operator admission, venue rules or market liquidity; those remain separate items in the [Pyth local acceptance checklist](PYTH_LOCAL_ACCEPTANCE.md).
