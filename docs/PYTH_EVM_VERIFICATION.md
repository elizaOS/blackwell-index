# Signed EVM verification

The internal `verifyPythEvmUpdate` adapter verifies an EVM-format Pyth Pro update through the reviewed Base or Base Sepolia contract. It is not yet connected to the SBX readback command or public routes.

## Current behavior

- Requires an explicit simulation sender, not a private key. Makes no transactions or state overrides.
- Validates the bounded envelope and the five requested price properties before network access.
- Checks the chain, deployed version and fee through the existing deployment preflight.
- Pins balance and verification calls to one canonical block hash; rechecks that block and the chain after verification.
- Checks that the contract-returned payload exactly matches the submitted signed payload.
- Returns `CONTRACT_ACCEPTED` only after those checks. The report explicitly leaves SBX policy verification and implementation attestation unperformed. Authority remains a single public RPC.
- Returns no payload on failure. Requests have bounded response sizes, deadlines and cancellation.

The timestamp property includes a presence byte before its unsigned 64-bit value. Zero confidence and publisher count are unavailable values in the reviewed parser; they are not evidence of exact pricing or a valid quorum. Duplicate properties and feed IDs are rejected.

## Evidence and limitations

On September 6, 2026, a locally held Pyth trial consumer key retrieved a real Crypto.BTC/USD EVM update. Base's deployed verifier accepted it through a canonical-block-pinned `eth_call`. An altered signature was rejected. The reusable adapter subsequently accepted another live update. These are consumer diagnostics, not SBX prices, publisher attribution, finalized transactions, or permission to redistribute data. No live payloads or credentials are bundled in the repository.

Unit tests use isolated wire and RPC fixtures. They test decoding and failure handling, not real cryptographic verification. The live diagnostic is separate evidence, not a substitute for an automated official-contract integration harness.

## Remaining integration

1. Wire the shared readback catalog and binding checks into the signed orchestrator. The pure batch checker now reuses feed policy, but does not itself authenticate bytes or approve a manifest. Require actual approved numeric SBX IDs, symbols, exponents, channels, quote currency and minimum publisher counts.
2. Fetch signed updates with the existing bounded authenticated transport. Verify every batch and require the complete expected feed set.
3. Apply the existing source/price freshness, exact mantissa, confidence, expected-print and replay checks to contract-returned bytes only. Recheck all batches at completion and revalidate approval expiry.
4. Reproduce expected prints from the local journal. Do not trust command-line prices or unsigned adjacent JSON as expected SBX evidence.
5. Preserve atomic acceptance and existing private recovery state. A later failed batch must not advance earlier accepted timestamps.
6. Add official-contract integration tests and an operator-facing command, then run full release verification. Keep production activation separate from merging software.

Publisher admission, source rights, independent operators, assigned feeds and genuine qualification history remain launch prerequisites. A consumer trial key does not satisfy them.

## Primary references

- [Pyth payload reference](https://docs.pyth.network/price-feeds/pro/payload-reference)
- [Reviewed Solidity parser](https://github.com/pyth-network/pyth-crosschain/blob/8dd8deee8d115b3ad4cea6ddc615118ba670ee36/lazer/contracts/evm/src/PythLazerLib.sol)
- [Pyth deployed contracts](https://docs.pyth.network/price-feeds/pro/contract-addresses)
- [Canonical block-hash RPC parameter](https://eips.ethereum.org/EIPS/eip-1898)
