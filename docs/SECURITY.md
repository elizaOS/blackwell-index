# Security model

## Trust boundaries

An operator signs observations with a randomly generated Ed25519 key. The key proves who submitted a report. It does not prove the truth of a provider quote, independent beneficial ownership, collection rights or source timestamp. Raw-response hashes let reviewers detect evidence changes, but a malicious operator could hash invented bytes.

The registry identifies admitted operator groups, authoritative source origins, source IDs, provider economic groups and permissions. Each verifier pins a local registry and methodology; snapshot hashes expose differences. This is governed benchmark admission over an open reporting network. Pyth uses a separately permissioned publisher and router system. Neither extra HTTP nodes nor a public Git repository creates independent publishers.

## Defenses

| Failure or attack | Implemented control | Residual risk / external requirement |
| --- | --- | --- |
| Fake nodes and multiple keys | Candidate quarantine; operator-group deduplication; supermajority quorum | Identity and independence verification; governance must resist capture |
| Forged or modified reports | Canonical JSON, Ed25519, canonical Base64 and key/ID binding | Compromised keys sign valid false observations |
| Replay and conflicting signed reports | Persistent sequences, signed conflict evidence and quarantine | Key rotation and registry updates must propagate operationally |
| Same upstream data through resellers | Economic-group weights and exact source provenance | Correct beneficial-owner mapping requires diligence |
| False provider quotes | Independent matched-SKU collection and deviation limits | A source or sufficient colluding operators can still lie |
| Stale/future prices | Original retrieval timestamps, expiry, bounded skew, oldest contributor time | Clock integrity and providers' own stale pages |
| Broken source or missing model | Explicit unavailable status; no synthetic fallback or weight redistribution | Strict coverage rules reduce availability |
| Manipulated weighting | Versioned explicit weights and hashes | Configuration approvals remain an organizational responsibility |
| API-key disclosure | Local environment/secret storage, credential-free provenance URLs, no key distribution | Account-specific responses may themselves be sensitive; raw archives stay private |
| Arbitrary peer fetch / SSRF | Explicit peer destinations; candidate URLs never automatically fetched; HTTPS and redirects rejected | Administrator-chosen DNS targets and DNS trust |
| API floods and oversized bodies | Body limits, rate limits and bounded candidate/proof storage | Internet-facing nodes still need upstream DDoS protection and disk monitoring |
| Corrupted history | Chained snapshot hashes and retained raw response digests | Full replacement/truncation needs externally anchored checkpoints and backups to detect |
| Pyth spoofing or unit mismatch | Explicit accepted feed bindings; metadata and source-time checks; local signing-agent isolation | Publisher acceptance and signed onchain verification remain external |

Keep collector, Pyth publisher, deployment and governance credentials separate. Revoke compromised identities, retain signed evidence and publish an incident notice before restoring affected feeds. Do not continue emitting an old value with a new source timestamp during an outage.

## Governance and independence

For production, identify at least three independent operating organizations, verify their source access, establish configuration-change authorization and publish ownership/conflict disclosures. Running primary and secondary nodes in one Cloudflare account is availability testing under one operator. It is not evidence of decentralization across organizations or cloud providers.

The current network synchronizes reports and computes independently. It does not implement Byzantine consensus over a single global sequence; nodes can temporarily have different inputs. Consumers must check methodology/registry hashes and exact input hashes. The Pyth feed specification must define how accepted benchmark publishers align calculation windows and handle disagreement before publication.

Provider-origin signatures or independently verified TLS transcript proofs could strengthen observation provenance. They are future research until provider support, attestation trust and reproducible verification are demonstrated. They do not automatically solve price comparability or data licensing.

## Reporting

Use GitHub private vulnerability reporting when enabled for this repository. Do not post credentials, private provider payloads or exploit details in a public issue. See the [independent implementation review](SECURITY_REVIEW.md) and [launch checklist](LAUNCH_TODO.md) for current verification and remaining work.
