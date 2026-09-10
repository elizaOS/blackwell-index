# Local research collection and monitoring

This guide describes private tariff research and its local macOS supervision. The repository contains the collection and health commands; checking out, testing or merging this code does **not** install a LaunchAgent, create a Codex automation or enable collection. The September 8 activation below is one operator's local record, not a service shipped with the repository.

## Recorded local activation — September 8, 2026

- Code checkpoint: `095039515621dc226a2a9ee32abf3f64a9ebb2f9`, branch `codex/b200-pyth-local-integration-20260908`, in an isolated integration checkout.
- Data/config: the operator's existing research directory, separate from that checkout; historical captures and the earlier gap remain intact.
- LaunchAgent: `org.elizaos.blackwell-research`, installed separately in the operator's `~/Library/LaunchAgents` directory.
- Schedule: one `research-collect` invocation every 300 seconds, plus an invocation on agent load. launchd owns this job; do not start a duplicate collector against the same journal.
- Sources: existing Oracle, Azure and Verda public collectors. Runpod is not enabled, no source rights/weights are changed, and no API credentials are installed.
- Each invocation starts with an empty environment except basic local process paths, disables dotenv loading, and uses background CPU/I/O priority. Counts-only stdout and fixed diagnostics go to private files under `data/research-logs`.
- Codex follow-up: `monitor-blackwell-research-collection`, every 30 minutes in this task, alerts only on new collection/service failures, recovery or low disk space. It performs local reads and does not restart services or contact partners.

The Mac must be awake and the user session available for collection. Codex must be running for its local follow-up checks. Sleeping, shutdown or unavailable project paths can create gaps; no sleep-prevention setting is changed. A service being loaded or two successful cycles is not evidence of 30 days of operation. [Local scheduled-task requirements](https://learn.chatgpt.com/docs/automations?surface=app).

## Collection-only boundary

`research-collect` shares the existing collection/capture path with the normal node. It loads no node identity, credential file or Pyth manifest, signs no report, synchronizes no peers, starts no web listener, and creates no benchmark snapshot. It accepts only the three existing public source adapters, a DRAFT methodology, no peers or publishing manifest, and no derivation/redistribution flags. Requests are GET-only, confined to admitted HTTPS hosts, capped at 64 requests with a 120-second shared deadline, and retain existing HTTP backoff controls and per-response byte limits.

Collection permissions and expiry are still enforced. Registry metadata remains an operator assertion; this command does not grant rights. Recovery review markers prevent research writes. Recovered chunked journals are explicitly rejected before collection rather than interpreting the final physical chunk as a complete cycle.

`research-health` uses a read-only database connection and checks the latest ordinary capture. It reports missing/old/future data, configured source coverage and errors, with no raw prices, response bodies, credential values or provider error strings. HEALTHY_RESEARCH describes source retrieval liveness only. For the current five-minute schedule its stale threshold is 12 minutes; the monitor checks every 30 minutes, so it is a research alert cadence, not a market SLA. Integrity, comparability, economic independence and sustained history require their separate audits.

## Inspect and stop an existing local installation

These commands are for an operator who has already configured the research directory and installed the named macOS LaunchAgent. They do not initialize data or install supervision. Run the variable setup from the code checkout, replace the data-directory placeholder with the existing research directory, and adjust the job label if the installed service uses a different one. The code checkout and research directory may be different directories.

```sh
SBX_CODE_DIR="$(git rev-parse --show-toplevel)"
SBX_DATA_DIR="/absolute/path/to/existing-research-data"
SBX_BUN="$(command -v bun)"
SBX_JOB_LABEL="org.elizaos.blackwell-research"
SBX_LAUNCHD_DOMAIN="gui/$(id -u)"
SBX_LAUNCHAGENT="$HOME/Library/LaunchAgents/$SBX_JOB_LABEL.plist"
```

Read health without requests or writes:

```sh
env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" \
  "$SBX_BUN" --no-env-file "$SBX_CODE_DIR/src/cli.ts" research-health --dir "$SBX_DATA_DIR"
launchctl print "$SBX_LAUNCHD_DOMAIN/$SBX_JOB_LABEL"
```

An idle LaunchAgent with last exit code 0 is normal between five-minute invocations. A running process alone is not proof of fresh captures. A nonzero health exit means degraded collection or a configuration/journal that requires review.

Stop collection without deleting evidence:

```sh
launchctl bootout "$SBX_LAUNCHD_DOMAIN" "$SBX_LAUNCHAGENT"
```

Also pause the named Codex follow-up when intentionally stopping. The plist remains on disk after bootout; remove or disable this specific job if it must not load on a later login. Do not delete the database, source worktree or integration worktree as a way to stop the service. Reloading the saved plist is an explicit local operator action.

## Verification and remaining decisions

At activation checkpoint `0950395`, the full local suite passed 729 tests, including the official Pyth-agent protocol check. New tests cover capture without reports/snapshots, refusal of publisher/peer/authenticated-source configurations, HTTP backoff, stale/missing/future/error/corrupt captures, chunked-journal refusal, poisoned credential files and recovery review. TypeScript passed. The first real resumed collection returned 64 observations and zero errors, followed by a successful launchd-owned cycle. Those live collections used actual provider responses. This dated result does not establish the health of another installation or a later revision; inspect its current health and verification receipts.

See the private `artifacts/collection-20260908` receipts for exact code and observation times, source/config hashes, supervised health and replay results. These receipts do not waive the separate Solidity/hosted/live-feed acceptance work.

The [source packet](SOURCE_QUALIFICATION_PACKET.md), [proposed methodology decisions](B200_METHODOLOGY_DECISIONS.md) and [unsent outreach drafts](OUTREACH_DRAFTS.md) are ready for the benchmark owner, source-rights reviewer, Pyth and a prospective operator. No recipient or legal operator has been invented. Written rights, methodology approval, Pyth acceptance and a market agreement remain external decisions; local collection continues while they are resolved.
