# Local integration and next actions — September 8, 2026

> **Historical checkpoint:** This report records the integration before supervised research collection was activated later on September 8. Its 723-test result, unavailable shadow value and statement that no collector was started describe that earlier pass. See [local research operations and the later 729-test activation checkpoint](LOCAL_RESEARCH_OPERATIONS.md) for the subsequent work and current-health commands. The historical collection gap remains; resumed collection does not fill it.

The local integration combines upstream `a77baaa078486dcbe4444bc2a1342a51baf1a013` with the retained-source audit at `4f70b9582f9b620a584e13f15ff5aac3f8950103`. The merge commit is `df173cd0bbb6c071e94a4653883f3f466a34eb98`. Work is isolated on `codex/b200-pyth-local-integration-20260908`; the original checkout remains on its existing branch. No push, PR mutation, deployment, outreach, credential installation or production configuration change is part of this pass.

## What changed

- Preserved upstream Pyth authenticated readback, atomic signed-payload validation, recovery and Base consumer checks alongside the offline audit and observation fingerprints.
- Added Runpod to bounded archive-only B200 replay, reusing its existing collector. No duplicated parser, real key or live provider request is needed. Canonical credential-free endpoint checks and inventory/bundle tampering tests are included.
- Reconciled managed HIP-3 perps delivery with the separate Base consumer engineering plan. Native publishing requirements must not be assumed to describe every custom-service route. Current runtime approval and composite gates remain unchanged.
- Updated the unsent partner packet and documented Runpod's remaining source qualification. No synthetic third constituent or guessed wire format was added.

## Verification on the combined local code

TypeScript passes. The complete Bun suite passes **723 tests across 39 files, zero failures**, including the existing real local official Pyth-agent protocol test and new Runpod archive cases. The final run used a clean environment, disabled dotenv loading and an explicitly confirmed loopback-only global-fetch guard in the Bun test runner. This guard does not claim to sandbox every child-process networking API; the audit itself uses only its injected archive transport, and its tests explicitly reject global network fetch. No new dependency installation was needed.

The private receipt and `guarded-full-tests.log` record this run. These local checks do not replace the separate Solidity, container, hosted or live-feed acceptance described below.

## Retained history findings

A read-only SQLite backup of the existing local journal was frozen at September 8, 2026, 20:05:34.136 UTC. Only non-secret research configuration and the database were copied; no identity or credentials were copied. The isolated copy uses DELETE journal mode so a read-only Bun connection can inspect it without requiring WAL sidecars; the original journal is unchanged by this conversion.

| Check | Observed result |
| --- | --- |
| Historical captures | 38, September 6 20:39:51.211–23:37:52.745 UTC |
| B200 replay | 342 of 342 observations reproduced from two hash-verified response bodies |
| Public on-demand B200 series | Five across two configured economic groups, Oracle and Verda |
| Determinism | Two full-window audits were byte-identical; isolated database hash unchanged |
| Original September 6 cutoff | 18 captures and 162 B200 observations still reproduce after integration |
| Cadence through September 8 cutoff | 569 completed five-minute buckets; 36 occupied and 533 empty; one continuous trailing gap |
| Current shadow value | Unavailable: both fixed constituents have expired |
| Thirty-day qualification | NOT_ESTABLISHED |
| Runpod in this retained journal | No observations or response bodies; upstream live report remains separate evidence |

`LOCAL_REPLAY_PASSED` establishes retained-data integrity, not fresh prices or continuous operation. Repeated unchanged bodies are not independent trades. Oracle/Verda bundle and geographic differences persist. None of the current records establishes source permissions, legal ownership independence or a third qualified economic source.

Private raw reports, the frozen database and verification logs live in the ignored `artifacts/review-20260908` directory. Keep them out of commits and remote messages.

## Next actions with completion criteria

1. **Source evidence:** obtain protected retained Runpod request/response evidence and confirm account-independent applicability, full bundle, geography/topology and price-setting ownership. Replay it locally; admit it only after comparability and rights review. The [Runpod checklist](RUNPOD_QUALIFICATION.md) is ready.
2. **Sustained collection:** identify the continuing collection host and owner, inspect its retained coverage and establish supervision before counting future history. This local copy has a known gap; do not fill it with synthetic captures. No background collector was started in this integration pass.
3. **Contract/methodology:** approve the actual B200 bundle/region/minimum-order scope, fixed providers/weights, rights and failure policy. A single-model pilot still requires a reviewed publication-scope change after the route is agreed.
4. **Pyth/operator decision:** use the [unsent packet](PYTH_PARTNER_PACKET.md) to confirm managed custom ingestion versus native publication, authentication, source-time behavior, unavailable values, test environment and actual venue receipts. No local experiment grants service acceptance.
5. **Consumer acceptance where needed:** reuse Base tests for a Base consumer; prove Hyperliquid consumption separately for HIP-3. Transactions, market operation and live financial use remain outside this local completion.

The TypeScript/Bun suite and existing official-agent local test are runnable with current dependencies. The separate six-test Solidity conformance harness needs a pinned external Pyth checkout, Forge and Solidity 0.8.23; these prerequisites were not found in the inspected local project/tool locations, so its earlier upstream result must not be represented as a new local run. Hosted runtime/container/capacity acceptance and live signed BTC or SBX checks are also separate from this local suite.
