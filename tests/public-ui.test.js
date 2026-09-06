import { describe, expect, test } from "bun:test";
import { validateSnapshot } from "../public/assets/index.js";

// These test-only values exercise the display boundary. They are not market data.
function snapshot() {
  const now = Date.now();
  const feed = (id, kind, model) => ({ id, kind, model, provider: null, status: "READY", price: "2.500000", confidence: "0.000000", observedAt: now, calculatedAt: now, reasons: [], contributors: [], weights: {} });
  return { schemaVersion: 1, calculatedAt: now, methodologyVersion: "test-only", publishable: true,
    feeds: [...["B200", "B300", "GB200", "GB300"].map(model => feed(`SBX:${model}`, "MODEL", model)), feed("SBX", "COMPOSITE", null)] };
}

describe("public price display boundary", () => {
  test("accepts a current complete snapshot and an unpriced unavailable snapshot", () => {
    const current = snapshot(); expect(validateSnapshot(current)).toBe(current);
    const unavailable = snapshot(); unavailable.publishable = false;
    for (const feed of unavailable.feeds) { feed.status = "UNAVAILABLE"; feed.price = null; feed.observedAt = null; feed.reasons = ["MISSING_MODEL_COMPONENT"]; }
    expect(validateSnapshot(unavailable)).toBe(unavailable);
  });

  test("rejects expired and future-dated calculation times", () => {
    for (const calculatedAt of [Date.now() - 121_000, Date.now() + 31_000, 0]) {
      expect(() => validateSnapshot({ ...snapshot(), calculatedAt })).toThrow();
    }
  });

  test("rejects nonfinite, negative, zero and injected ready prices", () => {
    for (const price of ["NaN", "Infinity", "-1.00", "0.000000", "<img src=x onerror=alert(1)>", "2.5 USD", "1e3"]) {
      const current = snapshot(); current.feeds[0].price = price;
      expect(() => validateSnapshot(current)).toThrow("Invalid ready price");
    }
  });

  test("rejects duplicate feed IDs and model substitution", () => {
    const duplicate = snapshot(); duplicate.feeds.push({ ...duplicate.feeds[0] });
    expect(() => validateSnapshot(duplicate)).toThrow("Invalid feed response");
    const mismatch = snapshot(); mismatch.feeds[0].model = "B300";
    expect(() => validateSnapshot(mismatch)).toThrow("Invalid model feed");
  });

  test("rejects an available composite when one required model is absent", () => {
    const incomplete = snapshot(); incomplete.feeds.splice(2, 1); incomplete.publishable = false;
    expect(() => validateSnapshot(incomplete)).toThrow("Incomplete publishable snapshot");
  });

  test("rejects publication status without an available composite", () => {
    const incomplete = snapshot(); incomplete.feeds.pop();
    expect(() => validateSnapshot(incomplete)).toThrow("Incomplete publishable snapshot");
  });

  test("rejects an observation dated after the current calculation", () => {
    const future = snapshot(); future.feeds[0].observedAt = future.calculatedAt + 31_000;
    expect(() => validateSnapshot(future)).toThrow("Invalid ready price");
  });
});
