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

function setText(id, value) { document.getElementById(id).textContent = value; }
function qualified(feed) { return feed?.status === "READY" && typeof feed.price === "string" && /^\d+(?:\.\d{1,6})?$/.test(feed.price) && Number.isFinite(Number(feed.price)) && Number(feed.price) > 0 && Number.isSafeInteger(feed.observedAt) && feed.observedAt > 0; }
function reason(feed) { return feed?.reasons?.map(value => REASONS[value] ?? value.toLowerCase().replaceAll("_", " ")).join("; ") || "No qualified price is available"; }
function formatPrice(feed) { return qualified(feed) ? currency.format(Number(feed.price)) : "—"; }
function setBadge(element, ready) { element.textContent = ready ? "Available" : "Unavailable"; element.dataset.state = ready ? "ready" : "unavailable"; }
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

function renderWeights(feed) {
  const container = document.getElementById("model-weights");
  container.replaceChildren();
  const weights = feed?.weights;
  if (!weights || MODELS.some(model => !Number.isSafeInteger(weights[model]) || weights[model] <= 0)) {
    const empty = document.createElement("span"); empty.textContent = "Not available"; container.append(empty); return;
  }
  const total = MODELS.reduce((sum, model) => sum + weights[model], 0);
  for (const model of MODELS) {
    const item = document.createElement("div"); item.className = "weight-item";
    const label = document.createElement("span"); label.textContent = model;
    const weight = document.createElement("span"); weight.textContent = `${(weights[model] / total * 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
    item.append(label, weight); container.append(item);
  }
}

function renderProviders(feeds) {
  const providers = [...new Set(feeds.filter(feed => feed.kind === "PROVIDER").map(feed => feed.provider))].sort();
  const body = document.getElementById("provider-rows"); body.replaceChildren();
  if (!providers.length) {
    const row = document.createElement("tr"); const cell = document.createElement("td"); cell.colSpan = 5; cell.className = "empty-state"; cell.textContent = "No provider feeds are configured in this snapshot."; row.append(cell); body.append(row);
  }
  let available = 0;
  for (const provider of providers) {
    const row = document.createElement("tr"); const label = document.createElement("th"); label.scope = "row"; label.textContent = PROVIDERS[provider] ?? provider; row.append(label);
    const matches = feeds.filter(feed => feed.kind === "PROVIDER" && feed.provider === provider);
    if (matches.some(qualified)) available++;
    for (const model of MODELS) {
      const feed = matches.find(item => item.model === model); const cell = document.createElement("td"); cell.textContent = formatPrice(feed);
      if (qualified(feed)) { cell.title = `Observed ${timeLabel(feed.observedAt)}`; }
      else { cell.className = "unavailable"; cell.title = reason(feed); const detail = document.createElement("span"); detail.className = "cell-detail"; detail.textContent = "Unavailable"; cell.append(detail); }
      row.append(cell);
    }
    body.append(row);
  }
  setText("provider-summary", `${available} of ${providers.length} providers with qualified prices`);
}

function render(snapshot) {
  const composite = snapshot.feeds.find(feed => feed.kind === "COMPOSITE" && feed.id === "SBX");
  setText("composite-price", formatPrice(composite)); setBadge(document.getElementById("composite-status"), qualified(composite));
  setText("composite-reason", qualified(composite) ? `Oldest contributing observation: ${timeLabel(composite.observedAt)}` : reason(composite));
  renderWeights(composite);
  for (const model of MODELS) {
    const feed = snapshot.feeds.find(item => item.kind === "MODEL" && item.model === model); const card = document.querySelector(`[data-model="${model}"]`);
    card.querySelector(".model-price").textContent = formatPrice(feed); setBadge(card.querySelector(".badge"), qualified(feed));
    card.querySelector(".feed-reason").textContent = qualified(feed) ? `Observed ${timeLabel(feed.observedAt)}` : reason(feed);
  }
  renderProviders(snapshot.feeds);
  setText("calculated-at", timeLabel(snapshot.calculatedAt)); document.getElementById("calculated-at").dateTime = new Date(snapshot.calculatedAt).toISOString();
  setText("methodology-version", snapshot.methodologyVersion); setText("benchmark-status", snapshot.publishable ? "Qualified for publication" : "Not ready for publication");
  setText("connection-status", "Connected to node"); document.getElementById("connection-dot").dataset.state = "ready";
}

function unavailable(message) {
  lastSnapshot = null;
  setText("connection-status", message); document.getElementById("connection-dot").dataset.state = "error";
  setText("composite-price", "—"); setBadge(document.getElementById("composite-status"), false); setText("composite-reason", "No current snapshot is available."); renderWeights(null);
  for (const card of document.querySelectorAll("[data-model]")) { card.querySelector(".model-price").textContent = "—"; setBadge(card.querySelector(".badge"), false); card.querySelector(".feed-reason").textContent = "No current snapshot."; }
  const body = document.getElementById("provider-rows"); body.replaceChildren(); const row = document.createElement("tr"); const cell = document.createElement("td"); cell.colSpan = 5; cell.className = "empty-state"; cell.textContent = "Provider status is unavailable. The page will retry automatically."; row.append(cell); body.append(row);
  setText("provider-summary", "Source status unavailable"); setText("calculated-at", "—"); document.getElementById("calculated-at").removeAttribute("datetime"); setText("methodology-version", "—"); setText("benchmark-status", "Unavailable");
}

async function refresh() {
  if (requestInFlight) return;
  requestInFlight = true;
  try {
    const response = await fetch("/v1/feeds", { cache: "no-store", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error("Feed endpoint unavailable");
    const snapshot = validateSnapshot(await response.json());
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
