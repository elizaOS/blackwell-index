const MODELS = ["B200", "B300", "GB200", "GB300"];
const REFRESH_MS = 30_000;
const SNAPSHOT_MAX_AGE_MS = 120_000;
const PROVIDERS = { aws: "AWS", azure: "Microsoft Azure", google: "Google Cloud", gcp: "Google Cloud", vast: "Vast.ai", runpod: "Runpod", lambda: "Lambda", oracle: "Oracle Cloud", nebius: "Nebius", coreweave: "CoreWeave", crusoe: "Crusoe", voltagepark: "Voltage Park", verda: "Verda", hyperstack: "Hyperstack", shadeform: "Shadeform", "prime-intellect": "Prime Intellect" };
const REASONS = {
  INSUFFICIENT_MATCHED_OPERATOR_REPORTS: "Awaiting independent source agreement",
  INSUFFICIENT_PROVIDER_GROUPS: "Awaiting sufficient provider coverage",
  MISSING_FIXED_WEIGHT_CONSTITUENT: "A required provider price is unavailable",
  EXCESSIVE_PROVIDER_DISPERSION: "Provider prices exceed the dispersion limit",
  MISSING_MODEL_COMPONENT: "All four model prices are required",
  METHODOLOGY_NOT_EFFECTIVE: "Methodology is not yet effective",
};
const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 });
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
let lastSnapshot = null;
let requestInFlight = false;

function setText(id, value) { const element = document.getElementById(id); if (element) element.textContent = value; }
function qualified(feed) { return feed?.status === "READY" && typeof feed.price === "string" && /^\d+(?:\.\d{1,6})?$/.test(feed.price) && Number.isFinite(Number(feed.price)) && Number(feed.price) > 0 && Number.isSafeInteger(feed.observedAt) && feed.observedAt > 0; }
function reason(feed) { return feed?.reasons?.map(value => REASONS[value] ?? value.toLowerCase().replaceAll("_", " ")).join("; ") || "No qualified price is available"; }
function formatPrice(feed) { return qualified(feed) ? currency.format(Number(feed.price)) : "—"; }
function timeLabel(timestamp) { return Number.isSafeInteger(timestamp) && timestamp > 0 ? dateFormat.format(timestamp) : "—"; }

export function validateSnapshot(data) {
  if (!data || data.schemaVersion !== 1 || !Number.isSafeInteger(data.calculatedAt) || data.calculatedAt <= 0 || !Array.isArray(data.feeds) || typeof data.methodologyVersion !== "string" || typeof data.publishable !== "boolean") throw new Error("Invalid feed response");
  if (data.calculatedAt > Date.now() + 30_000 || Date.now() - data.calculatedAt > SNAPSHOT_MAX_AGE_MS) throw new Error("Snapshot is stale");
  const ids = new Set();
  for (const feed of data.feeds) {
    if (!feed || typeof feed.id !== "string" || ids.has(feed.id) || !["PROVIDER", "MODEL", "COMPOSITE"].includes(feed.kind) || !["READY", "UNAVAILABLE"].includes(feed.status) || !Array.isArray(feed.reasons) || !feed.reasons.every(value => typeof value === "string")) throw new Error("Invalid feed response");
    ids.add(feed.id);
    if (feed.kind === "MODEL" && (!MODELS.includes(feed.model) || feed.id !== `SBX:${feed.model}`)) throw new Error("Invalid model feed");
    if (feed.kind === "PROVIDER" && (!MODELS.includes(feed.model) || typeof feed.provider !== "string" || !feed.provider || feed.id !== `SBX:${feed.provider}:${feed.model}`)) throw new Error("Invalid provider feed");
    if (feed.kind === "COMPOSITE" && feed.id !== "SBX") throw new Error("Invalid composite feed");
    if (feed.status === "READY" && (!qualified(feed) || feed.observedAt > data.calculatedAt + 30_000)) throw new Error("Invalid ready price");
  }
  const composite = data.feeds.find(feed => feed.kind === "COMPOSITE");
  const allModelsReady = MODELS.every(model => data.feeds.some(feed => feed.kind === "MODEL" && feed.model === model && qualified(feed)));
  if ((qualified(composite) && !allModelsReady) || (data.publishable && (!qualified(composite) || !allModelsReady))) throw new Error("Incomplete publishable snapshot");
  return data;
}

