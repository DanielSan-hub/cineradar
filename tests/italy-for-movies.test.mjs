import assert from "node:assert/strict";
import { test } from "node:test";

import { ifmGrantUrls, ifmRawItem, parseIfmGrant } from "../scripts/cineradar/italy-for-movies.mjs";

const NOW = Date.parse("2026-10-03T10:00:00Z");
const page = (status, closing) => ({
  finalUrl: "https://www.italyformovies.it/bandi/detail/30/apulia-film-fund",
  html: "<h1>Apulia Film Fund</h1>",
  text: `Home Bandi Scheda bando Regionale e Facilities Apulia Film Fund Apertura sessioni: 26.08.2026 Scadenza sessioni: ${closing} ${status} Salva Condividi Descrizione ... Contatti dell'ente Apulia Film Commission Responsabile del procedimento - Cristina Piscitelli Telefono: +39 080 9731300 Link al bando`,
  linkRecords: [{ url: "https://www.apuliafilmcommission.it/fondi/apulia-film-fund/", text: "Link al bando" }],
});

test("Italy for Movies: grant pages from the sitemap, on www", () => {
  assert.deepEqual(ifmGrantUrls("<loc>https://italyformovies.it/bandi/detail/30/apulia-film-fund</loc><loc>https://italyformovies.it/location/x</loc>"),
    ["https://www.italyformovies.it/bandi/detail/30/apulia-film-fund"]);
});

test("an open grant with a future closing date becomes a record whose official page is the funder's", () => {
  const grant = parseIfmGrant(page("Aperto", "26.10.2026"));
  assert.equal(grant.closing, "2026-10-26");
  assert.equal(grant.opening, "2026-08-26");
  assert.equal(grant.funder, "Apulia Film Commission");
  const raw = ifmRawItem(page("Aperto", "26.10.2026"), { now: NOW });
  assert.equal(raw.deadline_evidence, "Scadenza sessioni: 26.10.2026");
  assert.equal(raw.official_url, "https://www.apuliafilmcommission.it/fondi/apulia-film-fund/");
  assert.equal(raw.category, "Grant");
  assert.equal(ifmRawItem(page("Chiuso", "26.10.2026"), { now: NOW }), null);
  assert.equal(ifmRawItem(page("Aperto", "26.08.2026"), { now: NOW }), null);
});
