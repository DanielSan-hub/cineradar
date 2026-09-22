import { config } from "./config.mjs";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "ref_src",
]);
const UNSAFE_HOSTS = new Set(["localhost", "localhost.localdomain"]);
const LINK_POSITIVE = [
  /\bapply\b/i,
  /\bapplication/i,
  /\bsubmit/i,
  /\bsubmission/i,
  /\bopen[- ]?call/i,
  /\bcall[- ]?for[- ]?entr/i,
  /\bcompetition/i,
  /\bchallenge/i,
  /\bfestival/i,
  /\bgrant/i,
  /\bresiden/i,
  /\bfellowship/i,
  /\blab\b/i,
  /\bcontest/i,
  /\bentries\b/i,
  /\bregulation/i,
  /\bdeadline/i,
  /\bbando\b/i,
  /\bconcorso\b/i,
  /\bconvocatoria\b/i,
  /\binscri(?:cao|ção|ções|coes)\b/i,
  /\bappel.{0,8}(?:projets|films|candidatures)/i,
  /\beinreichung/i,
  /\bwettbewerb/i,
  /공모|출품|신청/,
  /募集|応募|提出/,
  /征集|报名|提交/,
  /φεστιβάλ|υποβολ|πρόσκληση/iu,
];
const LINK_STRONG = [
  /\bapply\b/i,
  /\bapplication/i,
  /\bsubmit/i,
  /\bsubmission/i,
  /\bopen[- ]?call/i,
  /\bcall[- ]?for[- ]?entr/i,
  /\bgrant/i,
  /\bresiden/i,
  /\bfellowship/i,
  /\bcompetition/i,
  /\bchallenge/i,
  /\bentries\b/i,
  /\bdeadline/i,
  /\bbando\b/i,
  /\bconcorso\b/i,
  /\bconvocatoria\b/i,
  /\beinreichung/i,
  /募集|応募|提出|征集|报名|제출|공모/,
  /υποβολ|πρόσκληση/iu,
];
const LINK_NEGATIVE = [
  /(?:^|\/)archive(?:[_/-]|\/|$)/i,
  /(?:^|\/)(?:photos?|winners?|awards?|programme|program)(?:[_/-]|\/|$)/i,
  /(?:^|\/)fragments?(?:\/|$)/i,
  /(?:^|\/)privacy(?:\/|$)/i,
  /(?:^|\/)terms(?:\/|$)/i,
  /(?:^|\/)cookies?(?:\/|$)/i,
  /(?:^|\/)contact(?:\/|$)/i,
  /(?:^|\/)about(?:\/|$)/i,
  /(?:^|\/)login(?:\/|$)/i,
  /(?:^|\/)sign[-_]?in(?:\/|$)/i,
  /share=/i,
  /\.(?:jpg|jpeg|png|gif|webp|svg|ico|mp4|mov|mp3|zip)(?:\?|$)/i,
];

function decodeHtml(value) {
  return String(value ?? "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    );
}

function isPrivateIpv4(hostname) {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  return (
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    parts[0] === 0
  );
}

export function canonicalizeUrl(value, baseUrl) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = baseUrl ? new URL(decodeHtml(value.trim()), baseUrl) : new URL(value.trim());
    if (!new Set(["http:", "https:"]).has(url.protocol)) return null;
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    const unbracketedHostname = hostname.replace(/^\[|\]$/g, "");
    if (
      !hostname ||
      UNSAFE_HOSTS.has(hostname) ||
      hostname.endsWith(".localhost") ||
      isPrivateIpv4(hostname) ||
      unbracketedHostname === "::1" ||
      unbracketedHostname.startsWith("fc") ||
      unbracketedHostname.startsWith("fd") ||
      unbracketedHostname.startsWith("fe80:")
    ) {
      return null;
    }
    url.hostname = hostname;
    url.hash = "";
    if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) {
      url.port = "";
    }
    for (const name of [...url.searchParams.keys()]) {
      if (name.toLowerCase().startsWith("utm_") || TRACKING_PARAMS.has(name.toLowerCase())) {
        url.searchParams.delete(name);
      }
    }
    if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/{2,}/g, "/");
    url.searchParams.sort();
    return url.href;
  } catch {
    return null;
  }
}