function renderProviders(feeds) {
  const providers = [...new Set(feeds.filter(feed => feed.kind === "PROVIDER" && qualified(feed)).map(feed => feed.provider))].sort();
  const body = document.getElementById("provider-rows"); if (!body) return; body.replaceChildren();
  if (!providers.length) {
    const row = document.createElement("tr"); const cell = document.createElement("td"); cell.colSpan = 5; cell.className = "empty-state"; cell.textContent = "No current provider prices."; row.append(cell); body.append(row);
  }
  for (const provider of providers) {
    const row = document.createElement("tr"); const label = document.createElement("th"); label.scope = "row"; label.textContent = PROVIDERS[provider] ?? provider; row.append(label);
    const matches = feeds.filter(feed => feed.kind === "PROVIDER" && feed.provider === provider);
    for (const model of MODELS) {
      const feed = matches.find(item => item.model === model); const cell = document.createElement("td"); cell.textContent = formatPrice(feed);
      if (qualified(feed)) { cell.title = `Observed ${timeLabel(feed.observedAt)}`; }
      else { cell.className = "unavailable"; cell.title = reason(feed); cell.setAttribute("aria-label", `Unavailable: ${reason(feed)}`); }
      row.append(cell);
    }
    body.append(row);
  }
}

function render(snapshot) {
  const composite = snapshot.feeds.find(feed => feed.kind === "COMPOSITE" && feed.id === "SBX");
  setText("composite-price", formatPrice(composite));
  for (const model of MODELS) {
    const feed = snapshot.feeds.find(item => item.kind === "MODEL" && item.model === model); const card = document.querySelector(`[data-model="${model}"]`);
    if (!card) continue;
    card.querySelector(".model-price").textContent = formatPrice(feed);
    card.querySelector(".model-price").setAttribute("aria-label", qualified(feed) ? `${formatPrice(feed)} per GPU-hour` : `Unavailable: ${reason(feed)}`);
  }
  renderProviders(snapshot.feeds);
  setText("connection-status", "");
}

function unavailable(message) {
  lastSnapshot = null;
  setText("connection-status", message);
  setText("composite-price", "—");
  for (const card of document.querySelectorAll("[data-model]")) { card.querySelector(".model-price").textContent = "—"; card.querySelector(".model-price").setAttribute("aria-label", "Unavailable: no current snapshot"); }
  const body = document.getElementById("provider-rows"); if (!body) return; body.replaceChildren(); const row = document.createElement("tr"); const cell = document.createElement("td"); cell.colSpan = 5; cell.className = "empty-state"; cell.textContent = "Prices unavailable. Retrying automatically."; row.append(cell); body.append(row);
}

async function refresh() {
  if (requestInFlight) return;
  requestInFlight = true;
  try {
    const response = await fetch("/v1/demo", { cache: "no-store", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error("Feed endpoint unavailable");
    const payload = await response.json();
    if (payload.mode !== "CENTRALIZED_DEMO" || payload.publishable !== false || payload.pythPublished !== false) throw new Error("Invalid demo response");
    const snapshot = validateSnapshot(payload);
    render(snapshot); lastSnapshot = snapshot;
  } catch (error) { unavailable(error instanceof Error && error.message === "Snapshot is stale" ? "Snapshot expired" : "Node connection unavailable"); }
  finally { requestInFlight = false; }
}

if (typeof document !== "undefined") {
  refresh();
  setInterval(refresh, REFRESH_MS);
  setInterval(() => { if (lastSnapshot && Date.now() - lastSnapshot.calculatedAt > SNAPSHOT_MAX_AGE_MS) unavailable("Snapshot expired"); }, 5_000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      if (lastSnapshot && Date.now() - lastSnapshot.calculatedAt > SNAPSHOT_MAX_AGE_MS) unavailable("Snapshot expired");
      refresh();
    }
  });
}
