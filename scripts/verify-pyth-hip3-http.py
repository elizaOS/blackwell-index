#!/usr/bin/env python3
"""Offline preparation and loopback-only SBX -> official Pyth resolver acceptance."""
from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path
import runpy
import select
import shutil
import subprocess
import sys
import time

sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parents[1]
PINNED = runpy.run_path(str(ROOT / "scripts/verify-pyth-hip3-resolver.py"))
REVISION = PINNED["REVISION"]
PYTHON_VERSION = PINNED["PYTHON_VERSION"]
BUN_VERSION = "1.4.2"
DEFAULT_DIRECTORY = ROOT / "artifacts/pyth-hip3-http"
DEFAULT_PREPARED = PINNED["DEFAULT_DIRECTORY"]
digest = PINNED["digest"]
write_json = PINNED["write_json"]


def read_control(fd: int, timeout: float = 10) -> dict[str, object]:
    """Bound both a missing handshake and a stalled partial JSON line."""
    deadline = time.monotonic() + timeout
    line = bytearray()
    while len(line) <= 8192:
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([fd], [], [], remaining)[0]:
            raise TimeoutError("Fixture control deadline exceeded")
        chunk = os.read(fd, 1)
        if not chunk:
            raise RuntimeError("Fixture control closed before acknowledgement")
        if chunk == b"\n":
            value = json.loads(line)
            if type(value) is not dict:
                raise RuntimeError("Invalid fixture control envelope")
            return value
        line.extend(chunk)
    raise RuntimeError("Fixture control line exceeds limit")


def inputs() -> dict[str, str]:
    # Include every core source, including optional quantitative-resource policy.
    paths = list((ROOT / "src").rglob("*.ts")) + [ROOT / name for name in (
        "test/helpers.ts", "test/pyth-hip3-http-fixture.ts", "test/pyth-hip3-http-preload.ts",
        "scripts/capacity-offline-preload.ts", "scripts/verify-pyth-hip3-resolver.py",
        "integrations/pyth-hip3/sbx_listener.py", "scripts/verify-pyth-hip3-http.py")]
    return {str(path.relative_to(ROOT)): digest(path) for path in sorted(paths)}


def prepare(directory: Path, prepared: Path) -> None:
    """Copy the already prepared, locked environment; never fetch or install."""
    if directory.exists():
        raise RuntimeError("Choose a new acceptance directory; prepare refuses overwrite")
    PINNED["verify_sources"](prepared)
    interpreter = prepared / ".venv/bin/python"
    runtime = interpreter.resolve().parent.parent
    if not interpreter.is_file() or not (runtime / "bin/python3.13").is_file():
        raise RuntimeError("Prepared managed Python runtime missing")
    directory.mkdir(parents=True, mode=0o700)
    shutil.copytree(prepared / "upstream", directory / "upstream", symlinks=True)
    shutil.copytree(prepared / ".venv", directory / ".venv", symlinks=True)
    shutil.copytree(runtime, directory / "runtime", symlinks=True)
    for name in ("python", "python3", "python3.13"):
        path = directory / ".venv/bin" / name
        if not path.is_symlink():
            raise RuntimeError("Unexpected prepared interpreter entry")
        path.unlink()
        path.symlink_to(directory / "runtime/bin/python3.13")
    cfg = directory / ".venv/pyvenv.cfg"
    cfg.write_text("\n".join(f"home = {directory / 'runtime/bin'}" if line.startswith("home =") else line
                             for line in cfg.read_text().splitlines()) + "\n")
    version = subprocess.check_output([str(directory / ".venv/bin/python"), "-I", "-c",
                                      "import sys; print('.'.join(map(str,sys.version_info[:3])))"],
                                     env={"PATH": "/usr/bin:/bin", "TZ": "UTC"}, text=True).strip()
    if version != PYTHON_VERSION:
        raise RuntimeError("Prepared Python version mismatch")
    PINNED["verify_sources"](directory)
    write_json(directory / "preparation.json", {"status": "COPIED_LOCAL_LOCKED_ENVIRONMENT", "source": str(prepared),
        "officialRevision": REVISION, "pythonVersion": version, "pythonSha256": digest(directory / "runtime/bin/python3.13"),
        "lockSha256": digest(directory / "upstream/uv.lock"), "networkUsed": False, "dependenciesInstalled": False})
    print(f"Copied local pinned runtime and dependencies: {directory}")