export function plainText(html) {
  return decodeHtml(
    String(html ?? "")
      .replace(/<!--([\s\S]*?)-->/g, " ")
      .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<\/(?:p|div|li|h[1-6]|section|article)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[\t\f\v ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function extractLinkRecords(html, baseUrl) {
  const records = [];
  const seen = new Set();
  const anchorPattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorPattern.exec(String(html ?? "")))) {
    const attributes = match[1];
    const hrefMatch = attributes.match(/\bhref\s*=\s*(?:(["'])(.*?)\1|([^\s>]+))/i);
    if (!hrefMatch) continue;
    const url = canonicalizeUrl(hrefMatch[2] ?? hrefMatch[3], baseUrl);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    records.push({ url, text: plainText(match[2]).slice(0, 240) });
  }
  return records;
}

export function extractLinks(html, baseUrl) {
  return extractLinkRecords(html, baseUrl).map((record) => record.url);
}

export function isUrlGrounded(candidate, { sourceUrl, finalUrl, links = [] } = {}) {
  const canonical = canonicalizeUrl(candidate, finalUrl ?? sourceUrl);
  if (!canonical) return false;
  const evidenceKey = (value) => {
    const normalized = canonicalizeUrl(value, finalUrl ?? sourceUrl);
    if (!normalized) return null;
    const parsed = new URL(normalized);
    if (parsed.pathname !== "/") parsed.pathname = parsed.pathname.replace(/\/$/, "");
    return parsed.href;
  };
  const evidence = new Set(
    [sourceUrl, finalUrl, ...links]
      .map(evidenceKey)
      .filter(Boolean),
  );
  return evidence.has(evidenceKey(canonical));
}

function urlFailure(inputUrl, checkedAt, reason, httpStatus = null, finalUrl = null) {
  return {
    input_url: inputUrl ?? null,
    final_url: finalUrl,
    status: reason === "INVALID_URL" || reason === "UNSAFE_URL" ? "invalid" : "unreachable",
    http_status: httpStatus,
    checked_at: checkedAt,
    redirect_chain: [],
    reason,
  };
}

async function requestFollowingRedirects(
  inputUrl,
  { fetchImpl = fetch, timeoutMs = config.timeoutMs, headers = {}, readBody = false } = {},
) {
  const checkedAt = new Date().toISOString();
  const initial = canonicalizeUrl(inputUrl);
  if (!initial) return { ...urlFailure(inputUrl, checkedAt, "INVALID_URL"), ok: false };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let current = initial;
  const redirectChain = [];
  try {
    for (let hop = 0; hop <= 6; hop += 1) {
      const response = await fetchImpl(current, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": "CineRadarBot/2.0 (+https://cineradar.danielmaker.chatgpt.site)",
          Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.2",
          "Accept-Language": "en,it;q=0.8,el;q=0.7",
          ...headers,
        },
      });
      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers?.get?.("location");
        const next = canonicalizeUrl(location, current);
        if (!next) {
          return {
            ...urlFailure(initial, checkedAt, "INVALID_REDIRECT", response.status, current),
            redirect_chain: redirectChain,
            ok: false,
          };
        }
        redirectChain.push({ status: response.status, from: current, to: next });
        current = next;
        continue;
      }
      const result = {
        ok: response.status >= 200 && response.status < 300,
        response,
        input_url: initial,
        final_url: canonicalizeUrl(response.url || current) ?? current,
        http_status: response.status,
        checked_at: checkedAt,
        redirect_chain: redirectChain,
      };
      if (!readBody) {
        try {
          await response.body?.cancel?.();
        } catch {
          // Some fetch implementations do not expose a cancellable body.
        }
      }
      return result;
    }
    return {
      ...urlFailure(initial, checkedAt, "TOO_MANY_REDIRECTS", null, current),
      redirect_chain: redirectChain,
      ok: false,
    };
  } catch (error) {
    const reason = error?.name === "AbortError" ? "FETCH_TIMEOUT" : "FETCH_FAILED";
    return {
      ...urlFailure(initial, checkedAt, reason, null, current),
      redirect_chain: redirectChain,
      error: String(error?.message ?? error).slice(0, 300),
      ok: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function requestWithRetries(inputUrl, options = {}) {
  const attempts = Math.max(1, Math.min(3, Number(options.attempts ?? 2)));
  let result;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    result = await requestFollowingRedirects(inputUrl, options);
    if (result.ok) return result;
    const transientHttp = Number(result.http_status) >= 500;
    const transientNetwork = ["FETCH_FAILED", "FETCH_TIMEOUT"].includes(result.reason);
    if (attempt === attempts || (!transientHttp && !transientNetwork)) return result;
  }
  return result;
}

export async function fetchPage(
  url,
  { fetchImpl = fetch, timeoutMs = config.timeoutMs, maxCharacters = 120_000 } = {},
) {
  const result = await requestWithRetries(url, {
    fetchImpl,
    timeoutMs,
    readBody: true,
  });
  if (!result.ok) {
    const status = result.http_status;
    const reason = status === 404 ? "HTTP_404" : status === 410 ? "HTTP_410" : status >= 500 ? "HTTP_5XX" : result.reason ?? `HTTP_${status}`;
    const error = new Error(reason);
    error.code = reason;
    error.validation = result;
    throw error;
  }
  const contentType = result.response.headers?.get?.("content-type") ?? "";
  if (contentType && !/(?:text\/html|application\/xhtml\+xml|text\/plain)/i.test(contentType)) {
    try {
      await result.response.body?.cancel?.();
    } catch {
      // Ignore cancellation failures.
    }
    const error = new Error(`UNSUPPORTED_CONTENT_TYPE:${contentType}`);
    error.code = "UNSUPPORTED_CONTENT_TYPE";
    throw error;
  }
  const html = (await result.response.text()).slice(0, maxCharacters * 4);
  const text = plainText(html).slice(0, maxCharacters);
  if (text.length < 80) {
    const error = new Error("EMPTY_PAGE");
    error.code = "EMPTY_PAGE";
    throw error;
  }
  return {
    inputUrl: result.input_url,
    finalUrl: result.final_url,
    status: result.redirect_chain.length ? "redirected" : "verified",
    httpStatus: result.http_status,
    checkedAt: result.checked_at,
    redirectChain: result.redirect_chain,
    contentType,
    html,
    text,
    links: extractLinks(html, result.final_url),
    linkRecords: extractLinkRecords(html, result.final_url),
  };
}

export async function validateUrl(
  url,
  {
    fetchImpl = fetch,
    timeoutMs = config.timeoutMs,
    evidence,
  } = {},
) {
  const checkedAt = new Date().toISOString();
  const canonical = canonicalizeUrl(url, evidence?.finalUrl ?? evidence?.sourceUrl);
  if (!canonical) return urlFailure(url, checkedAt, "INVALID_URL");
  if (evidence && !isUrlGrounded(canonical, evidence)) {
    return urlFailure(canonical, checkedAt, "UNGROUNDED_URL");
  }
  const result = await requestWithRetries(canonical, { fetchImpl, timeoutMs });
  if (!result.ok) {
    const status = result.http_status;
    const reason = status === 404 ? "HTTP_404" : status === 410 ? "HTTP_410" : status >= 500 ? "HTTP_5XX" : result.reason ?? `HTTP_${status}`;
    return { ...result, status: "unreachable", reason };
  }
  return {
    input_url: result.input_url,
    final_url: result.final_url,
    status: result.redirect_chain.length ? "redirected" : "verified",
    http_status: result.http_status,
    checked_at: result.checked_at,
    redirect_chain: result.redirect_chain,
    reason: null,
  };
}

export function selectOpportunityLinks(
  linkRecords,
  { sourceUrl, limit = 8, year = new Date().getUTCFullYear() } = {},
) {
  const sourceHost = canonicalizeUrl(sourceUrl) ? new URL(canonicalizeUrl(sourceUrl)).hostname : null;
  return [...linkRecords]
    .map((record) => {
      const haystack = `${record.url} ${record.text}`;
      let score = LINK_POSITIVE.reduce((total, pattern) => total + Number(pattern.test(haystack)), 0);
      if (haystack.includes(String(year)) || haystack.includes(String(year + 1))) score += 2;
      if (sourceHost && new URL(record.url).hostname === sourceHost) score += 1;
      if (LINK_NEGATIVE.some((pattern) => pattern.test(haystack))) score -= 10;
      const strong = LINK_STRONG.some((pattern) => pattern.test(haystack));
      return { ...record, score, strong };
    })
    .filter((record) => record.score > 0 && record.strong)
    .sort((a, b) => b.score - a.score || a.url.localeCompare(b.url))
    .slice(0, Math.max(0, limit));
}
