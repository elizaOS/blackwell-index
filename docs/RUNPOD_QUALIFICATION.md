# Runpod B200 candidate qualification

Local review, September 8, 2026. Runpod is a candidate source, not an approved third independent constituent. No production registry, rights flag, weight, credential or collector schedule is changed.

## Available evidence

Merged [PR #3](https://github.com/elizaOS/blackwell-index/pull/3) and `LAUNCH_TODO.md` report a successful September 6 authenticated pricing check for B200/B300 with nullable deployment counts. This pass incorporates its collector and tests, but the source journal inspected locally contains no Runpod observations or response bodies. The prior live result has not been independently reproduced here. Synthetic tests are identified as fixtures and never enter the retained research journal.

`audit-sources` can now replay a retained Runpod B200 body through the current collector using archive-only transport and a fixed non-secret placeholder. It verifies the complete observation fingerprint, including units, inventory and bundle fields. The endpoint must be the exact credential-free GraphQL URL. This proves parser reproduction when genuine retained evidence becomes available, not provider authentication or the original GraphQL request.

## Commercial comparison

| Source | Current collector representation | Qualification gap |
| --- | --- | --- |
| Oracle | Eight-GPU instance; GPU, CPU, memory and local storage | Global catalog tariff; actual region/capacity and comparable storage policy |
| Verda | One/two/four/eight-GPU instances; GPU, CPU and memory; storage excluded | Region and topology; comparable instance/bundle policy |
| Runpod | One-GPU Secure Cloud query; records only the GPU component; global; list/public classification | CPU/memory entitlement and full configuration cost, geography/topology, ownership, account-independent price applicability and capacity |

Runpod's documentation separates on-demand compute and storage pricing and allows custom enterprise pricing. Consequently, the current observation's `includes: ["gpu"]` is the component the collector records, not proof that CPU and memory are excluded from the commercial product. Do not invent bundle adjustments or assume an authenticated result is universally available. [Runpod pricing](https://docs.runpod.io/pods/pricing), [GraphQL API](https://docs.runpod.io/sdks/graphql/manage-pods).

A null deployment-size list or stock status stays unknown. A known size list lacking one GPU makes the one-GPU quote unavailable; no eight-GPU price is fabricated from it. Repeated SKUs or hosting intermediaries do not establish independent economic ownership. Three configured group labels in a fixture do not establish three independently verified groups.

## Evidence to obtain before admission

1. Retain the actual read-only request specification, credential-free URL, response bytes, retrieval time and normalized observations in protected storage. Establish whether pricing is public list or account-specific; a response hash does not prove this.
2. Reconcile the billed GPU/CPU/memory/storage bundle, minimum order, region and B200 topology. Select offers that match the approved underlying or record why they cannot be included.
3. Document the price-setting legal entity and any upstream host/provider overlap with existing constituents. Review automated collection, retention, derivation, redistribution and financial-reference rights for the intended legal operator.
4. Review sustained coverage and genuine price changes, then approve constituent membership/weights/effective date. Use outages as missing evidence; never backfill a synthetic third source or silently redistribute weights.

Prepare these requests for the source-rights owner. No key, paid account, GPU deployment or external message is required for the offline audit itself.