def test(directory: Path, bun_argument: str) -> None:
    PINNED["verify_sources"](directory)
    write_json(directory / "acceptance-receipt.json", {"status": "LOCAL_HTTP_ACCEPTANCE_RUNNING", "officialRevision": REVISION})
    fixture: subprocess.Popen[str] | None = None
    try:
        before = inputs()
        write_json(directory / "input-hashes.json", before)
        bun = shutil.which(bun_argument)
        if not bun:
            raise RuntimeError("Qualified Bun executable required")
        env = {"PATH": "/usr/bin:/bin", "TZ": "UTC"}
        with (directory / "fixture.log").open("w") as error:
            fixture = subprocess.Popen([bun, "--no-env-file", "--preload", str(ROOT / "test/pyth-hip3-http-preload.ts"),
                                        str(ROOT / "test/pyth-hip3-http-fixture.ts")], cwd=ROOT, env=env,
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=error, text=True, bufsize=1)
            assert fixture.stdout is not None and fixture.stdin is not None
            metadata = read_control(fixture.stdout.fileno())
            if metadata.get("fixtureOnly") is not True or metadata.get("bunVersion") != BUN_VERSION:
                raise RuntimeError("Synthetic fixture identity or qualified Bun version mismatch")
            write_json(directory / "fixture-metadata.json", metadata)
            command = [str(directory / ".venv/bin/python"), "-I", str(Path(__file__).resolve()), "_worker", "--directory", str(directory),
                       "--control-read-fd", str(fixture.stdout.fileno()), "--control-write-fd", str(fixture.stdin.fileno())]
            with (directory / "http-test.log").open("w") as output:
                subprocess.run(command, cwd=ROOT, env=env, pass_fds=(fixture.stdout.fileno(), fixture.stdin.fileno()),
                               stdout=output, stderr=subprocess.STDOUT, timeout=60, check=True)
            if before != inputs():
                raise RuntimeError("Source files changed during acceptance; rerun after writers finish")
            PINNED["verify_sources"](directory)
            print((directory / "http-test.log").read_text(), end="")
            print(f"Receipt: {directory / 'acceptance-receipt.json'}")
    except BaseException as error:
        failure = {"status": "LOCAL_HTTP_ACCEPTANCE_FAILED", "officialRevision": REVISION, "errorType": type(error).__name__}
        write_json(directory / "acceptance-receipt.json", failure)
        if not (directory / "first-failure-receipt.json").exists():
            write_json(directory / "first-failure-receipt.json", failure)
        raise
    finally:
        if fixture is not None:
            try:
                if fixture.stdin and fixture.poll() is None:
                    fixture.stdin.write('{"action":"stop"}\n'); fixture.stdin.flush()
                fixture.wait(timeout=5)
            except (OSError, subprocess.TimeoutExpired):
                fixture.kill(); fixture.wait(timeout=5)


