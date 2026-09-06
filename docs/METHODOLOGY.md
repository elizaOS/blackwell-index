# SBX methodology

Version 0.1.0 is a research specification. No approved market-share weights or public benchmark qualification are claimed.

## Measurement

The primary basket measures the listed USD cost of renting one physical accelerator-hour within an exclusive Blackwell instance, including the instance services represented by the source tariff. B200, B300, GB200 and GB300 are four product families. A Grace Blackwell machine is classified by its system SKU, even when a source describes its underlying GPU as B200 or B300. GB instances are never duplicated in standalone B feeds.

Each record retains provider, source, model, full SKU, physical GPU count, instance price, normalized price, region, procurement, price basis, tenancy, included components, availability, source URL and raw-response digest. Minimum order and topology are preserved when known. An NVL72 rack can contain 72 GPUs while the quoted node contains four; these counts have different meanings.

`normalized price = instance hourly tariff / physical GPU count`.

Arithmetic uses integer millionths of a dollar and round-half-up when division is needed. A source already quoting per GPU-hour is converted to the appropriate full instance amount before the general normalization check; it is never divided twice. Non-USD quotes need a separately specified and licensed FX methodology before admission.

List tariffs do not assert available capacity. Executable prices require an available offer, correct term and expiry. Historical tariff effective dates are distinct from retrieval time: a freshly checked current tariff may have been unchanged for months. Source retrieval freshness uses `observedAt`; future-effective or expired quotes are ineligible.

## Calculation

1. Validate schemas, signatures, network, admitted identities, timestamps, authoritative source hosts and permissions.
2. Match provider/source/SKU/model/region/commercial terms across collectors. Each admitted operator group supplies one vote even if it runs many keys. Require `max(minOperatorGroups, floor(2 * admittedOperatorGroups / 3) + 1)` agreeing groups. Agreement is a relative deviation threshold around the median, with all included inputs and thresholds disclosed.
3. Within each provider and model, take the median across eligible matching SKUs in each region, then the median across regions. This keeps a provider's numerous price-list rows in one region from automatically dominating the provider feed. It is a quoted-tariff summary, not a volume-weighted transaction rate.
4. Consolidate providers in the same economic group. Use explicit fixed group weights to calculate `sum(group price * weight) / sum(weight)`. Require the configured minimum independent groups and every fixed-weight constituent. Model-specific constituent sets may differ.
5. Compute `SBX = sum(model price * fixed model weight) / sum(model weight)`. All four model weights are positive and all four model feeds must be ready. The draft model weights are equal. A missing component makes SBX unavailable.

The `confidence` field is an absolute maximum observed input-deviation bound propagated through the basket. It is not a probabilistic interval, bid/ask spread or guarantee. Coverage, freshness, independence and dispersion remain separate evidence. Pyth's own publisher-dispersion field measures a different aggregation stage.

## Weights and representation

There is no universal industry-standard Blackwell weighting scheme. Established index families use equal, fixed, market-capitalization and other weighting rules, each matched to its objective. Transaction weighting requires real executed quantities; GPU listing counts and reported fleet sizes are unsuitable substitutes. The initial equally weighted model basket is transparent and reproducible, but does not estimate installed industry capacity or equal AI throughput. [S&P index mathematics](https://www.spglobal.com/spdji/en/documents/methodologies/methodology-index-math.pdf).

IOSCO's benchmark principles address representativeness, sufficient data, governance and methodology transparency; implementing an average does not establish compliance. Formal applicability, administrator obligations and independent review must be assessed before financial-reference use. [IOSCO principles](https://www.iosco.org/library/pubdocs/pdf/IOSCOPD415.pdf).

## Changes and limitations

Weights, eligibility rules, provider ownership and source permissions are versioned. Changes must be announced with an effective time and supporting evidence. Do not silently alter old snapshots. If continuity across basket reconstitution is needed, launch a separately defined chain-linked level; the current absolute USD/GPU-hour basket is not a total-return index.

Material limitations include advertised-versus-realized price, customer-specific discounts, availability uncertainty, regional composition, bundled CPU/network differences, minimum order, financing/commitment terms, source errors and missing market segments. Backtests must quantify these limitations. Tight agreement between collectors checking the same webpage says little about underlying market representativeness.
