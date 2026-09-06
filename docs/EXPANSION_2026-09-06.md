# Provider and recovery expansion — 6 September 2026

This update expands development collection and operational verification. It does not launch a public benchmark or Pyth feed.

## Changes

- Ten registered collectors, including new Verda, Hyperstack and Shadeform adapters. Only Oracle, Azure and Verda are enabled by default.
- Verda public catalog collection for B200, B300 and GB300, with on-demand and Spot observations kept separate and no inferred inventory.
- Authenticated Hyperstack and Shadeform adapters with explicit billing, hardware and provenance gates. They remain disabled and unverified against live accounts.
- AWS GB300 discovery archives complete response pages but emits no normalized GB300 price until the hardware denominator is verified.
- Persistent 429/503 scheduling shared by self-hosted and managed collection, including restart, clock and concurrent-response safeguards.
- Encrypted self-hosted journal backup, inspection and isolated restore. Restore creates a new disabled identity and verifies all retained snapshot inputs and calculations.
- Updated provider access, rights, recovery, cost and launch requirements. No source publication flags or benchmark weights were enabled.

## Real-data local acceptance

Both isolated workerd nodes collected 64 observations: Oracle 4, Azure 38 and Verda 22. Each archived six source responses, covered all four model families and reported no errors. Restart preserved their distinct identities and stored state. Both belong to one operator group. All 45 public feed slots remained null, public reports empty and readiness 503.

A separate self-hosted backup drill used an existing 172,032-byte SQLite journal containing 42 real observations, five source responses and one snapshot. Backup, authenticated inspection and restore succeeded. The restored snapshot reproduced exactly with hash `b47b0106755d35805730d26174fe74853be79f9bdd2d70f8f40d0bda8bb4008a`. The restored identity differed; collection, peers and Pyth were disabled; the review marker blocked both serving and collection. Original data remained intact and recovery files were private and excluded from Git.

This drill used local storage. It is not offsite recovery or a Cloudflare object restore, and one snapshot is not a historical price qualification study.

## Release verification

Complete local verification passed 179 tests with 1,402 assertions, including the actual official Rust Pyth agent test, with no failures or skips. Type checking, frozen dependency installation, the Worker deployment dry run, shell syntax and local Markdown link checks passed. Local Docker execution was unavailable because its daemon was not running; the workflow must execute the built image before hosted acceptance is complete.

The repository workflow runs frozen dependencies, type checking, the complete test suite, production image build and container lifecycle/recovery checks. Its separate Pyth job runs the pinned official Rust agent against a local test receiver. No test receiver or fixture supplies production prices.

Match the workflow's commit with the live node's `hosting.release` and run `bun scripts/verify-deployment.ts --release <commit>` after deployment. The checker verifies site bytes, both nodes, current real collection, unavailable public feeds, redirects and denied private routes. A passing local suite alone does not establish hosted deployment acceptance.

## Unresolved requirements

The [launch checklist](LAUNCH_TODO.md) remains open: provider accounts and source rights, AWS GB300 metadata, independent operators, approved methodology and weights, Pyth publisher/feed admission, production signer and readback, hosted backup/export, offsite key custody and sustained real operating history. Do not present the new adapters as full-provider coverage or the development sites as a published oracle.
