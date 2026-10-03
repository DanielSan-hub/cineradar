import assert from "node:assert/strict";
import test from "node:test";

import {
  festhomeRawItem,
  finalFesthomeDeadline,
  parseFesthomeDeadlines,
  parseFesthomeListing,
  platformWebsite,
} from "../scripts/cineradar/platform-connectors.mjs";

const NOW = Date.parse("2026-10-03T10:00:00Z");

// Shape of a Festhome festival page once reduced to text (dates and labels on
// separate lines, a countdown before some dates, section deadlines after).
const FESTIVAL_TEXT = [
  "Example Film Week",
  "Deadlines",
  "15 Jul 2026", "Call for entries",
  "15 Oct 2026", "Final deadline", "12", "days",
  "20 Oct 2026", "Notification date",
  "26 Nov 2026", "03 Dec 2026",
  "Sections with other deadlines:",
  "01 Oct 2026", "Official Section Featur...",
  "Address", "Calle Mayor 1, Córdoba, Spain",
  "Festival description",
].join("\n");

function festivalPage({ text = FESTIVAL_TEXT, links = [] } = {}) {
  return {
    finalUrl: "https://filmmakers.festhome.com/festival/8147",
    checkedAt: "2026-10-03T10:00:00.000Z",
    html: `<script type="application/ld+json">{"@type":"Event","name":"Example Film Week 2026"}</script>`,
    text,
    linkRecords: links,
  };
}

test("Festhome listing cards carry id, name and the dates shown", () => {
  const html = [
    `<div class="festival_card-container-1"><img alt="Logo of Example Film Week &amp; Lab" />`,
    `<a onclick="OpenNewTab(event,8147)" data-full_url="example-film-week">`,
    `<span>15 October 2026</span></a></div>`,
    `<div class="festival_card-container-2"><img alt="Logo of Closed Fest" /><a href="/festival/9001"></a></div>`,
  ].join("");
  assert.deepEqual(parseFesthomeListing(html), [
    { id: "8147", name: "Example Film Week & Lab", slug: "example-film-week", dates: ["2026-10-15"] },
    { id: "9001", name: "Closed Fest", slug: null, dates: [] },
  ]);
});

test("the final submission deadline is the last 'deadline' label, never notification or event dates", () => {
  const entries = parseFesthomeDeadlines(FESTIVAL_TEXT);
  assert.deepEqual(entries.map((entry) => [entry.date, entry.label]).slice(0, 3), [
    ["2026-07-15", "Call for entries"],
    ["2026-10-15", "Final deadline"],
    ["2026-10-20", "Notification date"],
  ]);
  const final = finalFesthomeDeadline(entries);
  assert.equal(final.date, "2026-10-15");
  assert.equal(final.evidence, "15 Oct 2026 Final deadline");
  assert.equal(finalFesthomeDeadline(parseFesthomeDeadlines("Deadlines\n15 Jul 2026\nCall for entries\nAddress")), null);
  assert.deepEqual(parseFesthomeDeadlines("No calendar on this page"), []);
});

test("the festival's own website is the first external link that is not social, CDN or FilmFreeway", () => {
  assert.equal(platformWebsite([
    { url: "https://festhome.com/legal" },
    { url: "https://www.facebook.com/examplefilmweek" },
    { url: "https://filmfreeway.com/ExampleFilmWeek" },
    { url: "mailto:info@example.org" },
    { url: "https://examplefilmweek.org/" },
  ]), "https://examplefilmweek.org/");
  assert.equal(platformWebsite([{ url: "https://instagram.com/x" }]), null);
});

test("a Festhome page yields a grounded raw item: platform deadline, own website, platform application link", () => {
  const raw = festhomeRawItem({
    page: festivalPage({ links: [{ url: "https://www.youtube.com/x" }, { url: "https://examplefilmweek.org/" }] }),
    card: { id: "8147", name: "Example Film Week" },
    now: NOW,
  });
  assert.equal(raw.title, "Example Film Week 2026");
  assert.equal(raw.organizer, "Example Film Week");
  assert.equal(raw.deadline, "2026-10-15");
  assert.equal(raw.deadline_status, "confirmed");
  assert.equal(raw.deadline_evidence, "15 Oct 2026 Final deadline");
  assert.equal(raw.deadline_source_url, "https://filmmakers.festhome.com/festival/8147");
  assert.equal(raw.official_url, "https://examplefilmweek.org/");
  assert.equal(raw.application_url, "https://filmmakers.festhome.com/festival/8147");
  assert.equal(raw.observed_status, null);
  assert.deepEqual(raw.tags, ["platform:festhome", "festhome:8147"]);
  assert.equal(raw.series_evidence.method, "platform-festhome-v1");
  // Nothing is invented: no fee, prize or location without a source.
  assert.equal(raw.entry_fee_amount, null);
  assert.equal(raw.prize_amount, null);
  assert.equal(raw.location, null);
});

test("a passed final deadline is closed and a page without a calendar gives nothing", () => {
  const closed = festhomeRawItem({ page: festivalPage(), card: { name: "Example Film Week" }, now: Date.parse("2026-11-01T00:00:00Z") });
  assert.equal(closed.observed_status, "closed");
  assert.equal(festhomeRawItem({ page: festivalPage({ text: "Example Film Week\nAddress" }), now: NOW }), null);
  // Without a website link the record keeps no official URL (never guessed).
  assert.equal(festhomeRawItem({ page: festivalPage(), now: NOW }).official_url, null);
});

