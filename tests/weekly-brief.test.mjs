import assert from "node:assert/strict";
import { test } from "node:test";

import {
  briefWeekStart,
  buildWeeklyBrief,
  factLine,
  organizerAddsInformation,
  renderBriefText,
} from "../lib/weekly-brief.mjs";

const NOW = Date.parse("2026-10-04T03:13:00Z"); // a Sunday
const DAY = 86_400_000;
const at = (days) => new Date(NOW + days * DAY).toISOString();

function row(id, overrides = {}) {
  return {
    id, slug: `slug-${id}`, title: `Call ${id}`, organizer: "Org", category: "Traditional festival",
    status: "open", ai_policy: "unclear", deadline: at(20), deadline_status: "confirmed",
    entry_fee_amount: null, entry_fee_currency: null, prize_amount: null, prize_currency: null,
    verified_at: at(-30), previous_deadline: null, previous_status: null, ...overrides,
  };
}

test("the brief covers the coming week (Monday, UTC)", () => {
  assert.equal(briefWeekStart(NOW), "2026-10-05");
  assert.equal(briefWeekStart(Date.parse("2026-10-05T09:00:00Z")), "2026-10-05");
});

test("act-now lists the nearest deadlines once; new items rank AI, prizes and free entry first", () => {
  const published = [
    row("late", { deadline: at(25) }),
    row("soon", { deadline: at(3) }),
    row("past", { deadline: at(-2) }),
    row("far-new-plain", { deadline: at(90), verified_at: at(-1) }),
    row("far-new-ai", { deadline: at(120), verified_at: at(-2), category: "AI film festival", prize_amount: 5000, prize_currency: "USD" }),
    row("rolling", { deadline: null, deadline_status: "rolling" }),
  ];
  const brief = buildWeeklyBrief({ published, now: NOW });
  const ids = (section) => brief.items.filter((item) => item.section === section).map((item) => item.opportunity_id);
  assert.deepEqual(ids("action_now"), ["soon", "late"]);
  assert.deepEqual(ids("new_high_value"), ["far-new-ai", "far-new-plain"]);
  assert.ok(!brief.items.some((item) => item.opportunity_id === "past"));
  assert.deepEqual(brief.items.map((item) => item.position), brief.items.map((_, index) => index));
});

test("publication is not a change; a moved deadline is", () => {
  const brief = buildWeeklyBrief({
    published: [],
    changed: [
      row("published", { previous_status: "discovered", status: "open" }),
      row("moved", { previous_deadline: at(10), deadline: at(20) }),
    ],
    now: NOW,
  });
  const changed = brief.items.filter((item) => item.section === "changed");
  assert.deepEqual(changed.map((item) => item.opportunity_id), ["moved"]);
  assert.match(changed[0].reason, /deadline moved from/);
});

test("facts are repeated from the record, never invented", () => {
  assert.equal(factLine(row("x", { deadline: at(3), entry_fee_amount: 0, prize_amount: 300000, prize_currency: "USD", category: "AI film festival" }), NOW),
    "deadline Oct 7 (3 days) · free entry · prize USD 300,000 · AI film");
  assert.equal(factLine(row("y", { deadline: null, deadline_status: "unknown" }), NOW), "");
  assert.equal(organizerAddsInformation("Golden Dunes — Dubai International Film Festival", "Golden Dunes Dubai International Film Festival"), false);
  assert.equal(organizerAddsInformation("PixLight, a Global Competition", "PixVerse"), true);
});

test("the text version groups sections and links to public pages", () => {
  const brief = buildWeeklyBrief({ published: [row("soon", { deadline: at(3) })], stats: { public: 1, newThisWeek: 0 }, now: NOW });
  const text = renderBriefText(brief, { siteUrl: "https://example.test" });
  assert.match(text, /^CineRadar — week of Oct 5/);
  assert.match(text, /ACT NOW\n• Call soon \(Org\)\n {2}deadline Oct 7 \(3 days\)\n {2}https:\/\/example\.test\/o\/slug-soon/);
  assert.match(renderBriefText(buildWeeklyBrief({ now: NOW })), /Nothing needs action this week\./);
});
