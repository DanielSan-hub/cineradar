// JavaScript-only sites (Wix/Framer/React landing pages) return an almost
// empty HTML shell to a plain HTTP fetch. Cloudflare Browser Rendering loads
// them in a headless browser; its free allowance (about 10 browser minutes a
// day) is enough for the few sites that need it. Every render is reserved in
// the provider ledger (at EUR 0 inside the allowance) and capped per day.
// robots.txt is checked by the caller, exactly as for plain fetches.

import { config } from "./config.mjs";
import { finalizeProviderUsage, reserveProviderUsage, usageIdempotencyKey } from "./cost-control.mjs";
import { fetchWithTimeout } from "./http.mjs";
import { supabase } from "./supabase.mjs";
import { extractLinkRecords, extractLinks, fetchPage, plainText } from "./web-validation.mjs";

const DAILY_LIMIT = Math.max(0, Math.min(200, Number(process.env.BROWSER_RENDER_DAILY_LIMIT ?? 40) || 0));
const RENDER_TIMEOUT_MS = 30_000;
let unavailable = !process.env.BROWSER_RENDER_ENABLED || process.env.BROWSER_RENDER_ENABLED === "false";
let usedToday = null;

/**
 * fetchPage, falling back to a headless render when the page is an empty
 * JavaScript shell and rendering is allowed for this source. Conditional
 * (304) responses are returned as they are.
 */
export async function fetchPageOrRender(url, fetchOptions = {}, { allowRender = false, runId = null } = {}) {
  let page;
  try {
    page = await fetchPage(url, fetchOptions);
  } catch (error) {
    if (!allowRender || error.code !== "EMPTY_PAGE") throw error;
    const rendered = await renderPage(url, { runId });
    if (rendered) return rendered;
    throw error;
  }
  if (allowRender && !page.notModified && looksLikeJavaScriptShell(page)) {
    const rendered = await renderPage(url, { runId });
    if (rendered && rendered.text.length > page.text.length) return { ...rendered, inputUrl: page.inputUrl, finalUrl: page.finalUrl };
  }
  return page;
}

/** A plain fetch that came back as an empty JavaScript shell. */
export function looksLikeJavaScriptShell(page) {
  const text = String(page?.text ?? "");
  const links = page?.linkRecords?.length ?? 0;
  return text.length < 600 && links < 6;
}

async function rendersToday() {
  if (usedToday !== null) return usedToday;
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const rows = await supabase(
    `provider_usage_events?select=id&provider=eq.cloudflare&operation=eq.browser_render&status=in.(reserved,succeeded,uncertain)&occurred_at=gte.${encodeURIComponent(start.toISOString())}&limit=500`,
  ).catch(() => []);
  usedToday = rows.length;
  return usedToday;
}

/**
 * Render one URL in a headless browser. Returns a page shaped like fetchPage's
 * result, or null when rendering is disabled, capped for today or refused.
 */
export async function renderPage(url, { runId = null } = {}) {
  if (unavailable || !config.cloudflareAccountId || !config.cloudflareApiToken || DAILY_LIMIT === 0) return null;
  if ((await rendersToday()) >= DAILY_LIMIT) return null;
  usedToday += 1;
  const day = new Date().toISOString().slice(0, 10);
  const reservation = await reserveProviderUsage({
    idempotencyKey: usageIdempotencyKey([runId, "cloudflare", "browser_render", url, day]),
    runId,
    provider: "cloudflare",
    operation: "browser_render",
    model: "browser-rendering",
    reservedCostEur: 0,
    usageUnits: { renders: 1 },
    optional: true,
    metadata: { source_url: url },
  }).catch(() => null);
  if (!reservation) return null;
  const started = Date.now();
  let finalized = false;
  try {
    const response = await fetchWithTimeout(
      `https://api.cloudflare.com/client/v4/accounts/${config.cloudflareAccountId}/browser-rendering/content`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${config.cloudflareApiToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          rejectResourceTypes: ["image", "media", "font", "stylesheet"],
          gotoOptions: { waitUntil: "networkidle2", timeout: 20_000 },
        }),
      },
      RENDER_TIMEOUT_MS,
    );
    const body = await response.json().catch(() => null);
    const html = typeof body?.result === "string" ? body.result : null;
    if (!response.ok || !html) {
      // Missing permission, plan limit or rate limit: nothing rendered, no
      // charge; stop trying for this run.
      if ([401, 403, 429].includes(response.status)) unavailable = true;
      await finalizeProviderUsage(reservation.event_id, {
        status: "released",
        usageUnits: { renders: 0 },
        estimatedCostEur: 0,
        httpStatus: response.status,
        errorCode: `BROWSER_RENDER_HTTP_${response.status}`,
      });
      finalized = true;
      return null;
    }
    const browserMs = Number(response.headers.get("x-browser-ms-used")) || Date.now() - started;
    await finalizeProviderUsage(reservation.event_id, {
      status: "succeeded",
      usageUnits: { renders: 1, browser_ms: browserMs },
      estimatedCostEur: 0,
      providerCurrency: "USD",
      httpStatus: response.status,
    });
    finalized = true;
    const text = plainText(html).slice(0, 120_000);
    if (text.length < 80) return null;
    return {
      inputUrl: url,
      finalUrl: url,
      status: "verified",
      httpStatus: 200,
      checkedAt: new Date().toISOString(),
      redirectChain: [],
      contentType: "text/html",
      etag: null,
      lastModified: null,
      html,
      text,
      links: extractLinks(html, url),
      linkRecords: extractLinkRecords(html, url),
      notModified: false,
      rendered: true,
    };
  } catch (error) {
    if (!finalized) {
      await finalizeProviderUsage(reservation.event_id, {
        status: "uncertain",
        usageUnits: { renders: 1 },
        estimatedCostEur: 0,
        errorCode: "BROWSER_RENDER_UNCERTAIN",
      }).catch(() => {});
    }
    console.warn(`Browser render failed for ${url}: ${String(error.message).slice(0, 160)}`);
    return null;
  }
}
