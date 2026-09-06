# Operating costs and ownership

Planning assumptions as of 6 September 2026. A working collector is not evidence of a licensed benchmark, and a hosting estimate is not a Pyth or data-provider quote.

| Item | Known amount or basis | Owner and decision needed |
| --- | --- | --- |
| Four domains | $78.06 paid for one year; current renewal quotes total the same amount | Organization administrator; automatic renewal is currently off; confirm renewal before September 2027 |
| Current hosted collectors | Two SQLite Durable Objects and one Worker, with a five-minute interval | Infrastructure owner; review actual account plan, shared usage, limits and billing alerts |
| Provider APIs | Oracle and Azure public catalog requests currently need no key | Data owner; obtain applicable publication rights; quote other APIs and data licensing separately |
| Pyth publisher | No commercial publisher terms agreed | Business owner and Pyth; admission, feed support, ingress and any fees need a written quote |
| Pyth consumer access | Account and appropriate API plan required for ongoing authenticated use | Product owner; confirm the plan covers these feeds and public distribution |
| Independent operators | No external operators contracted or budgets agreed | Network owner; fund genuinely separate administration and source access where required |
| Signing and monitoring | Isolated publisher host, secret custody, alerting and backups not priced | Infrastructure/security owner; size after publisher requirements are confirmed |
| Review and licensing | External security, benchmark and data-rights review not quoted | Organization leadership; obtain scopes and quotes before financial-reference use |

Cloudflare currently makes SQLite Durable Objects available on both Free and Paid plans. The published Free allowances include 100,000 requests/day, 13,000 GB-seconds/day, 100,000 written rows/day and 5 GB total storage. Those allowances are account-wide, not reserved for this project; exceeding a free limit causes failures. Paid usage has different included allowances and overage pricing. No new paid plan was purchased as part of this deployment. [Cloudflare pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)

At an idealized five-minute cadence, two nodes make at most 576 collection cycles/day before accounting for collection duration. Five current provider requests per cycle imply approximately 2,880 provider requests/day. The recovery cron adds about 192 object wake requests/day. Website traffic, peer submissions, retries and future collectors are additional. These are calculations from configuration, not measured billing. Review each provider's rate limits before adding a broader or credentialed collector.

Identical response bodies are deduplicated by hash; capture and snapshot history continues to grow. Observe actual storage growth rather than projecting from one response. Assign a storage threshold, authenticated export procedure, retention policy and tested recovery process before sustained production use. Do not prune signing high-water marks or restore old nonces as a shortcut.

Pyth's August 2026 Core upgrade requires API authentication for Hermes, and ongoing access is covered by paid plans after the trial. A consumer subscription neither admits a publisher nor creates an SBX feed. [Pyth upgrade requirements](https://docs.pyth.network/price-feeds/core/upgrade/preparing)

No compute allocations, GPU rentals, API subscriptions or trading commitments were purchased to validate the catalog adapters. Invoice reconciliation and executable-capacity tests require a separately approved provider account and explicitly bounded spend.
