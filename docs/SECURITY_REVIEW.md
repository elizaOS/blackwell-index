# Security review

Internal implementation review, September 6, 2026. This is not an independent security audit or a certification for financial settlement.

## Issues corrected

| Issue | Impact | Correction and regression coverage |
| --- | --- | --- |
| Static files could resolve outside the public directory | A double-leading-slash path could read an absolute file with an allowed extension. | Reject absolute routes and enforce real-path containment, including symlinks. |
| Noncanonical signature encoding could manufacture equivocation | Changing unsigned Base64 padding bits preserved the Ed25519 signature bytes but changed the report hash. | Require canonical Base64 and compare signed payloads, not signature representations. |
| Equivocation detection depended on arrival order | A later sequence could hide a conflicting earlier sequence. | Track every submitted node/sequence pair independently of latest-report selection; persist exclusion across restarts. |
| Candidate submissions shared the trusted history journal | One unapproved key could append indefinitely and consume the capacity needed for approved reports. | Keep candidates in a separate, latest-only table with identity, per-report and total-byte limits. Candidates never enter calculation or historical trusted replay. |
| Equivocation knowledge stayed on one node | A peer without the conflicting pair could continue using that operator's later reports. | Exchange and validate signed conflict pairs in both directions before ordinary report synchronization. Quarantine survives restart. |
| Peer push bypassed current source permissions | A previously collected report could be sent after redistribution approval expired or was revoked. | Recheck permission and freshness immediately before push. The same redistribution check applies to public conflict evidence. |
| Historical replay could use revised configuration | Current membership or weights could change the interpretation of old reports. | Store immutable, hash-addressed configuration; exact reproduction uses the snapshot's configuration and signed input hashes. |
| Restart could ignore provider throttling | A provider's requested wait could be lost between cycles or deployments. | Persist per-collector 429/503 deadlines, transactional request leases and clock-rollback checks; late success cannot erase a newer throttle. |
| A valid snapshot chain could contain missing inputs | Hash-chain checks alone could accept an archive that cannot reproduce its prices. | Recovery resolves accepted and rejected report references, checks archived configurations and reproduces every retained calculation exactly. |
| Restore could resume an old signer | Rewound counters could create conflicting signed reports. | Restore never copies the old private key; it creates a new identity, disables sources/peers/Pyth and blocks run/collect pending review. |
| SQL routing or proof records could disagree with signed content | Restored metadata could misattribute a report or discard evidence of an excluded signer. | Verify report node/sequence routing, retained counter highwater, conflict signatures and quarantine linkage; missing full proofs require review. |

## Admission and resource limits

Opening the collector software does not grant benchmark influence. A registered operator key and an approved independent operator group are required for voting. Multiple keys in one group still supply one vote. Quorum is the larger of the configured minimum and more than two thirds of enabled operator groups. This is a quorum calculation over signed reports, not a formally verified consensus protocol.

Unapproved candidates retain one latest report per key: at most 512 identities, 256 KiB per report and 16 MiB of total retained payload. Updates replace the previous candidate row. Exhausting those quotas rejects additional candidate storage, while approved reports use a separate journal. Admission checks the candidate's retained sequence, rejects lower nonces and does not backdate earlier candidate data into approved history. An identity-count limit also prevents an empty-report Sybil flood from creating unlimited rows. Candidate admission remains an operator decision; filling the candidate pool can obstruct additional unapproved applicants but cannot create votes.

Approved signed reports are limited to 512 KiB each and 500,000 history rows. These are application bounds, not a substitute for disk quotas and archiving. The signed-proof archive retains at most 1,024 operator proofs and 128 MiB of payload. If proof capacity is exhausted, the offending key remains durably excluded, but the node reports that full-proof archiving needs attention. Operators must monitor these limits before capacity is reached. The report size also keeps a two-report proof row below Cloudflare Durable Object SQLite's row limit.

`GET /v1/equivocations?after=N&limit=N` returns ordered cursor pages with at most 32 proofs and approximately 6 MB of retained signed payload. `POST /v1/equivocations` accepts `{"proofs":[{"first":<signed batch>,"second":<signed batch>}]}`. A valid proof requires two canonical, valid signatures by the same configured identity, on the same network and sequence, over different payloads. Changing an unsigned field, supplying identical payloads, mixing sequences or accusing an unregistered identity is insufficient.

Synchronization validates proofs before reports, has page, time and byte budgets, rejects non-advancing cursors and does not follow redirects. Exceeding a proof-sync budget fails that synchronization attempt; it does not authorize ignoring the remaining evidence. Proofs containing source data that cannot currently be redistributed stay local. Obtain permission to retain and exchange incident evidence as part of source agreements.

## Verification

Run:

```sh
bun test test/security-review.test.ts test/network.test.ts
bun run typecheck
```

Regression coverage includes encoded-signature forgery, report-order independence, path traversal, expired permissions, a repeated single-key candidate flood, total candidate byte exhaustion with signed reports, nonce-preserving admission, forged conflict accusations, bidirectional conflict propagation, bounded proof pagination and configuration integrity. Existing network tests cover restart replay, durable quarantine, multi-node convergence and history-chain tampering. Test fixtures are synthetic only inside tests; they are never production observations.

The separate [Pyth integration](PYTH.md) includes a conformance test against the actual pinned official Rust agent. Local queue acknowledgement is not Pyth publication or settlement proof. Run `bun test test/recovery.test.ts test/collection-control.test.ts` for the recovery and throttling regressions. The [recovery procedure](RECOVERY.md) states the local backup limits and work still required for hosted disaster recovery.

## Required before production use

- Verify provider redistribution, derived-index and incident-evidence rights. A public URL or API credential is not permission to republish its data. Keep confidential contract text and credentials out of the public registry and signed observations.
- Verify operator and provider independence, fixed-weight evidence, source definitions and methodology approval. Signatures establish who submitted a report; they do not prove the underlying quote is truthful or executable.
- Set memory, disk, request-concurrency and edge rate limits. Add retention/archiving alerts for reports, captures, raw evidence and proofs. Test sustained traffic and restoration on the intended host. Application payload limits do not prevent bandwidth, connection or CPU denial of service.
- Use one protected database and collector identity per network. This initial release does not automatically reclassify untrusted rows from earlier prototype databases; archive those and initialize a clean deployment. Back up keys and exact configuration without publishing secrets.
- Define membership changes, key revocation, equivocation response, archive recovery and feed suspension procedures. A quarantined key must not be silently reinstated by restarting a process.
- Keep the Pyth agent bound to loopback inside an isolated service/container network namespace, accessible only to the benchmark publisher. Its local submission socket is a signing capability. The inspected official agent HTTP handler does not add an application authentication or Origin check for this local socket; loopback alone is not isolation from other local processes or browser-originated connections. Do not run a production signing agent on an interactive browsing workstation. Protect its actual deployment configuration and verify the running key and ingress against the externally approved manifest; the manifest alone is not proof of either.
- Complete current Pyth acceptance, actual upstream readback, source-loss drills, independent deployment testing and an external security review before a financial product uses these prices.

No claim here establishes permissionless price-source trust, independent economic discovery from repeated copies of one provider's tariff, a market-clearing GPU price, or a production-ready settlement oracle.
