# Optional B200 publication scope

The engine supports an explicit B200-only publication policy. It is inactive in every bundled/default configuration. Existing methodologies without this field still require all four models and the SBX composite; their canonical configuration and snapshot bytes remain unchanged.

## Methodology and delivery binding

The optional methodology field has this shape. The evidence value below is a placeholder, not an approval:

```json
{
  "publicationScope": {
    "kind": "MODEL",
    "model": "B200",
    "approvalEvidence": "REPLACE_WITH_REVIEWED_PROTECTED_EVIDENCE_REFERENCE"
  }
}
```

Selecting a scope does not approve a methodology. Publication still requires `status: APPROVED`, an effective version, at least three configured economic provider groups for B200, the admitted operator quorum, source rights, all fixed constituents, freshness and dispersion checks. Unused models may have empty provider weights. All four model-weight fields remain in the schema, and composite calculation itself is unchanged.

The scope and its evidence are included in the methodology hash. Scoped snapshots carry only `publicationScope: {kind: "MODEL", model: "B200"}` alongside their exact methodology and registry hashes. Their `publishable` flag means the configured B200 publication scope is ready; it does not approve other calculated feeds or attest to external rights or market acceptance.

Native Pyth manifests must explicitly contain the same scope and may bind only `SBX:B200`. A scoped snapshot with an unscoped manifest, an unscoped snapshot with a scoped manifest, a broader binding, or a mismatched feed identity fails closed. Existing approval expiry, protocol, catalog, hash and source-time checks still apply. Neither this policy nor its tests assigns a Pyth feed ID.

Readback reproduces the retained snapshot before deriving expected prices, checks the matching scope, and binds that scope into its persisted policy identity. Changing a scope requires state review; it cannot silently reset accepted timestamps. Publisher watermarks continue to follow actual source timestamps. Encrypted recovery reproduces the scoped calculation and rejects removed or altered scope metadata, including when an archive history hash is recomputed.

## API and website

`/v1/feeds` retains all calculated feeds as diagnostics and includes the scope. Consumers must inspect that scope; a globally true `publishable` flag does not make every feed publishable. `/v1/feeds/:id` exposes a scope-aware per-feed flag. `/v1/ready` describes readiness of the configured scope and returns it explicitly. Legacy responses omit the new field.

Real mode shows the B200 benchmark and labels its scope. Other model and provider prices remain hidden in the scoped presentation, even when they calculate successfully. Pyth publication remains labeled unverified. Demo mode cannot claim this publication policy. The browser's checks are display safeguards; authenticated benchmark reproduction and agreed consumer verification remain necessary.

## Product boundary

Model scope alone does not enforce commercial offer eligibility. A separate [optional fixed offer schedule](B200_OFFER_SCHEDULE.md) now enforces exact eight-GPU HGX membership, including source identity, SKU, region, component labels and minimum order. It is inactive. Optional [resource metadata](INSTANCE_RESOURCES.md) enforces exact reported vCPU/RAM/storage quantities. Contractual entitlements, commercial comparability and genuine source approval remain separate qualification work. Do not describe a scoped B200 calculation as an approved eight-GPU HGX benchmark.

Before activation, approve the exact commercial scope and eligible-offer schedule with supporting source evidence, verify the provider mappings and any required quantitative entitlement checks, approve fixed weights and operating policy, and complete the selected Pyth and venue acceptance. See [methodology decisions](B200_METHODOLOGY_DECISIONS.md), [contract proposal](B200_CONTRACT_PROPOSAL.md) and [Pyth resolver acceptance](PYTH_HIP3_RESOLVER_ACCEPTANCE.md).
