import assert from "node:assert/strict";
import { test } from "node:test";

import {
  euRawItem,
  euTopicDetailsState,
  euTopicIdentifier,
  euTopicInScope,
  euTopicText,
  nextCutoff,
  parseEuSearchResults,
} from "../scripts/cineradar/eu-funding-connector.mjs";

const NOW = Date.parse("2026-10-03T10:00:00Z");
const result = (identifier, { type = "1", actions = [], title = "European co-development" } = {}) => ({
  url: `https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/opportunities/topic-details/${identifier}`,
  summary: title,
  metadata: {
    identifier: [identifier],
    title: [title],
    type: [type],
    status: ["31094502"],
    callIdentifier: [identifier],
    deadlineModel: ["multiple cut-off"],
    url: [`https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/opportunities/topic-details/${identifier}`],
    actions: [JSON.stringify(actions)],
    tags: ["Animation", "Documentary"],
  },
});
const open = (deadlines, opening = "2026-09-30") => [{ status: { abbreviation: "Open" }, plannedOpeningDate: opening, deadlineDates: deadlines, types: [{ typeOfAction: "CREA-LS CREA Lump Sum Grants" }] }];

test("EU topics: only the topic's own open action counts, third-party calls are skipped", () => {
  const topics = parseEuSearchResults({ results: [
    result("CREA-MEDIA-2027-TVONLINE-1", { actions: open(["2027-02-10", "2027-09-15"]), title: "TV and online content Animation projects" }),
    result("CREA-MEDIA-2023-DEVMINISLATE", { actions: [] }),
    result("CREA-MEDIA-2027-FILMDIST", { actions: [{ status: { abbreviation: "Forthcoming" }, plannedOpeningDate: "2026-12-03", deadlineDates: ["2027-04-08"] }] }),
    result("CREA-CULT-2027-COOP", { type: "8", actions: open(["2027-01-01"]) }),
  ] });
  assert.deepEqual(topics.map((topic) => topic.identifier), ["CREA-MEDIA-2027-TVONLINE-1", "CREA-MEDIA-2023-DEVMINISLATE", "CREA-MEDIA-2027-FILMDIST"]);
  const [tv, old, forthcoming] = topics;
  assert.equal(euTopicInScope(tv, { now: NOW }), true);
  // An index status of "Open" on a 2023 topic without actions is stale.
  assert.equal(euTopicInScope(old, { now: NOW }), false);
  assert.equal(euTopicInScope(forthcoming, { now: NOW, includeIndustry: true }), false);
  assert.equal(nextCutoff(tv, Date.parse("2027-03-01T00:00:00Z")), "2027-09-15");
});

test("an EU topic becomes a grounded grant record with the next cut-off and no prize", () => {
  const [topic] = parseEuSearchResults({ results: [result("CREA-MEDIA-2027-CODEV", { actions: open(["2027-03-02"]) })] });
  const raw = euRawItem(topic, { now: NOW });
  assert.equal(raw.title, "Creative Europe MEDIA – European co-development");
  assert.equal(raw.organizer, "European Commission – Creative Europe MEDIA");
  assert.equal(raw.deadline, "2027-03-02");
  assert.equal(raw.deadline_evidence, "Deadline: 2027-03-02");
  assert.equal(raw.prize_amount, null);
  assert.equal(raw.category, "Grant");
  const text = euTopicText(topic);
  for (const quote of [raw.deadline_evidence, raw.field_evidence.title, raw.organizer]) assert.ok(text.includes(quote), quote);
  assert.equal(euTopicIdentifier(raw.official_url), "CREA-MEDIA-2027-CODEV");
  assert.equal(euTopicIdentifier("https://ec.europa.eu/other"), null);
});

test("the topic's official JSON gives open status and deadlines (epoch milliseconds)", () => {
  const state = euTopicDetailsState({ TopicDetails: { actions: [{ status: { abbreviation: "Open" }, deadlineDates: ["1796083200000"] }] } });
  assert.equal(state.open, true);
  assert.deepEqual(state.deadlines, ["2026-12-01"]);
  assert.deepEqual(euTopicDetailsState(null), { open: false, deadlines: [] });
});
