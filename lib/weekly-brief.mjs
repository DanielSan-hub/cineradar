// Weekly team brief: a short, deterministic selection from the database, not
// a data dump. Pure: the caller supplies the rows. No LLM, no invented facts:
// every line repeats fields already stored on the record.

export const BRIEF_SECTIONS = Object.freeze(["action_now", "new_high_value", "for_our_films", "changed", "watch"]);
export const BRIEF_SECTION_LABELS = Object.freeze({
  action_now: "Act now",
  new_high_value: "New this week",
  for_our_films: "For our films",
  changed: "Changed",
  watch: "On watch",
});
const LIMITS = { action_now: 5, new_high_value: 5, for_our_films: 5, changed: 3, watch: 3 };
const DAY = 86_400_000;
const UNPUBLISHED = new Set(["signal", "discovered"]);

function words(value) {
  return String(value ?? "").toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 3);
}

/** The organizer adds nothing when the title already names it. */
export function organizerAddsInformation(title, organizer) {
  const organizerWords = words(organizer);
  if (!organizerWords.length) return false;
  const titleWords = new Set(words(title));
  return organizerWords.some((word) => !titleWords.has(word));
}

/** Monday (UTC) of the week the brief covers: today if Monday, else the next one. */
export function briefWeekStart(now = Date.now()) {
  const date = new Date(now);
  date.setUTCHours(0, 0, 0, 0);
  const shift = (8 - date.getUTCDay()) % 7;
  return new Date(date.getTime() + shift * DAY).toISOString().slice(0, 10);
}

function money(amount, currency) {
  const value = Number(amount);
  if (amount === null || amount === undefined || !Number.isFinite(value)) return null;
  if (value === 0) return null;
  return currency ? `${currency} ${value.toLocaleString("en")}` : value.toLocaleString("en");
}

function shortDate(iso) {
  const time = Date.parse(iso ?? "");
  if (!Number.isFinite(time)) return null;
  return new Intl.DateTimeFormat("en", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(time));
}

function isAi(row) {
  return row.category === "AI film festival" || row.ai_policy === "required" || row.ai_policy === "allowed";
}

/** Facts of a record as one short line: deadline, fee, prize. */
export function factLine(row, now = Date.now()) {
  const parts = [];
  if (row.deadline_status === "rolling") parts.push("rolling deadline");
  else if (row.deadline) {
    const days = Math.ceil((Date.parse(row.deadline) - now) / DAY);
    const date = shortDate(row.deadline);
    if (date) parts.push(`deadline ${row.deadline_status === "estimated" ? "about " : ""}${date}${Number.isFinite(days) && days >= 0 ? ` (${days === 0 ? "today" : `${days} days`})` : ""}`);
  }
  if (Number(row.entry_fee_amount) === 0 && row.entry_fee_amount !== null && row.entry_fee_amount !== undefined) parts.push("free entry");
  else if (money(row.entry_fee_amount, row.entry_fee_currency)) parts.push(`fee ${money(row.entry_fee_amount, row.entry_fee_currency)}`);
  if (money(row.prize_amount, row.prize_currency)) parts.push(`prize ${money(row.prize_amount, row.prize_currency)}`);
  if (isAi(row)) parts.push("AI film");
  return parts.join(" · ");
}

function valueScore(row, now) {
  const days = row.deadline ? (Date.parse(row.deadline) - now) / DAY : Infinity;
  return (isAi(row) ? 3 : 0)
    + (Number(row.prize_amount) > 0 ? 2 : 0)
    + (Number(row.entry_fee_amount) === 0 && row.entry_fee_amount !== null ? 1 : 0)
    + (days >= 0 && days <= 30 ? 1 : 0);
}

function item(section, row, reason, action, priority) {
  return {
    section,
    opportunity_id: row.id ?? null,
    slug: row.slug ?? null,
    title: String(row.title ?? "").slice(0, 300),
    organizer: row.organizer ?? null,
    reason: String(reason).slice(0, 500),
    action: action ? String(action).slice(0, 300) : null,
    priority,
  };
}

/**
 * Select the brief's items.
 * @param {{ published: object[], changed?: object[], watching?: object[], stats?: object, now?: number }} input
 *   published: approved public records; changed: approved records whose
 *   deadline or status changed recently (previous_* set); watching: pending
 *   records on automatic watch.
 */
