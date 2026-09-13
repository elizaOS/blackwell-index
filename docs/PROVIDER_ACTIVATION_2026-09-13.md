# Website provider activation

The operator confirmed permission on September 13, 2026 to add Runpod, Hyperstack and AWS pricing to the website demo. This records the operator's confirmation, not an independent licensing review.

The hosted collectors use existing server-side credentials. Their prices are offers or catalog prices, not settled transactions. Collection permission and demo display/derivation are separate from governed oracle publication. Oracle weights, quorum and Pyth publication gates remain unchanged. Explicit registry collection denials remain authoritative.

Providers is removed from the navigation. The page remains available at /providers.html.

Live verification found 101 observations on each hosted node: Oracle 4, Azure 38, Verda 22, Runpod 1, Hyperstack 2 and AWS 34. AWS returns three NO_DATA diagnostics for uncovered queries. The deployment verifier reports partial catalog coverage as a warning only when observations exist and NO_DATA is the sole error code; authentication, transport and other failures remain blocking. Missing prices stay unavailable.

## Remaining integrations

- Prime Intellect: authenticated availability requests returned no qualifying inventory; do not invent prices.
- Google Cloud: verify SKU bundles and GPU quantities before publishing normalized GPU-hour prices.
- Vast: obtain a suitably scoped credential before hosted activation.
- Lambda: resolve account access/billing and obtain an API credential.
- Shadeform: resolve the API access/redirect issue.
- Transaction data: obtain actual settled-deal records and corresponding use rights; catalog credentials do not provide these.
