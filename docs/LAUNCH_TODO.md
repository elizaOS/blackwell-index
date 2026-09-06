# Launch requirements and accounts

This checklist is the completion contract for the public oracle. Software tests, a running website and registered domains do not satisfy external publisher or data requirements.

| Requirement | Current evidence | Next action |
| --- | --- | --- |
| Four domains | Purchased for $78.06; DNS, HTTPS, both sites and canonical redirects verified | Assign renewal owner; automatic renewal is off |
| Public open source repository | Public elizaOS/blackwell-index; Linux, container and Pyth protocol checks passed for the deployed follow-up release | Continue exact-revision verification on every change |
| Real source collection | Public Oracle all-four, Azure GB200 and Verda B200/B300/GB300 retrievals verified | Continue scheduled collection; inspect coverage, source errors and sustained availability |
| AWS credentials | Not supplied | Read-only `pricing:GetProducts` principal and keys; optional session token. Also obtain `ec2:DescribeInstanceTypes` access to verify GB300 hardware before enabling normalization |
| Google credentials and SKU map | Not supplied | Enable Cloud Billing Catalog API; API key/project; capture complete Blackwell component SKUs and reviewed instance mapping |
| Lambda account | Not supplied | Organization account, read-only cloud API key, source publication rights |
| Runpod account | Not supplied | Organization API key and written automated collection/derived-publication terms |
| Vast account | Not supplied | Read-only marketplace key, approved retrieval/publication terms, host/provenance criteria |
| Hyperstack account | Collector implemented; no live key supplied | Read-only pricebook/flavor/stock key, live joins and billing reconciliation, source rights |
| Shadeform account | Collector implemented; currency and live access unverified | Key, written USD billing confirmation, permission for automated compilation and publication, underlying-provider ownership mapping |
| Prime Intellect account | Collector registered but disabled; no key or live verification | Availability → Read key, written retrieval/retention/derivation/redistribution permission, complete B200/B300 bundle reconciliation and upstream ownership mapping; GB200/GB300 hardware and procurement review |
| Remaining providers | Coverage/discovery matrix recorded | Provider price APIs or documented contributor feeds for each supported hardware family |
| Source rights | Production derive/redistribution flags unset | Evidence covering automated retrieval, raw retention, public per-provider data, derived benchmark and onchain financial-reference use; identify which operator is covered |
| Provider weights | Unset | Select eligible comparable sources, verify economic groups, approve fixed constituent sets per model and effective date |
| Independent node operators | Two deployed persistent identities, both controlled by elizaos-cloudflare | At least three independent organizations; four are needed to retain a greater-than-two-thirds quorum with one unavailable; verify source access and ownership |
| Pyth accepted publisher | Not supplied | Obtain acceptance as benchmark administrator or onboard first-party providers; confirm current Pro ingress |
| Pyth feed IDs | No matching SBX/Blackwell symbol in queried public catalog | Assigned per-provider/model/composite IDs, metadata, minimum publishers and permitted key bindings |
| Pyth signer | Integration tested against official agent locally | Separate protected production key, relayer access, funded infrastructure if required by agreed terms |
| Pyth consumer access | Not supplied | Hermes/Pro API account and appropriate public redistribution terms |
| Onchain verification | Not performed | Select supported target chain, official upgraded contract, RPC and gas wallet; submit and inspect actual signed update |
| Production operations | Live hosted exports encrypted and restored with 89 snapshots reproduced per node; see [acceptance record](HOSTED_ACCEPTANCE_2026-09-06.md) | Continue exact-revision checks; prioritize streaming archives because the measured export is already 6.6 MiB against an 8 MiB cap; assign offsite destination, separate key custodian, paging and retention owners; run a host-loss/rotation exercise |
| Historical validation | Retained-data study implemented; 30-day qualification `NOT_ESTABLISHED` | Accumulate and review genuine consecutive coverage; obtain licensed historical records; no synthetic backfill or future membership look-ahead |
| External audit and benchmark review | Internal independent code review and tests | Security assessment, methodology validation, legal/data-rights review and signed release decision |

Do not paste API keys or private keys into issues or chat. Use `credentials`, environment variables, organization secret storage and deployment secret commands. Pyth admission details and provider agreements should be referenced by protected evidence records; private contracts do not belong in the public repository.

## Immediate operator handoff

1. Name the legal benchmark operator, Pyth contact and authorized source-rights reviewer. Provide protected references to existing agreements, if any.
2. Identify the organization secret manager or sign in to the relevant provider dashboards. The current Worker has no provider secrets configured. Start with AWS, Google and the providers where an account already exists; a new paid subscription is not automatically required or authorized.
3. Confirm who will run independently administered nodes. Two nodes under this account are one operator, not two votes.
4. Choose the offsite backup destination, separate key custodian and paging owner. [Hosted recovery tooling](HOSTED_RECOVERY.md) now supports private signed exports, local encrypted backups and restoration into a new disabled self-hosted identity. Deployed-revision verification, larger-journal archival and a real host-loss exercise remain acceptance work.

Use the [operating study](OPERATING_STUDY.md) to inspect retained private observations and dated gaps. It does not establish 30 consecutive days of qualified operation or authorize publication.

Continue research collection while these are unresolved. Do not enable public prices, Pyth submission or a financial-reference claim merely to make the dashboard look complete.

## Pyth onboarding packet to prepare

Supply the legal operator, contact, data provenance, provider permissions, requested symbols, units, exponent, refresh schedule, source-time semantics, constituent methodology, quorum model, expected coverage, failure behavior, test evidence and public publisher key. Request a written decision on benchmark-administrator admission, approved feeds, minimum independent publishers, test/production ingress and fees. Ask how the upgraded Core/Pro API exposes source age and how to obtain independent publisher-attribution evidence.

These are drafted requirements, not a sent application or a claim of acceptance. Contacting external parties requires the user's communication authorization.
