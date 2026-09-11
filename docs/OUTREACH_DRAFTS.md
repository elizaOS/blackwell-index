# SBX outreach drafts

Updated September 10, 2026. **These drafts are unsent.** They do not describe the status of separate partner applications or conversations. Replace the sender/legal-operator details and review the recipient and content before sending. Authorization to publish code-review PRs does not authorize sending these partner messages. These drafts do not authorize a purchase, trial acceptance, credentials, deployment or market launch.

Use the message that fits the recipient, with the [partner packet](PYTH_PARTNER_PACKET.md) available for a follow-up. The B200-specific provider and venue templates below are conditional on selecting that pilot; they do not commit V1 to B200. Do not attach raw provider responses, the private research database, secrets, private agreements or unreviewed local artifacts.

## Pyth introduction

**Subject:** Blackwell compute rental-price oracle — Pyth technical onboarding

Hi Pyth team,

We are Eliza Research, developing Blackwell Index (SBX), an oracle for NVIDIA Blackwell GPU compute rental prices. Our goal is open data collection, independently reproducible aggregation and decentralized governance. We have a prototype covering B200, B300, GB200 and GB300. We are defining the V1 scope and exploring a first Hyperliquid market with Pyth; a narrower B200 basket is one candidate.

We have collectors, exact calculation, signed-report admission, source-age checks, retained evidence and local tests using official Pyth code. The demonstrated inputs are advertised offers and tariffs, not executed rental transactions. Independent operations, source permissions and the launch methodology are still being established. We can supply a revision-specific test receipt; local tests do not establish live SBX publication or market acceptance.

Could you help us settle these points?

1. Should independent SBX operators supply a reproducible benchmark through managed HIP-3 ingestion, or apply as native Pro/Core publishers? What admission is required, and how would Pyth aggregation preserve the selected benchmark?
2. What supported schema, authentication and test environment should we use? We need to preserve benchmark version, original provider-retrieval age and an explicit unavailable state through delivery.
3. How do you preserve the same fixed benchmark during endpoint failover, and what independent receipts show the exact value and source age consumed by the market?
4. What remains our responsibility versus Pyth's and the operator's for data rights, source supervision, signing, outage response and recovery? What are onboarding/access/fee terms, and can you introduce a suitable existing operator?

We have also integrated separate Base signed-update consumer work. Earlier upstream BTC verification establishes connectivity only; we are not assuming it qualifies SBX or is required for managed HIP-3. We can share a concise methodology and acceptance packet once the relevant team is identified.

Thanks,
[Sender / organization / role]

**Preparation note:** Pyth's current official page documents custom API/WebSocket sources and managed submissions. The questions above request SBX-specific confirmation. [HIP-3 service](https://docs.pyth.network/price-feeds/hip-3-service) (checked September 8, 2026).

## Provider evidence and permission request

**Subject:** B200 tariff evidence and benchmark-use permissions for Blackwell Index

Hi [provider team],

We are evaluating [specific B200 SKU/API/catalog] as a source for Blackwell Index, a proposed USD/GPU-hour rental-tariff benchmark intended for possible cash-settled financial contracts delivered through Pyth. No source admission or permission for that use is assumed.

Could you identify the right technical and data-licensing contacts and confirm:

1. The legal entity setting the price and any underlying host or reseller relationship; whether the tariff is generally available public on-demand pricing or depends on an account, commitment or discount.
2. The exact physical B200 count/topology, region, billing minimum, and complete mandatory GPU/CPU/RAM/storage charges. Please distinguish optional storage/network charges and provide an actual eight-GPU quote if one exists; we will not infer it from a one-GPU price.
3. How you define capacity/availability, tariff effective time, corrections and discontinued offers; which documented read-only feed and collection rate you support.
4. Whether [legal benchmark operator] may automate retrieval, retain evidence, derive an index, redistribute raw or aggregated values, and use/license the index as a financial-contract reference including oracle/onchain distribution. Please state beneficiary entities, attribution, retention limits, territories, fees, revocation and notice terms separately.

We can supply the proposed exact use and protect nonpublic evidence through an agreed channel. Public website access or API access will not be treated as permission for redistribution or financial-reference use. This request is for information and proposed terms; it does not accept a paid service or agreement.

Thanks,
[Sender / legal benchmark operator / role]

**Recipient-specific inserts before sending:**

| Provider | Reference to include | Question that must not be lost |
| --- | --- | --- |
| Oracle | `BM.GPU.B200.8`, catalog part `B110978` | Confirm geographic applicability and the GPU/CPU/RAM/local-storage bundle and required charges |
| Verda | `8B200.240V`, USD on-demand tariff | Confirm HGX topology, region and required storage charges; the collector currently records storage as excluded |
| Runpod | B200 Secure Cloud pricing query | Confirm account-independent applicability, price-setting/host ownership, full resource bundle and an actual eight-GPU configuration if offered |

These are separate provider requests. A provider's reply may need a protected agreement and reviewer sign-off; do not convert a vague acknowledgement into rights flags. The [Runpod qualification checklist](RUNPOD_QUALIFICATION.md) records its current gaps.

## Venue/operator introduction

**Subject:** B200 compute rental-tariff market — operator and contract feasibility

Hi [operator team],

We are exploring a cash-settled B200 rental-tariff market using Blackwell Index and Pyth. Our preferred discussion is with an existing HIP-3 operator, with Pyth's managed custom-feed route subject to acceptance. The proposed first underlying is a defined public on-demand eight-GPU B200 instance-tariff basket, normalized to USD/GPU-hour.

This B200 exposure is a candidate within the broader Blackwell project, not an approved V1 commitment. We have local calculation and Pyth integration tests, but provider comparability, rights, methodology and sustained coverage remain open. We have no verified live SBX feed, confirmed executable capacity, approved funding/settlement model or launch-ready liquidity.

Would this exposure fit your customers and market program? In particular:

1. Do users want a rental-tariff perpetual or a dated contract, and what bundle, geography and contract multiplier would make the exposure useful despite differences from a customer's actual bill?
2. What evidence and minimum history would your risk team require for a slowly changing list-tariff benchmark? How should funding/mark or settlement rules address that behavior?
3. Who would own market listing, oracle updates, key custody, risk limits, liquidations/backstop and incident decisions? Which liquidity providers would assess the product?
4. What precisely happens on stale or unavailable benchmark inputs, constituent loss and delivery failure, including any irreversible halt/settlement action? What recovery drill and independent venue readback would you require before acceptance?

We can bring the proposed methodology, failure tests and a Pyth interface checklist to an initial technical/risk discussion. We are seeking feasibility and requirements, not asking you to activate a market or commit liquidity from this message.

Thanks,
[Sender / organization / role]

## What to record from replies

| Reply | Capture as a concrete decision |
| --- | --- |
| Pyth | Named service/contact; acceptance route; supported schema and access; source-time/unavailable semantics; authentication and consumption receipts; responsibility/fee terms |
| Provider | Exact applicable product/tariff; full bundle and geography; economic owner; supported collection; protected rights evidence covering named operator and each intended use |
| Operator | Customer/exposure fit; venue and contract form; risk/history requirements; operating/incident owner; liquidity process; test and acceptance criteria |

Track declined or conditional answers explicitly. No reply, an introduction, a trial key, a signed BTC update or a local test pass constitutes approval of SBX publication or trading. Update the decision record after substantive replies and implement the agreed requirements locally before proposing external activation.