export function buildWeeklyBrief({ published = [], changed = [], watching = [], stats = {}, now = Date.now() }) {
  const live = published.filter((row) => row.deadline_status === "rolling" || !row.deadline || Date.parse(row.deadline) >= now);
  const used = new Set();
  const take = (section, rows) => rows.slice(0, LIMITS[section]).map((entry) => {
    used.add(entry.row.id);
    return item(section, entry.row, entry.reason, entry.action, entry.priority);
  });

  const actionNow = take("action_now", live
    .filter((row) => row.deadline && row.deadline_status !== "rolling" && Date.parse(row.deadline) - now <= 30 * DAY)
    .sort((left, right) => Date.parse(left.deadline) - Date.parse(right.deadline))
    .map((row) => ({
      row,
      reason: factLine(row, now),
      action: "Decide whether to submit this week",
      priority: Math.max(1, 30 - Math.ceil((Date.parse(row.deadline) - now) / DAY)),
    })));

  const newHighValue = take("new_high_value", live
    .filter((row) => !used.has(row.id) && Date.parse(row.verified_at ?? "") >= now - 7 * DAY)
    .map((row) => ({ row, score: valueScore(row, now) }))
    .sort((left, right) => right.score - left.score || Date.parse(left.row.deadline ?? "9999") - Date.parse(right.row.deadline ?? "9999"))
    .map(({ row, score }) => ({ row, reason: factLine(row, now) || "Newly published", action: null, priority: score })));

  const changedItems = take("changed", changed
    .filter((row) => !used.has(row.id))
    // Publication itself (discovered -> open) is not a change of the call.
    .filter((row) => (row.previous_deadline && row.previous_deadline !== row.deadline)
      || (row.previous_status && row.previous_status !== row.status && !UNPUBLISHED.has(row.previous_status)))
    .map((row) => {
      const parts = [];
      if (row.previous_deadline && row.previous_deadline !== row.deadline) parts.push(`deadline moved from ${shortDate(row.previous_deadline) ?? "unknown"} to ${shortDate(row.deadline) ?? "unknown"}`);
      if (row.previous_status && row.previous_status !== row.status && !UNPUBLISHED.has(row.previous_status)) parts.push(`status ${row.previous_status} → ${row.status}`);
      return { row, reason: parts.join("; ") || "Details changed on the official page", action: "Check the official page", priority: 1 };
    }));

  const watch = take("watch", watching
    .filter((row) => !used.has(row.id) && isAi(row))
    .sort((left, right) => Number(right.readiness_score ?? 0) - Number(left.readiness_score ?? 0))
    .map((row) => ({ row, reason: "Recurring call seen on the official site; waiting for a confirmed deadline", action: null, priority: Number(row.readiness_score ?? 0) })));

  const items = [...actionNow, ...newHighValue, ...changedItems, ...watch]
    .map((entry, index) => ({ ...entry, position: index }));
  return { weekStart: briefWeekStart(now), generatedAt: new Date(now).toISOString(), stats, items };
}

/** Plain text for messaging apps or e-mail. */
export function renderBriefText(brief, { siteUrl = "https://cineradar.danielmaker.chatgpt.site" } = {}) {
  const lines = [`CineRadar — week of ${shortDate(`${brief.weekStart}T00:00:00Z`) ?? brief.weekStart}`];
  const stats = brief.stats ?? {};
  if (Number.isFinite(stats.public)) {
    lines.push(`${stats.public} open calls on the radar${Number.isFinite(stats.newThisWeek) ? `, ${stats.newThisWeek} new this week` : ""}.`);
  }
  for (const section of BRIEF_SECTIONS) {
    const entries = brief.items.filter((entry) => entry.section === section);
    if (!entries.length) continue;
    lines.push("", BRIEF_SECTION_LABELS[section].toUpperCase());
    for (const entry of entries) {
      lines.push(`• ${entry.title}${organizerAddsInformation(entry.title, entry.organizer) ? ` (${entry.organizer})` : ""}`);
      if (entry.reason) lines.push(`  ${entry.reason}`);
      if (entry.slug && section !== "watch") lines.push(`  ${siteUrl}/o/${entry.slug}`);
    }
  }
  if (!brief.items.length) lines.push("", "Nothing needs action this week.");
  return lines.join("\n");
}
