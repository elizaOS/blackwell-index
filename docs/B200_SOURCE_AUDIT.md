# Local B200 source evidence and comparability audit

```sh
bun --no-env-file src/cli.ts audit-sources --output data/studies/b200-sources.json
bun --no-env-file src/cli.ts audit-sources --at EPOCH_MS --from EPOCH_MS --output data/studies/b200-sources-window.json
```

This command opens the existing local SQLite journal read-only. It reuses the bounded operating study, verifies the SHA-256 of retained B200 response bytes, and replays those bytes through the current Oracle, Verda, Runpod and Lambda collectors. The collectors' injected transport serves only the selected archived response. Every other request returns a local 404; no network transport, real credential, provider account or publishing process is used. Captured response bodies are never written back.

The command compares a canonical hash of every reproduced observation, including its provenance URL, source-record ID, hardware mapping, commercial terms and price. The operating study now retains this observation fingerprint without exposing the original URL. Changing a captured price or provenance field while retaining a valid response hash fails reproduction. A hash-correct body that cannot produce the observation also fails.

Response bytes are deduplicated by hash in the journal. The audit permits the same bytes to reproduce later observations while preserving their original observation times. This proves byte integrity and parser reproducibility; it does **not** independently prove every later HTTP retrieval, authenticate the provider, verify TLS, or establish economic rights. The stored evidence timestamp is the first retention time, not necessarily the latest successful retrieval.

Runpod replay supplies a fixed offline placeholder solely to pass the collector's key-presence check. It accepts only the exact credential-free `https://api.runpod.io/graphql` evidence URL, removes only that placeholder from the injected request, and serves archived bytes. No credential file or environment key is read. The journal does not retain the original GraphQL request body, so reproduction does not prove the original query or account entitlements. Null inventory remains unknown; explicitly unavailable inventory is flagged. See [Runpod qualification](RUNPOD_QUALIFICATION.md).

Lambda replay supplies a fixed offline Bearer placeholder and accepts only `GET https://cloud.lambda.ai/api/v1/instance-types`, without a request body or query string. Its injected transport verifies the method and placeholder header and returns archived bytes in memory; it never reads a real key or contacts Lambda. Regional availability, unavailable catalog rows and full-instance normalization are reproduced through the existing collector. Original account entitlements, public-price applicability, physical exclusivity, HGX topology and the complete commercial bundle remain independently unverified. Lambda-specific limitations appear only when Lambda evidence is present. See the [qualification packet](SOURCE_QUALIFICATION_PACKET.md) and [official API browser](https://docs-api.lambda.ai/).

## What the report establishes

`LOCAL_REPLAY_PASSED` means all selected valid B200 observations were reproduced, the referenced response hashes matched, metadata passed the current registry checks, and no detected study anomaly or input limit prevented verification. It does not assert that the provider panel is complete, commercially comparable, independently owned, legally approved or ready for Pyth. Capture errors and cadence are reported separately.

`LOCAL_REPLAY_FAILED`, `INCOMPLETE` and `NO_B200_DATA` remain distinct. Unsupported collectors, missing evidence, changed bodies, inadmissible source metadata, late evidence and unreproduced observations are explicit. Source errors are summarized by fixed codes; raw response bodies, URLs, credentials and collector error messages are not printed.

The report inventories B200 offers across procurement types, but its public-list research cohort excludes spot, account-specific and fractional offers. It preserves instance sizes, storage/bundle components, topology, region and minimum-order fields. It flags differences and unknowns; it never invents a cost adjustment or silently declares unlike offers equivalent.

Economic groups and source-rights flags are read from the supplied registry. They remain operator assertions. `independentlyVerifiedEconomicGroups` is null, and derivatives-rights review remains `NOT_ESTABLISHED`. Private rights evidence should be reviewed by its authorized owner rather than copied into this report.

Stdout contains counts/status only. The complete report goes only to a new mode-0600 file under `--output`; overwrites are refused. Keep reports private. Use the same cutoff, registry, methodology and code revision to reproduce a result. This command supports the ordinary local SQLite journal; it does not directly consume hosted recovery frames.

## Scope and cost

The existing study bounds captures, observations, series and input bytes. The audit additionally reads at most 256 evidence headers/bodies, no body above 10 MiB, and no more than 32 MiB total response bytes. Excess referenced digests receive limit diagnostics. Hash verification reads each selected body once; collector replay runs once per unique body; observation fingerprints are checked against its B200 outputs. All SQL reads are materialized within one read transaction before asynchronous replay. No dependencies or background services are added.

Tests use isolated fixtures to exercise tampered values and provenance, corrupted/missing evidence, unsupported collectors, source-origin checks, knowledge cutoffs, byte/count limits, economic aliases, stable-body reuse and private read-only CLI behavior. The [Pyth local acceptance checklist](PYTH_LOCAL_ACCEPTANCE.md) separates this evidence from external market acceptance.

Lambda fixtures cover zero, one and multiple available regions and reject forged topology, bundle, GPU count, region, source-record ID and price. These are synthetic parser tests, not genuine retained Lambda samples or authenticated API conformance. An inactive [resource mode](INSTANCE_RESOURCES.md) also reproduces exact full-instance vCPU/RAM/storage quantities, including legacy/enriched records sharing one retained response hash. The collector does not emit verified topology; a missing value remains `TOPOLOGY_UNKNOWN` and cannot satisfy a required HGX offer.

For the proposed eight-GPU HGX qualification, prioritize Lambda, with Hyperstack as the fallback; Runpod first needs an actual eight-GPU full-instance offer. Lambda's public announcement supports investigating that configuration, while Hyperstack's catalog identifies an eight-GPU B200 flavor whose HGX mapping still needs evidence. This priority neither admits a third economic group nor changes any source permission, weight or collector setting. Hyperstack is not yet a supported replay source. [Lambda announcement](https://lambda.ai/blog/nvidia-b200-lambda-on-demand-cloud), [Hyperstack flavors](https://docs.hyperstack.cloud/docs/hardware/flavors/), [source qualification packet](SOURCE_QUALIFICATION_PACKET.md).
