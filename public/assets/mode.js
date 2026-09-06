export const mode = typeof location !== "undefined" && new URLSearchParams(location.search).get("mode") === "real" ? "real" : "demo";
export const feedPath = mode === "real" ? "/v1/feeds" : "/v1/demo";

if (typeof document !== "undefined") {
  for (const link of document.querySelectorAll("[data-mode]")) {
    link.href = `${location.pathname}?mode=${link.dataset.mode}`;
    if (link.dataset.mode === mode) link.setAttribute("aria-current", "true");
  }
  for (const link of document.querySelectorAll('a[href="/"], a[href="/providers.html"], a[href="/methodology.html"]')) {
    link.href = `${link.getAttribute("href")}?mode=${mode}`;
  }
  for (const link of document.querySelectorAll('a[href="/v1/demo"]')) link.href = feedPath;
}