test("an open call without a date shows its platform and links there; dated calls do not", async () => {
  const { deadlinePlatform, platformApplyUrl, platformCountdown } = await import("../lib/opportunity-format.ts");
  const call = { deadline: null, deadlineStatus: "unknown", tags: ["series-anchored", "via-filmfreeway"] };
  assert.equal(deadlinePlatform(call), "FilmFreeway");
  assert.equal(deadlinePlatform({ ...call, deadline: "2026-11-01", deadlineStatus: "confirmed" }), null);
  assert.equal(deadlinePlatform({ ...call, deadlineStatus: "rolling" }), null);
  assert.equal(deadlinePlatform({ ...call, tags: ["series-anchored"] }), null);
  assert.equal(platformCountdown("FilmFreeway").detail, "Deadline on FilmFreeway");
  // Only a link on that platform's own host is shown, never another site.
  assert.equal(platformApplyUrl("https://filmfreeway.com/KinoAthens", "FilmFreeway"), "https://filmfreeway.com/KinoAthens");
  assert.equal(platformApplyUrl("https://evil.example/filmfreeway.com", "FilmFreeway"), null);
  assert.equal(platformApplyUrl("javascript:alert(1)", "FilmFreeway"), null);
  assert.equal(platformApplyUrl("https://filmfreeway.com/KinoAthens", null), null);
});

test("FestAgent listing cards give name, own website, dates and the organizer-managed flag", async () => {
  const { parseFestagentListing } = await import("../scripts/cineradar/platform-connectors.mjs");
  const card = (id, name, extra) => `<div class="festival "\n     id="${id}">\n${extra.labels ?? ""}<div class="title-link">\n <a target="" href="/en/festivals/${id}">\n <img alt="x" />\n ${name}\n</a> </div>\n${extra.website ? `<div class="festival-website">\n <a target="_blank" rel="nofollow" href="${extra.website}">x</a>\n </div>` : ""}\n<div class="deadline-column">\n${extra.column}\n</div>\n</div>`;
  const html = `<div id="pagination_entries_info">1 — 30 of 1521 festivals</div>`
    + card("culver_fest", "Culver City Film Festival", { website: "http://culvercityfilmfestival.com/", column: `<p><span>Today</span><br><small class="text-gray deadline">\n October 03, 2026\n </small></p><p class="small text-gray after-next-deadlines">November 03, 2026<br /></p>` })
    + card("tempus", "Tempus &amp; Co", { labels: `<div class="festival-label festival-label-managed">official</div>`, website: "https://tempus.example.org/", column: `<p>The submission period is over.</p>` });
  const { total, cards } = parseFestagentListing(html);
  assert.equal(total, 1521);
  assert.deepEqual(cards.map((item) => [item.slug, item.name, item.website, item.dates, item.closed, item.managed]), [
    ["culver_fest", "Culver City Film Festival", "http://culvercityfilmfestival.com/", ["2026-10-03", "2026-11-03"], false, false],
    ["tempus", "Tempus & Co", "https://tempus.example.org/", [], true, true],
  ]);
});

test("a FestAgent page gives the final deadline, the own website, never an application link", async () => {
  const { festagentRawItem, finalFestagentDeadline, parseFestagentDeadlines } = await import("../scripts/cineradar/platform-connectors.mjs");
  const item = (label, date) => `<li class="feed-item in-future"><div class="well"><div class="title">${label}</div><div class="date">${date}</div></div></li>`;
  const html = `<meta property="og:title" content="IA en corto 2nd Edition - AI Short Film Festival"><span class="festival-label festival-label-managed">official</span>`
    + `<div class="panel-heading">\n Dates &amp; Deadlines\n </div><div class="panel-body"><ul class="feed dates " data-toggle="tooltip">`
    + item("Opening Date", "August 14, 2026") + item("Late Deadline", "October 04, 2026") + item("Extended Deadline", "October 18, 2026")
    + item("Notifications", "October 19, 2026") + item("Event Dates", "20 — 24 October 2026")
    + `</ul></div><p class="h3">Official Website</p>\n <p>\n <a target="_blank" rel="nofollow" class="website" href="http://www.iaencorto.com">iaencorto.com</a>\n </p>`;
  const entries = parseFestagentDeadlines(html);
  assert.deepEqual(entries.map((entry) => entry.label), ["Opening Date", "Late Deadline", "Extended Deadline", "Notifications"]);
  assert.equal(finalFestagentDeadline(entries).date, "2026-10-18");
  const raw = festagentRawItem({ page: { html, text: "", finalUrl: "https://festagent.com/en/festivals/ia-en-corto" }, now: NOW });
  assert.equal(raw.deadline, "2026-10-18");
  assert.equal(raw.deadline_evidence, "Extended Deadline October 18, 2026");
  assert.equal(raw.official_url, "http://www.iaencorto.com");
  assert.equal(raw.application_url, null);
  assert.equal(raw.deadline_source_url, "https://festagent.com/en/festivals/ia-en-corto");
  assert.deepEqual(raw.tags, ["platform:festagent", "festagent:ia-en-corto", "festagent:managed"]);
  assert.equal(raw.series_evidence.deadline_method, "platform-calendar");
});

test("FestAgent and Festhome pages are named as the source of what they say", async () => {
  const { dataSourceName, deadlinePlatform } = await import("../lib/opportunity-format.ts");
  assert.equal(dataSourceName("https://festagent.com/en/festivals/x"), "FestAgent");
  assert.equal(dataSourceName("https://filmmakers.festhome.com/festival/1"), "Festhome");
  assert.equal(dataSourceName("https://example.org/"), null);
  // FestAgent is a directory, never a festival's submission platform.
  assert.equal(deadlinePlatform({ deadline: null, deadlineStatus: "unknown", tags: ["via-festagent"] }), null);
});
