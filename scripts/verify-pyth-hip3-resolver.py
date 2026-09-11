#!/usr/bin/env python3
"""Fetch/install explicitly, then exercise Pyth's pinned resolver without a publisher."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

REVISION = "807ff575a9090cee99b9e1a30dc23edf3522fe1b"
PYTHON_VERSION = "3.13.15"
REPOSITORY = Path(__file__).resolve().parents[1]
DEFAULT_DIRECTORY = REPOSITORY / "artifacts/pyth-hip3-resolver"
FILES = {
    "src/pusher/config.py": "51c72e52028cb4bd108441801c7274b8f4dee69930243b4d4f5b01b829b4fb11",
    "src/pusher/price_state.py": "5852eeab3765ee331f39d6ed46a0d16f1249bc2fbbdb002b5472a53bf2902c51",
    "src/pusher/metrics.py": "c6dc5464078f1d98ebc0f0db7008d2753c385477798d925b5e64cea2caf92cd8",
    "pyproject.toml": "2edbe30ca664aaa030df36fa894f6998abfc4b3fae2fef67b76ab47c6e0cbcd4",
    "uv.lock": "66af1cf8cd874cc105510141ef47ee21b737fe9e0b63cf4a314a0d7fa61121c3",
    "README.md": "8a517c42117f0d3973f950950cbeb6dc1e1965d750bde01228a55cb129742d14",
    "LICENSE": "5d3028d6a4592795fff63b36871eb965b72e55caff6f5a007e3b5958bc69e9f7",
}


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
    path.chmod(0o600)


def source_url(name: str) -> str:
    relative = name if name == "LICENSE" else f"apps/hip-3-pusher/{name}"
    return f"https://raw.githubusercontent.com/pyth-network/pyth-crosschain/{REVISION}/{relative}"


def verify_sources(directory: Path) -> None:
    for name, expected in FILES.items():
        path = directory / "upstream" / name
        if not path.is_file() or path.is_symlink() or digest(path) != expected:
            raise RuntimeError(f"Pinned source missing or changed: {name}; run prepare")
    # The fixture intentionally has no signing, request, listener or publisher module.
    modules = {p.name for p in (directory / "upstream/src/pusher").glob("*.py")}
    if modules != {"config.py", "price_state.py", "metrics.py"}:
        raise RuntimeError("Unexpected module in the minimal upstream fixture")


def prepare(directory: Path) -> None:
    """This is the only network-enabled command. No source imports are executed here."""
    import urllib.request

    directory.mkdir(parents=True, exist_ok=True)
    for name, expected in FILES.items():
        path = directory / "upstream" / name
        if path.is_symlink():
            raise RuntimeError(f"Refusing symlink: {path}")
        if not path.is_file() or digest(path) != expected:
            with urllib.request.urlopen(source_url(name), timeout=30) as response:
                content = response.read(2_000_001)
            if len(content) > 2_000_000 or hashlib.sha256(content).hexdigest() != expected:
                raise RuntimeError(f"Pinned upstream download hash mismatch: {name}")
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
    verify_sources(directory)
    uv = shutil.which("uv")
    if uv is None:
        raise RuntimeError("uv is required for the separate prepare command")
    command = [uv, "--no-config", "sync", "--frozen", "--no-dev", "--no-install-project", "--managed-python", "--python", PYTHON_VERSION]
    # Keep runtime, venv and caches confined to this disposable acceptance directory.
    environment = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": str(Path.home()),
        "UV_CACHE_DIR": str(directory / "cache"),
        "UV_PYTHON_INSTALL_DIR": str(directory / "python"),
        "UV_PROJECT_ENVIRONMENT": str(directory / ".venv"),
        "UV_NO_ENV_FILE": "1",
    }
    with (directory / "prepare-install.log").open("w") as output:
        subprocess.run(command, cwd=directory / "upstream", env=environment, stdout=output, stderr=subprocess.STDOUT, check=True)
    write_json(directory / "provenance.json", {
        "schemaVersion": 1, "phase": "PREPARED_NOT_TESTED", "revision": REVISION,
        "pythonVersion": PYTHON_VERSION, "installCommand": command,
        "upstreamProjectInstalled": False,
        "files": [{"path": name, "url": source_url(name), "sha256": value} for name, value in FILES.items()],
    })
    print(f"Prepared pinned sources and locked dependencies: {directory}")


def test(directory: Path, bun_argument: str) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    write_json(directory / "acceptance-receipt.json", {"status": "LOCAL_RESOLVER_ACCEPTANCE_RUNNING", "officialRevision": REVISION})
    try:
        run_test(directory, bun_argument)
    except Exception as error:
        write_json(directory / "acceptance-receipt.json", {"status": "LOCAL_RESOLVER_ACCEPTANCE_FAILED", "officialRevision": REVISION, "errorType": type(error).__name__})
        raise


def run_test(directory: Path, bun_argument: str) -> None:
    verify_sources(directory)
    python = directory / ".venv/bin/python"
    if not python.is_file():
        raise RuntimeError("Prepared Python environment missing; run prepare first")
    bun = shutil.which(bun_argument)
    if not bun:
        raise RuntimeError("Bun required to calculate the guarded, synthetic SBX input fixture")
    fixture = REPOSITORY / "test/pyth-hip3-source-fixture.ts"
    guard = REPOSITORY / "scripts/capacity-offline-preload.ts"
    # Child processes receive no inherited credentials, proxy settings or provider variables.
    environment = {"PATH": "/usr/bin:/bin", "TZ": "UTC"}
    with (directory / "sbx-source-fixture.json").open("w") as output, (directory / "sbx-source-fixture.log").open("w") as error:
        subprocess.run([bun, "--no-env-file", "--preload", str(guard), str(fixture)],
                       cwd=REPOSITORY, env=environment, stdout=output, stderr=error, check=True)
    command = [str(python), "-I", str(Path(__file__).resolve()), "_worker", "--directory", str(directory)]
    with (directory / "resolver-test.log").open("w") as output:
        subprocess.run(command, cwd=REPOSITORY, env=environment, stdout=output, stderr=subprocess.STDOUT, check=True)
    print((directory / "resolver-test.log").read_text(), end="")
    print(f"Receipt: {directory / 'acceptance-receipt.json'}")


def worker(directory: Path) -> None:
    """Direct, isolated imports only. This command never instantiates Publisher."""
    verify_sources(directory)
    if Path(sys.prefix).resolve() != (directory / ".venv").resolve():
        raise RuntimeError("Acceptance requires the prepared isolated Python environment")
    if tuple(sys.version_info[:3]) != tuple(map(int, PYTHON_VERSION.split("."))):
        raise RuntimeError("Python patch version differs from the preparation pin")
    # macOS may add its text-encoding hint during interpreter initialization.
    if set(os.environ) - {"PATH", "TZ", "LC_CTYPE", "__CF_USER_TEXT_ENCODING"}:
        raise RuntimeError("Unexpected inherited environment in the acceptance worker")

    denied_events: list[str] = []

    def deny_network_and_processes(event: str, args: tuple[object, ...]) -> None:
        if event.startswith("socket.") or event in {"subprocess.Popen", "os.system", "os.fork", "os.exec", "os.posix_spawn", "pty.spawn"}:
            denied_events.append(event)
            raise RuntimeError(f"HIP3_ACCEPTANCE_NETWORK_OR_PROCESS_FORBIDDEN:{event}")

    sys.addaudithook(deny_network_and_processes)
    # Install the guard before importing the third-party resolver or dependencies.
    import importlib.metadata
    import socket
    from unittest.mock import patch
    from loguru import logger

    logger.remove()
    logger.add(sys.stderr, level="WARNING", diagnose=False, backtrace=False)

    sys.path.insert(0, str(directory / "upstream/src"))
    from pusher.config import Config
    from pusher.price_state import PriceSourceState, PriceState, PriceUpdate

    checks: list[str] = []

    def require(condition: bool, name: str) -> None:
        if not condition:
            raise AssertionError(name)
        checks.append(name)

    for probe in (lambda: socket.socket(), lambda: socket.getaddrinfo("example.invalid", 443),
                  lambda: subprocess.run(["/usr/bin/true"], check=True)):
        try:
            probe()
        except RuntimeError as error:
            if not str(error).startswith("HIP3_ACCEPTANCE_NETWORK_OR_PROCESS_FORBIDDEN:"):
                raise
        else:
            raise AssertionError("Guard failed to reject a probe")
    require(len(denied_events) == 3, "socket_dns_and_child_process_probes_blocked")

    fixture_path = directory / "sbx-source-fixture.json"
    fixture = json.loads(fixture_path.read_text())
    require(fixture["fixtureOnly"] is True and fixture["network"] == "sbx-test", "synthetic_fixture_identity")
    require(fixture["market"] == "localfixture" and fixture["sourceName"] == "sbx_local_fixture", "local_extension_is_not_a_pyth_feed_or_market_binding")
    cases = {case["name"]: case for case in fixture["cases"]}
    eligible = cases["eligible_b200"]
    require(eligible["eligible"] is True and eligible["inputBatchCount"] == 3, "sbx_calculated_signed_fixture_is_eligible")
    require(eligible["price"] == fixture["expectedPrice"] == "3.123457", "sbx_exact_calculated_decimal")
    require(eligible["observedAt"] == fixture["expectedObservedAt"] == fixture["now"] - 1000, "sbx_original_source_time_preserved")
    for name in ("missing_fixed_constituent", "draft_methodology", "stale_source", "invalid_signatures", "outside_approved_scope"):
        require(cases[name]["eligible"] is False, f"sbx_boundary_refuses_{name}")

    config = Config.model_validate({
        "stale_price_threshold_seconds": 5, "prometheus_port": 0,
        "hyperliquid": {"hyperliquid_ws_urls": [], "push_urls": [], "market_name": "localfixture",
                       "asset_context_symbols": [], "use_testnet": True, "publish_interval": 3,
                       "publish_timeout": 1, "enable_publish": False},
        "lazer": {"lazer_urls": [], "lazer_api_key": "", "feed_ids": []},
        "seda": {"url": "", "poll_interval": 1, "poll_failure_interval": 1, "poll_timeout": 1},
        "kms": {"enable_kms": False}, "multisig": {"enable_multisig": False},
        "price": {"oracle": {"B200": [{"source_type": "single", "source": {
            "source_name": "sbx_local_fixture", "source_id": "SBX:B200"}}]}, "mark": {}, "external": {}},
    })
    state = PriceState(config)
    source = PriceSourceState("sbx_local_fixture")
    state.all_states[source.name] = source
    original_time = eligible["observedAt"] / 1000

    def resolved(now: float) -> dict[str, str]:
        with patch("pusher.price_state.time.time", return_value=now):
            output = state.get_all_prices()
        if output.mark or output.external:
            raise AssertionError("No mark or external-price policy was selected")
        return output.oracle

    require(resolved(original_time + 1) == {}, "upstream_missing_source_has_no_price")
    # Only eligible, calculated SBX output crosses the local test bridge.
    for candidate in fixture["cases"]:
        if candidate["eligible"]:
            source.put(candidate["feedId"], PriceUpdate(candidate["price"], candidate["observedAt"] / 1000))
    require(resolved(original_time + 1) == {"localfixture:B200": "3.123457"}, "upstream_preserves_exact_sbx_decimal_string")
    require(resolved(original_time + 4.999) == {"localfixture:B200": "3.123457"}, "upstream_accepts_just_before_age_limit")
    require(resolved(original_time + 5) == {}, "upstream_rejects_at_exact_age_limit")
    # Repeated endpoint delivery retains observedAt; it cannot renew a source observation.
    for elapsed in (1, 2, 3, 4, 5, 6):
        source.put("SBX:B200", PriceUpdate(eligible["price"], original_time))
        require(bool(resolved(original_time + elapsed)) == (elapsed < 5), f"repeated_delivery_original_age_{elapsed}s")
    # A genuinely new successful retrieval of an unchanged tariff can advance its source time.
    source.put("SBX:B200", PriceUpdate(eligible["price"], original_time + 6))
    require(resolved(original_time + 7) == {"localfixture:B200": "3.123457"}, "unchanged_value_with_new_retrieval_can_be_fresh")
    source.state.clear()
    require(resolved(original_time + 7) == {}, "no_fallback_price_after_source_removal")
    # No exponent transformation: this would lose precision through a float conversion.
    large_decimal = "9007199254740993.123456"
    source.put("SBX:B200", PriceUpdate(large_decimal, original_time))
    require(resolved(original_time + 1) == {"localfixture:B200": large_decimal}, "upstream_decimal_wire_boundary_does_not_use_float")
    require(not any(name in sys.modules for name in ("pusher.publisher", "pusher.main", "pusher.kms_signer")), "publisher_main_and_key_manager_not_imported")
    require(len(denied_events) == 3, "no_unexpected_network_or_process_attempts")

    import_files = ["src/engine.ts", "src/offer-schedule.ts", "src/instance-resources.ts", "src/publication.ts", "src/crypto.ts", "src/decimal.ts", "src/validation.ts", "src/types.ts", "src/config.ts", "test/helpers.ts", "test/pyth-hip3-source-fixture.ts", "scripts/capacity-offline-preload.ts"]
    receipt = {
        "schemaVersion": 1, "status": "LOCAL_RESOLVER_ACCEPTANCE_PASSED", "completedAt": int(time.time() * 1000),
        "officialRevision": REVISION, "pythonVersion": sys.version.split()[0], "bunVersion": fixture["bunVersion"],
        "upstreamFiles": FILES, "harnessSha256": digest(Path(__file__).resolve()),
        "sbxInputFiles": {name: digest(REPOSITORY / name) for name in import_files},
        "fixtureSha256": digest(fixture_path), "checksPassed": len(checks), "checks": checks,
        "guard": {"python": "CPython audit hook blocks socket and subprocess operations before upstream imports",
                  "bun": "capacity-offline-preload.ts; empty inherited environment; no dotenv",
                  "osSandbox": False, "blockedProbes": denied_events, "unexpectedAttempts": 0},
        "dependencies": sorted([{"name": d.metadata["Name"], "version": d.version} for d in importlib.metadata.distributions()], key=lambda d: d["name"].lower()),
        "managedIngestionAccepted": False, "nativePythFeedAssigned": False,
        "published": False, "venueConsumptionProven": False,
        "scope": "Synthetic signed SBX inputs and an explicitly local source-state extension into the unmodified official resolver; no listener, signer, transport or venue test",
    }
    write_json(directory / "acceptance-receipt.json", receipt)
    print(json.dumps({"status": receipt["status"], "checksPassed": len(checks), "officialRevision": REVISION, "published": False}, indent=2))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["prepare", "test", "_worker"])
    parser.add_argument("--directory", type=Path, default=DEFAULT_DIRECTORY)
    parser.add_argument("--bun", default="bun", help="Bun executable used only for the offline SBX fixture")
    args = parser.parse_args()
    directory = args.directory.resolve()
    if args.command == "prepare":
        prepare(directory)
    elif args.command == "test":
        test(directory, args.bun)
    else:
        worker(directory)


if __name__ == "__main__":
    main()
