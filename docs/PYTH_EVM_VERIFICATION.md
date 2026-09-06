# Signed EVM verification

The internal `verifyPythEvmUpdate` adapter verifies an EVM-format Pyth Pro update through the reviewed Base or Base Sepolia contract. The readback configuration can opt into this path with `signedEvm`, containing `network` (`base` or `base-sepolia`) and an explicit `simulationFrom` address. Public routes are unchanged and supplied configurations do not enable it.

The existing readback command continues to require an approved manifest, current catalog bindings, locally reproduced expectations and a private state database. Signed mode requests EVM bytes only, ignores adjacent unsigned JSON, verifies every batch, then checks all prices at the final clock before persistence. A failed batch or policy check retains the previous accepted feed timestamps. Changing between unsigned and signed mode changes the state scope and requires explicit operator review; never delete an existing state database to bypass that check.

`CONTRACT_ACCEPTED_SINGLE_RPC` in a successful readback report means the contract checks and feed policies passed before persistence completed. It does not mean a transaction was submitted, that independent RPCs agreed, or that our publisher contributed. A consumer key alone cannot enable the approval-gated workflow.

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

## Acceptance status

The integrated path uses existing manifest and catalog checks, journal-reproduced expectations through the command wrapper, and the existing per-feed policy. Tests cover unsigned fallback rejection, later-batch verification failure, policy failure after restart, persistence failure, approval expiry, stale data during verification and cumulative RPC-byte exhaustion. All RPC bodies now count against the same 16 MiB tick budget as catalog and price responses.

Remaining software acceptance:

1. Extend the protected SQLite command-wrapper coverage to subprocess/host interruption. Current tests reopen the actual state wrapper for initial acceptance, carried timestamps and rejected later-feed rollback, and verify permissions, hashes and lock cleanup; they use synthetic RPC transport rather than cryptographic proof.
2. Connect the independently signed contract vectors to the TypeScript transport path. The external-checkout [official-contract harness](../tests/evm/README.md) now passes six cryptographic tests locally, including an offline run; fixture RPC acceptance remains separate evidence.
3. Complete full hosted tests and deployment checks for the exact final commit, then review before merging. Keep production activation separate.

Actual approved SBX numeric IDs, symbols, exponents, channels, quote currency and publisher thresholds must still be supplied. Both readback modes use the same feed-policy implementation; there is no separate signed-mode policy layer.

Publisher admission, source rights, independent operators, assigned feeds and genuine qualification history remain launch prerequisites. A consumer trial key does not satisfy them.

## Primary references

- [Pyth payload reference](https://docs.pyth.network/price-feeds/pro/payload-reference)
- [Reviewed Solidity parser](https://github.com/pyth-network/pyth-crosschain/blob/8dd8deee8d115b3ad4cea6ddc615118ba670ee36/lazer/contracts/evm/src/PythLazerLib.sol)
- [Pyth deployed contracts](https://docs.pyth.network/price-feeds/pro/contract-addresses)
- [Canonical block-hash RPC parameter](https://eips.ethereum.org/EIPS/eip-1898)
