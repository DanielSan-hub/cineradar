/**
 * Parse an integer query parameter without allowing negative, fractional or
 * unbounded values through to PostgREST.
 *
 * @param {string | null | undefined} value
 * @param {number} fallback
 * @param {{ min: number, max: number }} bounds
 * @returns {number | null}
 */
export function parseBoundedInteger(value, fallback, { min, max }) {
  if (value === null || value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value)) return null;

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min) return null;
  return Math.min(parsed, max);
}

/**
 * Append a page while protecting the client from duplicate rows when records
 * move between pages during a refresh.
 *
 * @template {{ id: string }} T
 * @param {T[]} current
 * @param {T[]} incoming
 * @returns {T[]}
 */
export function mergeUniqueById(current, incoming) {
  const merged = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) merged.set(item.id, item);
  return [...merged.values()];
}

/**
 * Keep user search text out of PostgREST's filter grammar. Unicode letters,
 * numbers, spaces and hyphens cover normal opportunity searches without
 * permitting commas, parentheses or wildcard operators.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeOpportunityQuery(value) {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKC")
    .slice(0, 80)
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Build a bounded, allowlisted PostgREST query for the public catalogue.
 *
 * @param {{
 *   limit: number,
 *   offset: number,
 *   query?: string,
 *   category?: string,
 *   aiPolicy?: string,
 *   sort?: "urgent" | "newest" | "prize"
 * }} options
 * @returns {URLSearchParams}
 */
export function buildOpportunitiesSearchParams(options) {
  const params = new URLSearchParams({
    select: "*",
    status: "in.(verified,open,closing-soon)",
    limit: String(options.limit),
    offset: String(options.offset),
  });
  const search = normalizeOpportunityQuery(options.query);
  if (search) {
    const pattern = `*${search}*`;
    params.set(
      "or",
      `(title.ilike.${pattern},organizer.ilike.${pattern},summary.ilike.${pattern},location.ilike.${pattern})`,
    );
  }
  if (options.category && options.category !== "all") {
    params.set("category", `eq.${options.category}`);
  }
  if (options.aiPolicy && options.aiPolicy !== "all") {
    params.set("ai_policy", `eq.${options.aiPolicy}`);
  }

  const orders = {
    urgent: "featured.desc,deadline.asc.nullslast,id.asc",
    newest: "discovered_at.desc,id.asc",
    prize: "prize_amount.desc.nullslast,id.asc",
  };
  params.set("order", orders[options.sort ?? "urgent"] ?? orders.urgent);
  return params;
}
