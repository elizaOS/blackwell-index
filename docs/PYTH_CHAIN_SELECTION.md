# Pyth chain integration plan

Reviewed September 6, 2026. Scope: Base, Robinhood Chain and Solana. Research and RPC checks were read-only; no accounts, keys, transactions, deployments, gas funding or paid infrastructure were created.

## Decision

Start with **Base Sepolia**, then qualify the same consumer architecture on **Base mainnet**. Use **Pyth Pro signed payloads** to preserve the numeric feed bindings already used by the publisher and readback monitor. This is an engineering sequencing decision, not a claim that Base has the largest GPU trading market.

Build the EVM adapter so Robinhood can reuse it with independently approved network and verifier configuration. Add Solana through a separate SVM adapter. Support for all three is the intended product scope; deployed SBX coverage on any of them remains **not established** until Pyth assigns and approves the feeds and real signed-update tests pass.

Base is first because its test/mainnet environments and Pyth Pro deployments are available, and one Solidity consumer plus transaction-verification path also establishes most of the work needed for Robinhood. Solana requires different program, account, signature-instruction and transaction handling. These are implementation-cost judgments, not measured commercial advantages. [Base networks](https://docs.base.org/base-chain/api-reference/rpc-overview), [Pyth deployments](https://docs.pyth.network/price-feeds/pro/contract-addresses), [SVM integration](https://docs.pyth.network/price-feeds/pro/integrate-as-consumer/svm).

## Current network support

| Network | Network identity | Official Pyth Pro verifier | Assessment |
| --- | --- | --- | --- |
| Base Sepolia | EVM chain `84532` | `0xACeA761c27A909d4D3895128EBe6370FDE2dF481` | First integration target. |
| Base mainnet | EVM chain `8453` | `0xACeA761c27A909d4D3895128EBe6370FDE2dF481` | First production target after acceptance. |
| Robinhood testnet | EVM chain `46630` | `0xACeA761c27A909d4D3895128EBe6370FDE2dF481` | Reuse EVM adapter; validate independently. |
| Robinhood mainnet | EVM chain `4663` | `0xACeA761c27A909d4D3895128EBe6370FDE2dF481` | Currently live, not merely announced/testnet-only. |
| Solana devnet | Genesis `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG` | `pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt` | Application test environment. |
| Solana mainnet | Genesis `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d` | `pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt` | Production SVM target. |

Addresses are from Pyth's current deployment list. EVM identities are from [Base](https://docs.base.org/base-chain/api-reference/ethereum-json-rpc-api/eth_chainId) and [Robinhood](https://docs.robinhood.com/chain/connecting/); Solana genesis identities were read from the selected cluster RPCs below. [Pyth address source](https://docs.pyth.network/price-feeds/pro/contract-addresses).

Robinhood's official site explicitly describes its chain as live and permissionless. Its mainnet RPC is `https://rpc.mainnet.chain.robinhood.com`; testnet is `https://rpc.testnet.chain.robinhood.com`. Mainnet availability does **not** mean SBX is a Robinhood product, appears in Robinhood's retail app, or has approval for securities distribution. Its oracle guide focuses on Chainlink, while Pyth independently lists Pro deployments; neither is evidence that a GPU feed has been admitted. [Robinhood chain overview](https://docs.robinhood.com/chain/), [connection details](https://docs.robinhood.com/chain/connecting/), [oracle guide](https://docs.robinhood.com/chain/oracles-and-price-feeds/).

### Timestamped read-only checks

At **2026-09-06 19:33:30 UTC**, `eth_chainId`, `eth_getCode`, `verification_fee()` and `version()` returned the following. Code and calls used the explicit block in each row, rather than mixing changing latest-state responses:

| RPC | Block | Verifier code bytes | Reported version | Verification fee |
| --- | --- | --- | --- | --- |
| `https://sepolia.base.org` | `0x2c53094` | 176 | `0.1.1` | 1 wei |
| `https://mainnet.base.org` | `0x309b193` | 183 | `0.1.1` | 1 wei |
| `https://rpc.testnet.chain.robinhood.com` | `0x6d05cca` | 183 | `0.2.0` | 1 wei |
| `https://rpc.mainnet.chain.robinhood.com` | `0x35a0271` | 183 | `0.2.0` | 1 wei |

The read-only call selectors were `0xbac12f87` for `verification_fee()` and `0x54fd4d50` for `version()`. Endpoint provenance: [Base RPC reference](https://docs.base.org/base-chain/api-reference/rpc-overview), [Robinhood RPC reference](https://docs.robinhood.com/chain/connecting/). These observations are point-in-time evidence of deployed code and callable methods—not an audit, implementation-bytecode attestation or successful signed-payload verification. A shared address does not imply an identical implementation. The current source tree reports version 0.2.0, so do not assume that its deployed version matches Base. [Verifier source](https://github.com/pyth-network/pyth-crosschain/blob/main/lazer/contracts/evm/src/PythLazer.sol).

At approximately **19:30 UTC**, Solana `getAccountInfo` returned the documented program as executable and owned by `BPFLoaderUpgradeab1e11111111111111111111111` on mainnet and devnet; `getGenesisHash` returned the identities above. At **19:32:22 UTC**, storage account `3rdJbqfnagQ4yx9HXJViD4zc4xpiSqmFsKpPuSCQVyQL` was owned by that Pyth program on both clusters, with the expected Anchor discriminator, 381-byte layout and a fee of **1 lamport**. Mainnet slot was `444872920`; devnet slot was `494215580`. RPCs used were `https://api.mainnet-beta.solana.com` for the initial mainnet check, the currently documented `https://api.mainnet.solana.com` for storage, and `https://api.devnet.solana.com` for devnet. [Cluster reference](https://solana.com/docs/references/clusters), [storage layout](https://docs.rs/pyth-lazer-solana-contract/0.8.0/src/pyth_lazer_solana_contract/lib.rs.html).

The treasury in devnet storage differs from the mainnet treasury shown in the Pyth prose example. Read and validate treasury/fee/trusted signers from the chosen cluster's program-owned storage; do not copy a mainnet treasury into devnet configuration. Program executability alone does not verify its deployed source or upgrade authority. [SVM accounts and verification](https://docs.pyth.network/price-feeds/pro/integrate-as-consumer/svm).

## Consumer architecture

Pyth Pro is the narrowest continuation of this repository: authenticated retrieval of `evm` or `solana` signed binary payloads for assigned numeric Pro IDs, verification by the official chain contract/program, then application checks on the **verified binary fields**. Parsed JSON beside a signature is not itself proof that those fields were signed. The existing offchain monitor requests `formats: []`; its successful result cannot be reused as chain-verification evidence. [Subscription formats](https://docs.pyth.network/price-feeds/pro/subscribe-to-prices), [EVM verification](https://docs.pyth.network/price-feeds/pro/integrate-as-consumer/evm).

For the first Base consumer, verify payload signatures through the approved `PythLazer` deployment, parse with a pinned `PythLazerLib`, and enforce assigned feed IDs, exponent, positive price, confidence, publisher minimum, per-feed generation freshness, expected channel and monotonic accepted timestamps. Reject duplicate/missing required fields, carried stale values and same-time conflicting values. Retain the original timestamp; writing an old value in a new block does not make it fresh. Store a bounded last-accepted value and emit a receipt event if downstream integrations need readback. That would be **our consumer's stored state**, not a claim that the Pro verifier maintains a shared price registry.

For Solana, use the official program and a pinned `pyth-lazer-solana-contract` integration. The documented Ed25519 route requires an explicit Ed25519 verification instruction followed by the consumer/program verification path; validate instruction offsets and the program-owned storage/treasury accounts. The official crate currently lists **0.8.0**, and the TypeScript transport package `@pythnetwork/pyth-lazer-sdk` lists **7.0.0**. Package versions are research observations, not deployment attestations; review and pin exact releases before integrating. [SVM guide](https://docs.pyth.network/price-feeds/pro/integrate-as-consumer/svm), [official crate](https://docs.rs/pyth-lazer-solana-contract/0.8.0/pyth_lazer_solana_contract/), [official transport package](https://www.npmjs.com/package/@pythnetwork/pyth-lazer-sdk).

Pyth Core is a different option for shared prices read by lending markets, vaults and third-party liquidators. It uses different feed IDs and contracts. Request a confirmed Core mapping and support commitment if that is the product requirement; a numeric Pro listing does not imply a Core feed exists. A custom Pro storage adapter adds our own keeper, administration and contract risk and is not automatically accepted by lenders. Do not label it a Core oracle. [Core versus Pro](https://docs.pyth.network/price-feeds/core/upgrade/contracts).

## Implementation stages

1. **Offline consumer tests:** pin the exact verifier interface and parsing library; use isolated fixtures for missing fields, wrong units, bad signatures, stale/future/carried prices, replay/conflicts and wrong chain/address. No fabricated values enter production configuration.
2. **Read-only Base Sepolia preflight:** check chain ID, approved verifier address, implementation/version, fee and required methods. With an entitled token and actual assigned SBX feeds, retrieve signed payloads and verify them via `eth_call`. This is a simulation, not a transaction receipt or production proof.
3. **Base Sepolia transaction acceptance:** after an operator supplies a dedicated signer and test ETH, deploy the minimal consumer, submit real fresh SBX payloads, retain successful receipts and independently read verified fields at the receipt block. Exercise denied feeds, source loss, rate limits, restart, reorg/replacement, signer failure and stale-price rejection.
4. **Base mainnet release:** independently recheck deployment/version and transaction costs; approve a funded signer, transaction/daily spend limits and supervision. Verify receipt finality and consumer state. Do not use a preconfirmation as final settlement evidence.
5. **Robinhood and Solana qualification:** independently repeat network, fee, signer, transaction and readback tests. EVM reuse does not waive Robinhood-specific sequencer/finality checks; Solana needs its own finalized receipt/account and instruction-validation evidence.

## Accounts, capital and operating costs

- **Pyth:** publisher admission, source rights, actual feed IDs, methodology and minimum-publisher agreements; an entitled backend consumer token permitting signed formats and the planned distribution. A consumer subscription cannot obtain these publisher permissions by itself. No listing fee or approval date is assumed.
- **RPC:** public endpoints suffice for bounded research, not a production SLA. Choose owned or contracted RPC access and failover with the required history/rate limits. Solana explicitly warns against using its public RPCs for production. No paid plan was purchased. [Solana RPC limitations](https://solana.com/docs/references/clusters).
- **Signers:** dedicated test and production transaction signers, distinct from the Pyth publisher key and SBX collector identities. Require custody/rotation/revocation procedures, operator ownership and spending limits. Public RPC reads require no funded wallet.
- **EVM costs:** the observed Pyth verification fee is 1 wei per verification call, **not the total transaction cost**. Base adds execution and L1 data costs; query its gas oracle for the serialized transaction's L1 component. Robinhood's standard gas estimate includes its execution and L1 posting components. Estimate actual consumer transactions before funding. [Base fee model](https://docs.base.org/specifications/transactions/network-fees), [Robinhood fee model](https://docs.robinhood.com/chain/gas-and-fees/).
- **Solana costs:** observed Pyth storage fee is 1 lamport per verification, plus transaction fees, priority fees and any account/program funding. The current base fee is 5,000 lamports per charged signature, including relevant precompile signatures. Use simulation and `getFeeForMessage`; do not quote 5,000 lamports as the complete Pyth transaction fee. [Solana fee structure](https://solana.com/docs/core/fees/fee-structure), [Pyth fee implementation](https://docs.rs/pyth-lazer-solana-contract/0.8.0/src/pyth_lazer_solana_contract/lib.rs.html).

Monthly budget should be measured as `accepted update transactions × measured all-in transaction cost + failed/replaced transaction costs + RPC/API service + supervision`. A five-minute schedule has at most 8,640 slots in 30 days; a 30-second schedule has 86,400. These are schedule arithmetic, not expected update volume or a recommendation to resend unchanged inputs. Batch compatible feeds and submit only genuinely advancing source data. Required dollar capital remains unquoted until real feed payloads, cadence, signers, RPC terms and gas estimates are available. None of this requires buying GPUs or funding a market-maker inventory; those are separate business decisions.
