# Exact full-instance resource quantities

Observations and scheduled B200 offers can include optional `instanceResources` metadata. It records the whole instance's quantities, independently of the price's USD/GPU-hour normalization:

```json
{
  "schemaVersion": 1,
  "scope": "FULL_INSTANCE",
  "vcpus": 16,
  "memoryGiB": 128,
  "storageGiB": 512
}
```

These numbers are an illustrative schema example, not a real B200 offer. All fields are required when the object is present. vCPU and RAM counts must be positive integers; storage may be zero. Values above one billion, fractional quantities, strings, nulls, unknown keys and other versions/scopes are rejected. GiB means binary gibibytes. A vCPU is not a physical core or an Oracle OCPU. Storage quantity alone does not establish medium, locality, performance or durability.

## Calculation and historical compatibility

The quantities are part of the exact offer and operator-vote identities. Different quantities cannot pool operator votes, even if SKU, price and other fields match. A fixed schedule requiring resource metadata rejects absent or changed quantities; a schedule omitting it matches only an observation that also omits it. Omission means unreported, never zero or a wildcard. Adopting enriched observations therefore requires deliberate review of the schedule and its methodology hash.

Operating studies keep different quantities in different series. Pyth bindings inherit the schedule through the methodology hash, and encrypted recovery retains the exact signed observations and schedule. With no resource field, existing observation, schedule and snapshot bytes remain unchanged. This is an optional extension, not a rewrite of historical records or a new benchmark unit.

Older nodes with the strict pre-extension observation schema reject enriched reports. Deploy compatible parsers to the intended participants before enabling collection of the new metadata and activating an approved matching schedule; this work does not perform that rollout.

## Lambda mapping, inactive by default

The existing `lambda-cloud` source supports an explicit `LAMBDA_INSTANCE_RESOURCES=1` opt-in in its collector environment. Omit the setting to preserve the legacy parser output. Other values are rejected before fetching. No bundled or live configuration enables it.

In this mode, the existing authenticated instance-types request additionally validates and maps `instance_type.specs.vcpus`, `memory_gib` and `storage_gib` directly. They describe the full instance; they are never divided by GPU count, estimated from GPU count or filled from a public marketing price table. Missing or invalid quantities reject that Blackwell row without falling back to the legacy shape. This follows the [official Lambda API schema](https://docs-api.lambda.ai/) checked September 8, 2026. The documented schema and synthetic tests are not authenticated live API conformance.

The same transport source ID and retained response hash are used for both modes. That matters because the journal deduplicates raw response bodies by hash. Source auditing reproduces the legacy shape and, only when enriched observations reference the body, the strict resource shape. Each historical observation must match a complete reproduced fingerprint. The audit does not add quantities to an old observation or excuse forged values. One response can legitimately support both semantic versions without claiming two independent providers or two separate HTTP retrievals.

## Remaining qualification

This extension checks quantities that a provider reports. It does not prove the contractual right to those resources, complete mandatory charges, CPU physical allocation, HGX topology, public-rate applicability, source independence, data permissions or immediately executable capacity. Lambda topology remains unreported and cannot satisfy a required HGX schedule by inference. Other collectors require their own documented mappings before they can supply comparable metadata; no GB-to-GiB or CPU-unit conversion is guessed.

Obtain genuine retained samples and provider confirmations, reconcile all selected offers, and review the exact schedule before activation. See [offer selection](B200_OFFER_SCHEDULE.md) and [source qualification](SOURCE_QUALIFICATION_PACKET.md).
