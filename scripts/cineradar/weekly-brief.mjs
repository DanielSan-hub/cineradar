// Weekly team brief. Selects a handful of items from stored records (act
// now, new this week, changed, on watch), stores them for /team/brief and
// prints the plain-text version. Deterministic; no provider calls.
//
//   node scripts/cineradar/weekly-brief.mjs           # print only
//   node scripts/cineradar/weekly-brief.mjs --apply   # store the draft brief

import { buildWeeklyBrief, renderBriefText } from "../../lib/weekly-brief.mjs";
import { supabase } from "./supabase.mjs";

const apply = process.argv.includes("--apply");
const now = Date.now();
const weekAgo = new Date(now - 7 * 86_400_000).toISOString();
const fields = "id,slug,title,organizer,category,status,ai_policy,deadline,deadline_status,entry_fee_amount,entry_fee_currency,prize_amount,prize_currency,verified_at,previous_deadline,previous_status,updated_at";

const [published, changed, watching] = await Promise.all([
  supabase(`opportunities?select=${fields}&review_decision=eq.approved&status=in.(verified,open,closing-soon)&order=deadline.asc.nullslast&limit=1000`),
  supabase(`opportunities?select=${fields}&review_decision=eq.approved&status=in.(verified,open,closing-soon)&updated_at=gte.${encodeURIComponent(weekAgo)}&or=(previous_deadline.not.is.null,previous_status.not.is.null)&limit=200`),
  supabase(`opportunities?select=${fields},readiness_score&review_decision=eq.pending&triage_flags=cs.{watching}&order=readiness_score.desc.nullslast&limit=200`)
    .catch(() => []),
]);
const live = published.filter((row) => row.deadline_status === "rolling" || !row.deadline || Date.parse(row.deadline) >= now);
const stats = {
  public: live.length,
  newThisWeek: live.filter((row) => Date.parse(row.verified_at ?? "") >= now - 7 * 86_400_000).length,
  watching: watching.length,
};
const brief = buildWeeklyBrief({ published, changed, watching, stats, now });
const text = renderBriefText(brief);

const summary = { mode: apply ? "apply" : "dry-run", weekStart: brief.weekStart, items: brief.items.length, stored: false };
if (apply) {
  try {
    const [existing] = await supabase(`weekly_briefs?select=id,status&week_start=eq.${brief.weekStart}&limit=1`);
    if (existing && existing.status !== "draft") {
      summary.skipped = `brief for ${brief.weekStart} is already ${existing.status}`;
    } else {
      const [row] = await supabase("weekly_briefs?on_conflict=week_start", {
        method: "POST",
        prefer: "resolution=merge-duplicates,return=representation",
        body: JSON.stringify([{ week_start: brief.weekStart, generated_at: brief.generatedAt, status: "draft", stats, text_body: text }]),
      });
      await supabase(`weekly_brief_items?brief_id=eq.${row.id}`, { method: "DELETE", prefer: "return=minimal" });
      if (brief.items.length) {
        await supabase("weekly_brief_items", {
          method: "POST",
          prefer: "return=minimal",
          body: JSON.stringify(brief.items.map((entry) => ({ brief_id: row.id, ...entry }))),
        });
      }
      summary.stored = true;
    }
  } catch (error) {
    // Before the weekly_briefs migration is applied the brief is printed only.
    if (/weekly_brief|PGRST205|42P01/i.test(String(error.message))) summary.skipped = "weekly_briefs tables are not created yet (apply 202610020002_weekly_briefs.sql)";
    else throw error;
  }
}
console.log(JSON.stringify(summary, null, 2));
console.log(`\n${text}`);
