"""Local SBX HTTP source candidate. Not an accepted Pyth service integration.

Only the existing loopback /v1/feeds route is supported. The server is trusted
to have calculated signed inputs; JSON hash fields are bindings, not signatures.
No publisher, key manager, alternate oracle or submission code is imported.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from decimal import Decimal
import json
import math
import re
import time
from typing import Callable
from urllib.parse import urlsplit

import httpx
from pusher.price_state import PriceSourceState, PriceUpdate

SOURCE_NAME = "sbx_local_http"
FEED_ID = "SBX:B200"
MAX_BODY_BYTES = 2_000_000
MAX_SAFE_INTEGER = 9_007_199_254_740_991
DIGEST = re.compile(r"[a-f0-9]{64}\Z")
DECIMAL = re.compile(r"(?:0|[1-9][0-9]*)\.[0-9]{6}\Z")


class SourceRejected(ValueError):
    """Stable, non-secret failure code for local acceptance diagnostics."""


def integer(value: object, code: str) -> int:
    if type(value) is not int or not 0 < value <= MAX_SAFE_INTEGER:
        raise SourceRejected(code)
    return value


def unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for name, value in pairs:
        if name in result:
            raise SourceRejected("DUPLICATE_JSON_KEY")
        result[name] = value
    return result


def reject_constant(_value: str) -> None:
    raise SourceRejected("NONFINITE_JSON_NUMBER")


def bounded_json_integer(value: str) -> int:
    # Bound before int() so Python's own digit limit cannot escape as ValueError.
    if len(value.lstrip("-")) > 16:
        raise SourceRejected("JSON_INTEGER_LIMIT")
    parsed = int(value)
    if abs(parsed) > MAX_SAFE_INTEGER:
        raise SourceRejected("JSON_INTEGER_LIMIT")
    return parsed


def finite_json_float(value: str) -> float:
    parsed = float(value)
    if not math.isfinite(parsed):
        raise SourceRejected("NONFINITE_JSON_NUMBER")
    return parsed


@dataclass(frozen=True)
class SbxHttpPolicy:
    url: str
    network: str
    methodology_hash: str
    registry_hash: str
    max_source_age_ms: int
    max_snapshot_age_ms: int
    future_tolerance_ms: int = 0
    timeout_seconds: float = 1.0

    def __post_init__(self) -> None:
        parsed = urlsplit(self.url)
        # Deliberately not a general remote-source framework or managed auth API.
        if (parsed.scheme != "http" or parsed.hostname != "127.0.0.1"
                or parsed.port is None or not 1 <= parsed.port <= 65535
                or parsed.netloc != f"127.0.0.1:{parsed.port}"
                or parsed.path != "/v1/feeds" or parsed.query or parsed.fragment):
            raise ValueError("LOCAL_SBX_URL_REQUIRED")
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", self.network):
            raise ValueError("INVALID_NETWORK_PIN")
        if not DIGEST.fullmatch(self.methodology_hash) or not DIGEST.fullmatch(self.registry_hash):
            raise ValueError("INVALID_CONFIGURATION_PIN")
        for age in (self.max_source_age_ms, self.max_snapshot_age_ms):
            if type(age) is not int or not 1 <= age <= 86_400_000:
                raise ValueError("INVALID_AGE_POLICY")
        if type(self.future_tolerance_ms) is not int or not 0 <= self.future_tolerance_ms <= 60_000:
            raise ValueError("INVALID_FUTURE_POLICY")
        if type(self.timeout_seconds) not in (int, float) or not 0 < self.timeout_seconds <= 30:
            raise ValueError("INVALID_TIMEOUT")


class SbxHttpListener:
    """One bounded poll at a time; failures immediately invalidate this source.

    The caller owns scheduling and must close the listener on cancellation or
    task failure. Source timestamps and the in-memory watermark never advance
    merely because transport succeeded. No persistent delivery proof is claimed.
    """

    def __init__(self, policy: SbxHttpPolicy, state: PriceSourceState,
                 clock_ms: Callable[[], int] | None = None) -> None:
        if state.name != SOURCE_NAME:
            raise ValueError("DEDICATED_SBX_STATE_REQUIRED")
        self.policy = policy
        self.state = state
        self.clock_ms = clock_ms or (lambda: int(time.time() * 1000))
        self._client: httpx.AsyncClient | None = None
        self._busy = False
        self._closing = False
        self._generation = 0
        self._last_source_ms: int | None = None
        self._last_calculated_ms: int | None = None
        self._last_price: str | None = None
        self.clear()

    def clear(self) -> None:
        self.state.state.pop(FEED_ID, None)

    async def __aenter__(self) -> SbxHttpListener:
        if self._client is not None:
            raise RuntimeError("LISTENER_ALREADY_OPEN")
        if self._closing or self._busy:
            raise RuntimeError("LISTENER_LIFECYCLE_BUSY")
        self._client = httpx.AsyncClient(trust_env=False, follow_redirects=False,
                                        timeout=self.policy.timeout_seconds)
        self._generation += 1
        return self

    async def __aexit__(self, *_args: object) -> None:
        # Invalidate ownership before any await: a buffered response may finish
        # after aclose(), and must not restore the source or its watermarks.
        client = self._client
        self._client = None
        self._generation += 1
        self.clear()
        if client is not None:
            self._closing = True
            try:
                await client.aclose()
            finally:
                self._closing = False

    def _validate(self, body: bytes) -> tuple[str, int, int]:
        try:
            snapshot = json.loads(body, object_pairs_hook=unique_object, parse_constant=reject_constant,
                                  parse_int=bounded_json_integer, parse_float=finite_json_float)
        except SourceRejected:
            raise
        except (UnicodeError, ValueError, RecursionError) as error:
            raise SourceRejected("MALFORMED_JSON") from error
        if type(snapshot) is not dict or type(snapshot.get("schemaVersion")) is not int or snapshot["schemaVersion"] != 1 or "mode" in snapshot:
            raise SourceRejected("INVALID_SNAPSHOT")
        if snapshot.get("network") != self.policy.network:
            raise SourceRejected("NETWORK_MISMATCH")
        if snapshot.get("methodologyHash") != self.policy.methodology_hash or snapshot.get("registryHash") != self.policy.registry_hash:
            raise SourceRejected("CONFIGURATION_MISMATCH")
        if snapshot.get("publicationScope") != {"kind": "MODEL", "model": "B200"}:
            raise SourceRejected("PUBLICATION_SCOPE_MISMATCH")
        if snapshot.get("publishable") is not True:
            raise SourceRejected("SNAPSHOT_UNAVAILABLE")
        now = integer(self.clock_ms(), "INVALID_CLOCK")
        calculated = integer(snapshot.get("calculatedAt"), "INVALID_SNAPSHOT_CLOCK")
        if calculated > now + self.policy.future_tolerance_ms or now - calculated >= self.policy.max_snapshot_age_ms:
            raise SourceRejected("SNAPSHOT_CLOCK_POLICY")
        if self._last_calculated_ms is not None and calculated < self._last_calculated_ms:
            raise SourceRejected("SNAPSHOT_ROLLBACK")
        inputs = snapshot.get("inputBatchHashes")
        if (type(inputs) is not list or not 1 <= len(inputs) <= 1000
                or any(type(value) is not str or not DIGEST.fullmatch(value) for value in inputs)
                or len(set(inputs)) != len(inputs)):
            raise SourceRejected("INVALID_INPUT_REFERENCES")
        feeds = snapshot.get("feeds")
        if type(feeds) is not list or not 1 <= len(feeds) <= 1000:
            raise SourceRejected("INVALID_FEED_LIST")
        ids: set[str] = set()
        selected: dict[str, object] | None = None
        for feed in feeds:
            if type(feed) is not dict or type(feed.get("id")) is not str or feed["id"] in ids:
                raise SourceRejected("INVALID_OR_DUPLICATE_FEED")
            ids.add(feed["id"])
            if feed["id"] == FEED_ID:
                selected = feed
        if selected is None or selected.get("kind") != "MODEL" or selected.get("model") != "B200" or selected.get("provider") is not None or "provider" not in selected:
            raise SourceRejected("FEED_IDENTITY_MISMATCH")
        if selected.get("status") != "READY" or selected.get("reasons") != []:
            raise SourceRejected("FEED_UNAVAILABLE")
        if type(selected.get("calculatedAt")) is not int or selected["calculatedAt"] != calculated:
            raise SourceRejected("MIXED_SNAPSHOT_CLOCK")
        price = selected.get("price")
        if type(price) is not str or len(price) > 24 or not DECIMAL.fullmatch(price) or Decimal(price) <= 0:
            raise SourceRejected("INVALID_PRICE")
        observed = integer(selected.get("observedAt"), "INVALID_SOURCE_CLOCK")
        if (observed > now + self.policy.future_tolerance_ms or observed > calculated + self.policy.future_tolerance_ms
                or now - observed >= self.policy.max_source_age_ms):
            raise SourceRejected("SOURCE_CLOCK_POLICY")
        # observedAt is the oldest contributing observation, not a benchmark
        # revision. A different constituent may change a later calculation while
        # that oldest observation (and its expiry deadline) stays unchanged.
        if self._last_source_ms is not None and observed < self._last_source_ms:
            raise SourceRejected("SOURCE_ROLLBACK_OR_CONFLICT")
        if calculated == self._last_calculated_ms and price != self._last_price:
            raise SourceRejected("SOURCE_ROLLBACK_OR_CONFLICT")
        return price, observed, calculated

    async def poll_once(self) -> dict[str, object]:
        if self._client is None:
            self.clear()
            raise RuntimeError("LISTENER_NOT_OPEN")
        if self._busy:
            raise RuntimeError("CONCURRENT_POLL_FORBIDDEN")
        client, generation = self._client, self._generation
        self._busy = True
        def owns_source() -> bool:
            return self._client is client and self._generation == generation
        try:
            # Total deadline covers trickling responses, not only each read operation.
            async with asyncio.timeout(self.policy.timeout_seconds):
                async with client.stream("GET", self.policy.url, headers={"Accept": "application/json", "Accept-Encoding": "identity"}) as response:
                    if response.status_code != 200:
                        raise SourceRejected("HTTP_STATUS")
                    if response.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json":
                        raise SourceRejected("CONTENT_TYPE")
                    if response.headers.get("content-encoding", "identity").lower() != "identity":
                        raise SourceRejected("CONTENT_ENCODING")
                    body = bytearray()
                    async for chunk in response.aiter_bytes():
                        if len(body) + len(chunk) > MAX_BODY_BYTES:
                            raise SourceRejected("BODY_LIMIT")
                        body.extend(chunk)
                    price, observed, calculated = self._validate(bytes(body))
            if not owns_source():
                raise SourceRejected("LISTENER_LIFECYCLE_CHANGED")
            self.state.put(FEED_ID, PriceUpdate(price, observed / 1000))
            self._last_source_ms, self._last_price = observed, price
            self._last_calculated_ms = calculated
            return {"status": "SOURCE_ACCEPTED_LOCAL", "feedId": FEED_ID, "price": price, "observedAt": observed, "calculatedAt": calculated}
        except SourceRejected as error:
            if owns_source():
                self.clear()
            return {"status": "SOURCE_UNAVAILABLE_LOCAL", "reason": str(error)}
        except (httpx.HTTPError, TimeoutError):
            if owns_source():
                self.clear()
            return {"status": "SOURCE_UNAVAILABLE_LOCAL", "reason": "HTTP_FAILURE_OR_TIMEOUT"}
        except BaseException:
            if owns_source():
                self.clear()
            raise
        finally:
            self._busy = False