def worker(directory: Path, read_fd: int, write_fd: int) -> None:
    PINNED["verify_sources"](directory)
    if Path(sys.prefix).resolve() != (directory / ".venv").resolve() or sys.version.split()[0] != PYTHON_VERSION:
        raise RuntimeError("Prepared isolated Python required")
    if set(os.environ) - {"PATH", "TZ", "LC_CTYPE", "__CF_USER_TEXT_ENCODING"}:
        raise RuntimeError("Unexpected inherited environment")
    metadata = json.loads((directory / "fixture-metadata.json").read_text())
    from urllib.parse import urlsplit
    import socket
    port = urlsplit(metadata["url"]).port
    denied: list[str] = []

    def audit(event: str, args: tuple[object, ...]) -> None:
        reject = False
        if event == "socket.connect":
            reject = args[1] != ("127.0.0.1", port)
        elif event == "socket.getaddrinfo":
            reject = args[0] not in ("127.0.0.1", b"127.0.0.1") or args[1] != port
        elif event == "socket.__new__":
            reject = args[1] not in (socket.AF_INET, socket.AF_UNIX)
        elif event in {"socket.bind", "socket.sendto", "socket.sendmsg", "subprocess.Popen", "os.system", "os.fork", "os.exec", "os.posix_spawn", "pty.spawn"}:
            reject = True
        if reject:
            denied.append(event)
            raise RuntimeError(f"LOCAL_HTTP_GUARD_FORBIDDEN:{event}")

    sys.addaudithook(audit)
    # The guard precedes third-party imports; AF_UNIX socketpairs serve asyncio wakeups.
    import importlib.metadata
    import importlib.util
    from dataclasses import replace
    from unittest.mock import patch
    from loguru import logger
    logger.remove(); logger.add(sys.stderr, level="WARNING", diagnose=False, backtrace=False)
    sys.path.insert(0, str(directory / "upstream/src"))
    from pusher.config import Config
    from pusher.price_state import PriceSourceState, PriceState
    specification = importlib.util.spec_from_file_location("sbx_local_http_candidate", ROOT / "integrations/pyth-hip3/sbx_listener.py")
    assert specification is not None and specification.loader is not None
    module = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = module; specification.loader.exec_module(module)
    checks: list[str] = []
    def require(condition: bool, name: str) -> None:
        if not condition:
            raise AssertionError(name)
        checks.append(name)

    def wrong_port() -> None:
        with socket.socket() as connection:
            connection.connect(("127.0.0.1", 1 if port != 1 else 2))
    for probe in (wrong_port, lambda: socket.getaddrinfo("example.invalid",443),
                  lambda: subprocess.run(["/usr/bin/true"],check=True)):
        try:
            probe()
        except RuntimeError as error:
            if not str(error).startswith("LOCAL_HTTP_GUARD_FORBIDDEN:"):
                raise
        else:
            raise AssertionError("Guard probe unexpectedly passed")
    require(len(denied) == 3, "wrong_port_external_dns_and_child_process_blocked")
    require(metadata["network"] == "sbx-test" and metadata["fixtureOnly"] is True, "synthetic_signed_node_identity")
    require(metadata["bunVersion"] == BUN_VERSION, "qualified_bun_version")
    policy = module.SbxHttpPolicy(url=metadata["url"], network=metadata["network"], methodology_hash=metadata["methodologyHash"],
                                  registry_hash=metadata["registryHash"], max_source_age_ms=5000, max_snapshot_age_ms=2000,
                                  timeout_seconds=0.3)
    for url in ("https://example.invalid/v1/feeds", f"http://localhost:{port}/v1/feeds", f"http://127.0.0.1:{port}/v1/feeds?key=forbidden",
                f"http://127.0.0.1:{port}/v1/feeds/", f"http://user@127.0.0.1:{port}/v1/feeds", f"http://127.0.0.1:{port}/v1/feeds#fragment"):
        try:
            replace(policy,url=url)
        except ValueError:
            checks.append("invalid_url_rejected:" + url.split("/",3)[2].split("@")[-1])
        else:
            raise AssertionError("Invalid URL policy accepted")
    config = Config.model_validate({"stale_price_threshold_seconds":5,"prometheus_port":0,
        "hyperliquid":{"hyperliquid_ws_urls":[],"push_urls":[],"market_name":"localfixture","asset_context_symbols":[],
                       "use_testnet":True,"publish_interval":3,"publish_timeout":1,"enable_publish":False},
        "lazer":{"lazer_urls":[],"lazer_api_key":"","feed_ids":[]},
        "seda":{"url":"","poll_interval":1,"poll_failure_interval":1,"poll_timeout":1},
        "kms":{"enable_kms":False},"multisig":{"enable_multisig":False},
        "price":{"oracle":{"B200":[{"source_type":"single","source":{"source_name":module.SOURCE_NAME,"source_id":module.FEED_ID}}]},"mark":{},"external":{}}})
    state = PriceState(config); source = PriceSourceState(module.SOURCE_NAME); state.all_states[source.name] = source
    writer = os.fdopen(write_fd,"w",buffering=1,closefd=False)
    base = metadata["now"]; clock = {"now":base}
    def control(value: dict[str, object]) -> dict[str, object]:
        writer.write(json.dumps(value)+"\n"); writer.flush()
        return read_control(read_fd)
    def set_case(scenario: str, at: int = base, observed: int = base-1000, read_at: int | None = None) -> None:
        reply = control({"action":"set","scenario":scenario,"now":at,"observedAt":observed})
        require(reply.get("ready") is True, "fixture_control:"+scenario)
        clock["now"] = at if read_at is None else read_at
    def resolved(at: int | None = None) -> dict[str,str]:
        with patch("pusher.price_state.time.time",return_value=(clock["now"] if at is None else at)/1000):
            output = state.get_all_prices()
        require(not output.mark and not output.external,"no_mark_or_external_policy")
        return output.oracle
    expected = {"localfixture:B200":metadata["expectedPrice"]}
    outcomes: dict[str, object] = {}
    lifecycle_outcomes: dict[str, object] = {}

    async def exercise() -> None:
        async with module.SbxHttpListener(policy,source,lambda:clock["now"]) as listener:
            async def ready(at: int = base, observed: int = base-1000) -> None:
                set_case("ready",at,observed)
                report = await listener.poll_once()
                require(report["status"] == "SOURCE_ACCEPTED_LOCAL","actual_http_ready_accepted")
                require(report["price"] == metadata["expectedPrice"] and report["observedAt"] == observed,"exact_price_and_original_source_time")
                require(resolved() == expected,"unmodified_resolver_exact_output")
            await ready()
            failures = {
                "missing_constituent":"SNAPSHOT_UNAVAILABLE","unavailable":"SNAPSHOT_UNAVAILABLE","not_boolean":"SNAPSHOT_UNAVAILABLE",
                "network":"NETWORK_MISMATCH","methodology":"CONFIGURATION_MISMATCH","registry":"CONFIGURATION_MISMATCH",
                "scope":"PUBLICATION_SCOPE_MISMATCH","scope_missing":"PUBLICATION_SCOPE_MISMATCH","scope_extra":"PUBLICATION_SCOPE_MISMATCH",
                "feed_identity":"FEED_IDENTITY_MISMATCH","feed_kind":"FEED_IDENTITY_MISMATCH","feed_missing":"FEED_IDENTITY_MISMATCH",
                "feed_duplicate":"INVALID_OR_DUPLICATE_FEED","feed_unavailable":"FEED_UNAVAILABLE",
                "price_number":"INVALID_PRICE","price_noncanonical":"INVALID_PRICE","price_nonfinite":"INVALID_PRICE",
                "price_zero":"INVALID_PRICE","price_oversized":"INVALID_PRICE","price_conflict":"SOURCE_ROLLBACK_OR_CONFLICT",
                "source_boolean":"INVALID_SOURCE_CLOCK","source_future":"SOURCE_CLOCK_POLICY","source_rollback":"SOURCE_ROLLBACK_OR_CONFLICT",
                "mixed_clock":"MIXED_SNAPSHOT_CLOCK","snapshot_stale":"SNAPSHOT_CLOCK_POLICY","snapshot_future":"SNAPSHOT_CLOCK_POLICY",
                "snapshot_rollback":"SNAPSHOT_ROLLBACK","input_missing":"INVALID_INPUT_REFERENCES","demo":"INVALID_SNAPSHOT",
                "http_error":"HTTP_STATUS","redirect":"HTTP_STATUS","malformed":"MALFORMED_JSON","duplicate_json":"DUPLICATE_JSON_KEY",
                "nonfinite_json":"NONFINITE_JSON_NUMBER","overflow_float":"NONFINITE_JSON_NUMBER",
                "oversized_integer":"JSON_INTEGER_LIMIT","oversized":"BODY_LIMIT","wrong_content_type":"CONTENT_TYPE",
                "encoded_body":"CONTENT_ENCODING","timeout":"HTTP_FAILURE_OR_TIMEOUT",
            }
            for scenario, reason in failures.items():
                await ready(); set_case(scenario)
                report = await listener.poll_once(); outcomes[scenario] = report
                require(report == {"status":"SOURCE_UNAVAILABLE_LOCAL","reason":reason},"refused:"+scenario)
                require(source.get(module.FEED_ID) is None and resolved() == {},"immediately_cleared:"+scenario)
            await ready(); set_case("ready",base+4000)
            report = await listener.poll_once()
            require(report.get("reason") == "SOURCE_CLOCK_POLICY","source_stale_at_exact_limit")
            require(resolved() == {},"source_age_failure_clears_state")
            await ready(base+2000,base+1000)
            set_case("http_error",base+2001,base+1000); await listener.poll_once()
            set_case("ready",base+2001,base-1000)
            require((await listener.poll_once()).get("reason") == "SOURCE_ROLLBACK_OR_CONFLICT","source_watermark_survives_clear")
            set_case("ready",base+1999,base+1000,base+2001)
            require((await listener.poll_once()).get("reason") == "SNAPSHOT_ROLLBACK","calculation_watermark_survives_clear")
            await ready(base+3000,base+2000)
            await ready(base+6000,base+2000)
            require(source.get(module.FEED_ID).timestamp == (base+2000)/1000,"repeated_http_does_not_renew_source_age")
            require(resolved(base+7000) == {},"official_resolver_independently_expires_source")
            set_case("ready",base+7000,base+2000)
            require((await listener.poll_once()).get("reason") == "SOURCE_CLOCK_POLICY","listener_expires_same_retrieval")
            await ready(base+8000,base+7000)
            # Gamma updates its real signed input while alpha/beta stay at the
            # old timestamp. The benchmark changes; its oldest-source age does not.
            set_case("partial_refresh",base+8500,base+7000)
            report = await listener.poll_once()
            require(report.get("status") == "SOURCE_ACCEPTED_LOCAL", "partial_refresh_accepted")
            require(report["price"] == "3.623457" and report["observedAt"] == base+7000,
                    "partial_refresh_price_changes_without_age_reset")
            require(resolved() == {"localfixture:B200":"3.623457"}, "partial_refresh_official_resolver_exact_value")
            require(source.get(module.FEED_ID).timestamp == (base+7000)/1000, "partial_refresh_retains_oldest_source_time")
            require(resolved(base+12000) == {}, "partial_refresh_still_expires_at_oldest_source_limit")
            set_case("price_conflict",base+8500,base+7000)
            require((await listener.poll_once()).get("reason") == "SOURCE_ROLLBACK_OR_CONFLICT",
                    "conflicting_price_at_same_calculation_still_rejected")
            require(resolved() == {}, "same_calculation_conflict_clears_source")
        require(source.get(module.FEED_ID) is None,"closing_listener_invalidates_source")

    async def lifecycle() -> None:
        # Scheduling barriers use ordinary httpx response hooks after real HTTP
        # body delivery. They never mock transport, snapshot data or the resolver.
        lifecycle_policy = replace(policy, timeout_seconds=2)
        async def accept(listener: object, at: int = base, observed: int = base-1000) -> None:
            set_case("ready", at, observed)
            require((await listener.poll_once())["status"] == "SOURCE_ACCEPTED_LOCAL", "lifecycle_actual_http_ready")
            require(resolved() == expected, "lifecycle_official_resolver_ready")

        async def paused(listener: object, at: int = base, observed: int = base-1000):
            set_case("ready", at, observed)
            reached, release = asyncio.Event(), asyncio.Event()
            async def barrier(response: object) -> None:
                await response.aread()
                reached.set()
                await release.wait()
            listener._client.event_hooks["response"].append(barrier)
            pending = asyncio.create_task(listener.poll_once())
            await asyncio.wait_for(reached.wait(), 2)
            return pending, release

        async def refuses_reopen(listener: object, name: str) -> None:
            try:
                await listener.__aenter__()
            except RuntimeError as error:
                require(str(error) == "LISTENER_LIFECYCLE_BUSY", name)
            else:
                raise AssertionError("Reopened while prior lifecycle still active")

        listener = module.SbxHttpListener(lifecycle_policy, source, lambda: clock["now"])
        await listener.__aenter__()
        try:
            await accept(listener, base+1000, base)
            pending, release = await paused(listener, base+2000, base+1000)
            await listener.__aexit__(None, None, None)
            require(listener._client is None and resolved() == {}, "closed_client_and_state_invalidated")
            await refuses_reopen(listener, "reopen_refused_until_old_poll_settles")
            release.set()
            report = await asyncio.wait_for(pending, 2)
            lifecycle_outcomes["close_after_buffered_response"] = report
            require(report.get("reason") == "LISTENER_LIFECYCLE_CHANGED" and resolved() == {}, "buffered_poll_cannot_restore_closed_source")
            require(not listener._busy and listener._last_source_ms == base and listener._last_calculated_ms == base+1000,
                    "discarded_poll_does_not_advance_watermarks")
            await listener.__aenter__()
            set_case("ready", base+1001, base-1)
            require((await listener.poll_once()).get("reason") == "SOURCE_ROLLBACK_OR_CONFLICT", "reopen_retains_source_watermark")
            set_case("ready", base+999, base, base+1001)
            require((await listener.poll_once()).get("reason") == "SNAPSHOT_ROLLBACK", "reopen_retains_calculation_watermark")
            await accept(listener, base+1001, base)
            lifecycle_outcomes["reopen_after_settlement"] = "SOURCE_ACCEPTED_LOCAL_WITH_PRIOR_WATERMARKS"
        finally:
            await listener.__aexit__(None, None, None)

        # Also stop before aclose completes, so invalidation must precede its await.
        listener = module.SbxHttpListener(lifecycle_policy, source, lambda: clock["now"])
        await listener.__aenter__()
        try:
            await accept(listener)
            pending, release = await paused(listener)
            client = listener._client
            close_reached, close_release = asyncio.Event(), asyncio.Event()
            original_close = client.aclose
            async def delayed_close() -> None:
                close_reached.set()
                await close_release.wait()
                await original_close()
            client.aclose = delayed_close
            closing = asyncio.create_task(listener.__aexit__(None, None, None))
            try:
                await asyncio.wait_for(close_reached.wait(), 2)
                require(listener._closing and listener._client is None and resolved() == {}, "invalidation_precedes_client_close_await")
                await refuses_reopen(listener, "reopen_refused_while_client_closing")
                release.set()
                report = await asyncio.wait_for(pending, 2)
                lifecycle_outcomes["poll_finishes_during_close"] = report
                require(report.get("reason") == "LISTENER_LIFECYCLE_CHANGED" and resolved() == {}, "poll_cannot_restore_source_during_close")
                await refuses_reopen(listener, "settled_poll_cannot_bypass_unfinished_close")
            finally:
                close_release.set()
                await asyncio.wait_for(closing, 2)
            await listener.__aenter__()
            await accept(listener)
        finally:
            await listener.__aexit__(None, None, None)

        async with module.SbxHttpListener(lifecycle_policy, source, lambda: clock["now"]) as listener:
            await accept(listener)
            pending, release = await paused(listener, base+1000, base)
            pending.cancel()
            try:
                await pending
            except asyncio.CancelledError:
                lifecycle_outcomes["cancel_buffered_poll"] = "CANCELLED_SOURCE_CLEARED"
            else:
                raise AssertionError("Active poll cancellation was swallowed")
            release.set()
            require(not listener._busy and resolved() == {}, "cancellation_releases_poll_and_clears_source")
            require(listener._last_source_ms == base-1000 and listener._last_calculated_ms == base,
                    "cancelled_poll_does_not_advance_watermarks")
            await accept(listener)

        async with module.SbxHttpListener(lifecycle_policy, source, lambda: clock["now"]) as listener:
            await accept(listener)
            pending, release = await paused(listener, base+1000, base)
            try:
                await listener.poll_once()
            except RuntimeError as error:
                require(str(error) == "CONCURRENT_POLL_FORBIDDEN", "second_poll_refused")
            else:
                raise AssertionError("Concurrent poll unexpectedly accepted")
            require(listener._busy and resolved() == expected and listener._last_source_ms == base-1000,
                    "refused_poll_preserves_active_owner_and_watermarks")
            release.set()
            report = await asyncio.wait_for(pending, 2)
            lifecycle_outcomes["concurrent_poll_owner"] = report
            require(report["status"] == "SOURCE_ACCEPTED_LOCAL" and not listener._busy and resolved() == expected,
                    "owning_poll_completes_after_concurrent_refusal")
            require(listener._last_source_ms == base and listener._last_calculated_ms == base+1000,
                    "only_successful_owner_advances_watermarks")
        require(resolved() == {}, "lifecycle_test_leaves_source_unavailable")

    async def all_exercises() -> None:
        await exercise()
        await lifecycle()
    asyncio.run(all_exercises())
    stats = control({"action":"stats"})
    require(stats["requests"] == stats["actualRouteRequests"] and stats["requests"] > 70,"all_http_requests_crossed_real_oracle_node_route")
    require(len(denied) == 3,"no_unexpected_network_or_process_attempts")
    require(not any(name in sys.modules for name in ("pusher.publisher","pusher.main","pusher.kms_signer","pusher.seda_listener","pusher.lazer_listener")),"no_publisher_signer_main_or_other_oracle_listener_imported")
    before = json.loads((directory / "input-hashes.json").read_text())
    require(before == inputs(),"tested_source_files_unchanged")
    write_json(directory / "acceptance-receipt.json", {"schemaVersion":1,"status":"LOCAL_HTTP_ACCEPTANCE_PASSED",
        "completedAt":int(time.time()*1000),"officialRevision":REVISION,"pythonVersion":sys.version.split()[0],"bunVersion":metadata["bunVersion"],
        "checksPassed":len(checks),"checks":checks,"failureOutcomes":outcomes,"lifecycleOutcomes":lifecycle_outcomes,"fixture":metadata,"http":stats,
        "sbxInputFiles":before,"upstreamFiles":PINNED["FILES"],"lockSha256":digest(directory / "upstream/uv.lock"),
        "dependencies":sorted([{"name":d.metadata["Name"],"version":d.version} for d in importlib.metadata.distributions()],key=lambda d:d["name"].lower()),
        "guard":{"python":"CPython audit hook permits only the exact IPv4 loopback fixture endpoint; AF_UNIX socketpairs support asyncio; inherited fixture-control pipes are allowed",
                 "bun":"existing outgoing-network guard plus one captured, constrained loopback-only Bun.serve exception",
                 "emptyEnvironment":True,"osSandbox":False,"blockedProbes":denied,"unexpectedAttempts":0},
        "watermarks":"In-memory only; survive invalid responses and clearing but not process restart",
        "sourceAuthentication":"Pinned loopback process only; HTTP JSON is not independently signed",
        "managedIngestionAccepted":False,"nativePythFeedAssigned":False,"published":False,"venueConsumptionProven":False,
        "scope":"Signed synthetic OracleNode inputs -> actual existing /v1/feeds HTTP route -> unaccepted SBX listener -> unmodified official resolver; no publisher or submission"})
    print(json.dumps({"status":"LOCAL_HTTP_ACCEPTANCE_PASSED","checksPassed":len(checks),"actualRouteRequests":stats["actualRouteRequests"],"published":False},indent=2))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command",choices=("prepare","test","_worker"))
    parser.add_argument("--directory",type=Path,default=DEFAULT_DIRECTORY)
    parser.add_argument("--prepared",type=Path,default=DEFAULT_PREPARED)
    parser.add_argument("--bun",default="bun")
    parser.add_argument("--control-read-fd",type=int,default=-1)
    parser.add_argument("--control-write-fd",type=int,default=-1)
    args = parser.parse_args(); directory = args.directory.resolve()
    if args.command == "prepare":
        prepare(directory,args.prepared.resolve())
    elif args.command == "test":
        test(directory,args.bun)
    else:
        worker(directory,args.control_read_fd,args.control_write_fd)


if __name__ == "__main__":
    main()
