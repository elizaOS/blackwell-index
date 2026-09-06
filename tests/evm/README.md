# Official verifier conformance

This independently authored test runs the original Pyth verifier with genuinely
signed, isolated fixtures in Forge's local EVM. It checks exact returned bytes and
signer, signature/payload tampering, unknown/expired signers, and insufficient fee.
It does not publish SBX, contact an RPC, send transactions, or use real credentials.

## External prerequisites

Supply a separately obtained Pyth checkout and Solidity 0.8.23. No upstream code is
vendored or downloaded by this harness. Required pins:

| Component | Commit |
| --- | --- |
| pyth-network/pyth-crosschain | `8dd8deee8d115b3ad4cea6ddc615118ba670ee36` |
| lib/forge-std | `1eea5bae12ae557d589f9f0f0edae2faa47cb262` |
| lib/openzeppelin-contracts | `69c8def5f222ff96f2b5beff05dfba996368aa79` |
| lib/openzeppelin-contracts-upgradeable | `fa525310e45f91eb20a6d3baa2644be8e0adba31` |

The library paths are relative to `lazer/contracts/evm` in the external checkout.
Check `git rev-parse HEAD` and `git status --porcelain` in the checkout and each
listed submodule. Require the exact hashes above and no modifications. Do not use
an arbitrary installed package version as equivalent evidence. Forge 1.7.1 is
available on the development host; compiler and dependencies must already exist
for an offline run.

The upstream contract declares `SPDX-License-Identifier: UNLICENSED`, while the
upstream root license declares Apache-2.0. This discrepancy is unresolved. The
MIT header on our test does not license its imports. Obtain clarification before
redistributing upstream code or enabling automated dependency distribution.

## Run

Use the checked runner after obtaining the external prerequisites:

```sh
bun run pyth:contract-test --checkout /absolute/path/to/pyth-crosschain --forge /absolute/path/to/forge
```

It checks the upstream and dependency commits and cleanliness before and after
execution, uses an isolated Forge configuration with FFI disabled, and requires
all six named tests to pass. Missing dependencies or compiler are failures, not
skips. It does not download prerequisites. Temporary build artifacts are retained
under the operating system's temporary directory, not the source repository.

For manual inspection, the equivalent low-level command is below.

From the SBX repository root, set `SBX_PYTH_CHECKOUT` to the absolute path of the
verified external checkout. The command deliberately disables downloads. Build
artifacts go to a new temporary directory, outside the public repository.

```sh
export SBX_PYTH_CHECKOUT=/absolute/path/to/verified/pyth-crosschain
SBX_EVM_BUILD=$(mktemp -d)
SBX_PYTH_EVM="$SBX_PYTH_CHECKOUT/lazer/contracts/evm"
FOUNDRY_TEST=tests/evm forge test --root "$PWD" --contracts tests/evm \
  --offline --use 0.8.23 --evm-version paris --optimize true --optimizer-runs 100000 \
  --out "$SBX_EVM_BUILD/out" --cache-path "$SBX_EVM_BUILD/cache" \
  --remappings "pyth-external/=$SBX_PYTH_EVM/src/" \
  --remappings "forge-std/=$SBX_PYTH_EVM/lib/forge-std/src/" \
  --remappings "@openzeppelin/contracts/=$SBX_PYTH_EVM/lib/openzeppelin-contracts/contracts/" \
  --remappings "@openzeppelin/contracts-upgradeable/=$SBX_PYTH_EVM/lib/openzeppelin-contracts-upgradeable/contracts/" \
  --match-contract PythVerifierConformance -vv
```

Record all dependency hashes, Forge/compiler versions, and the full test result.
Expected coverage is six tests, not merely a successful compilation.

## Acceptance boundary

Executed September 6, 2026 with the exact pins above, Forge 1.7.1 and Solidity
0.8.23: six passed, zero failed, zero skipped. A subsequent offline compilation
and execution also passed all six tests without compiler warnings. Upstream
sources and build artifacts remained outside this repository. This contract test is separate from the
TypeScript ABI, transport, policy, and SQLite restart tests; it does not establish
their end-to-end integration or attest the implementation deployed on Base.
