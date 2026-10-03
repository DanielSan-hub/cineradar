// robots.txt compliance for broad source monitoring. Parsing is pure; the
// fetcher caches one decision table per origin for the lifetime of a run.

export const ROBOTS_USER_AGENT_TOKEN = "cineradarbot";

/**
 * Parse robots.txt into the rule group that applies to CineRadarBot: its own
 * group when present, otherwise the `*` group.
 */
export function parseRobots(text, { agent = ROBOTS_USER_AGENT_TOKEN } = {}) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key === "user-agent") {
      if (!lastWasAgent || !current) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === "allow" || key === "disallow") current.rules.push({ allow: key === "allow", path: value });
    else if (key === "crawl-delay" && Number.isFinite(Number(value))) current.crawlDelay = Number(value);
  }
  const own = groups.find((group) => group.agents.some((name) => name !== "*" && agent.includes(name)));
  const star = groups.find((group) => group.agents.includes("*"));
  const group = own ?? star ?? { rules: [], crawlDelay: null };
  return { rules: group.rules, crawlDelay: group.crawlDelay };
}

function ruleMatches(rulePath, path) {
  if (!rulePath) return false;
  const anchored = rulePath.endsWith("$");
  const body = anchored ? rulePath.slice(0, -1) : rulePath;
  const pattern = body.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${pattern}${anchored ? "$" : ""}`).test(path);
}

/** Longest matching rule wins; Allow wins ties (Google/RFC 9309 semantics). */
export function isPathAllowed(robots, pathWithQuery) {
  let best = null;
  for (const rule of robots?.rules ?? []) {
    if (!ruleMatches(rule.path, pathWithQuery)) continue;
    const length = rule.path.replace(/\$$/, "").length;
    if (!best || length > best.length || (length === best.length && rule.allow)) {
      best = { length, allow: rule.allow };
    }
  }
  return best ? best.allow : true;
}

/**
 * Per-run robots cache. Missing (4xx) robots.txt means allowed; server errors
 * or timeouts are treated as disallowed for this run, per RFC 9309.
 */
export function createRobotsChecker({ fetchImpl = fetch, userAgent, timeoutMs = 10_000 } = {}) {
  const cache = new Map();
  async function load(origin) {
    try {
      const response = await fetchImpl(`${origin}/robots.txt`, {
        headers: userAgent ? { "User-Agent": userAgent } : {},
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status >= 400 && response.status < 500) return { rules: [], crawlDelay: null };
      if (!response.ok) return { unreachable: true, rules: [], crawlDelay: null };
      const text = (await response.text()).slice(0, 512_000);
      return parseRobots(text);
    } catch (error) {
      // A host name that does not resolve is a lapsed domain, not a hiccup.
      const dns = /^(?:ENOTFOUND|EAI_NONAME)$/.test(String(error?.cause?.code ?? error?.code ?? ""));
      return { unreachable: true, dns, rules: [], crawlDelay: null };
    }
  }
  return async function check(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return { allowed: false, reason: "INVALID_URL" };
    }
    if (!cache.has(parsed.origin)) cache.set(parsed.origin, load(parsed.origin));
    const robots = await cache.get(parsed.origin);
    if (robots.unreachable) return { allowed: false, reason: robots.dns ? "DNS_NOT_FOUND" : "ROBOTS_UNREACHABLE" };
    const allowed = isPathAllowed(robots, `${parsed.pathname}${parsed.search}`);
    return { allowed, reason: allowed ? null : "ROBOTS_DISALLOWED", crawlDelay: robots.crawlDelay };
  };
}
