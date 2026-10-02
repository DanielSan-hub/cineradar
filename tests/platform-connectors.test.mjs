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
