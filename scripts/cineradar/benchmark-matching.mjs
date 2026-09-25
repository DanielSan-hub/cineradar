import { createHash } from "node:crypto";

export const BENCHMARK_TIERS = ["CORE", "MAINSTREAM", "HIDDEN", "LONG_TAIL"];

const TRACKING_PARAMETERS = new Set([
  "dclid",
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
  "msclkid",
  "ref",
  "ref_src",
  "source",
  "utm_campaign",
  "utm_content",
  "utm_medium",
  "utm_source",
  "utm_term",
]);
const SHARED_PLATFORM_HOSTS = new Set([
  "eventival.com",
  "festhome.com",
  "filmfreeway.com",
  "filmfestplatform.com",
  "shortfilmdepot.com",
  "submittable.com",
]);
const FIELD_ALIASES = {
  title: ["canonical_name", "canonicalName", "title", "name", "opportunity_name", "Opportunità"],
  organizer: ["organizer", "organizer_name", "organization", "organisation", "institution", "host"],
  eventSeries: ["event_series", "eventSeries", "series", "series_name", "canonical_name", "canonicalName", "title", "name"],
  edition: ["edition", "edition_number", "cycle"],
  editionYear: ["edition_year", "editionYear"],
  callYear: ["call_year", "opportunity_year", "opportunityYear", "year"],
  geography: ["geography", "location", "country", "region"],
  category: ["category", "opportunity_category", "type"],
  sourceFamily: ["source_family", "sourceFamily"],
  deadline: ["deadline", "closes_at", "close_date"],
  urls: [
    "source_url",
    "sourceUrl",
    "official_url",
    "officialUrl",
    "application_url",
    "applicationUrl",
    "url",
    "base_url",
  ],
};

function nestedObjects(value) {
  const result = [value];
  for (const key of ["raw_payload", "rawPayload", "metadata", "data"]) {
    let nested = value?.[key];
    if (typeof nested === "string") {
      try {
        nested = JSON.parse(nested);
      } catch {
        nested = null;
      }
    }
    if (nested && typeof nested === "object" && !Array.isArray(nested)) result.push(nested);
  }
  return result;
}

function fieldValues(value, aliases) {
  const values = [];
  for (const object of nestedObjects(value)) {
    for (const alias of aliases) {
      const candidate = object?.[alias];
      if (candidate !== null && candidate !== undefined && candidate !== "") values.push(candidate);
    }
  }
  return values;
}

function firstField(value, aliases) {
  return fieldValues(value, aliases)[0] ?? null;
}

export function normalizeIdentityText(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("en")
    .replace(/&/g, " and ")
    .replace(/[’']/g, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeEventSeries(value) {
  return normalizeIdentityText(value)
    .replace(/\b(?:19|20)\d{2}\b/g, " ")
    .replace(/\b\d{1,3}(?:st|nd|rd|th)\b/g, " ")
    .replace(/\b(?:annual\s+)?edition\s+\d{1,3}\b/g, " ")
    .replace(/\b(?:open call|call for (?:entries|films|projects)|applications?|submissions?)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractUrl(value) {
  const match = String(value ?? "").match(/https?:\/\/[^\s<>"'`]+/i);
  return match?.[0]?.replace(/[),.;\]}]+$/g, "") ?? null;
}

export function canonicalUrlKey(value) {
  const extracted = extractUrl(value);
  if (!extracted) return null;
  try {
    const url = new URL(extracted);
    if (!/^https?:$/.test(url.protocol)) return null;
    url.hash = "";
    url.hostname = url.hostname.toLocaleLowerCase("en").replace(/^www\./, "");
    if ((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443")) {
      url.port = "";
    }
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMETERS.has(key.toLocaleLowerCase("en"))) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    let pathname = url.pathname.replace(/\/{2,}/g, "/");
    if (/\/(?:index\.(?:html?|php))$/i.test(pathname)) pathname = pathname.replace(/index\.(?:html?|php)$/i, "");
    if (pathname.length > 1) pathname = pathname.replace(/\/+$/, "");
    const query = url.searchParams.toString();
    return `${url.hostname}${url.port ? `:${url.port}` : ""}${pathname || "/"}${query ? `?${query}` : ""}`;
  } catch {
    return null;
  }
}

function urlHost(key) {
  return key?.split(/[/?]/, 1)[0]?.split(":", 1)[0] ?? null;
}

function isSharedPlatformHost(host) {
  return [...SHARED_PLATFORM_HOSTS].some((candidate) => host === candidate || host?.endsWith(`.${candidate}`));
}

function parseYear(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  if (Number.isInteger(numeric) && numeric >= 1900 && numeric <= 2100) return numeric;
  const match = String(value).match(/\b((?:19|20)\d{2})\b/);
  return match ? Number(match[1]) : null;
}

function normalizeEdition(value) {
  const normalized = normalizeIdentityText(value);
  return normalized || null;
}

function explicitYears(value) {
  const years = new Set();
  for (const field of [...FIELD_ALIASES.editionYear, ...FIELD_ALIASES.callYear]) {
    for (const candidate of fieldValues(value, [field])) {
      const year = parseYear(candidate);
      if (year) years.add(year);
    }
  }
  for (const candidate of fieldValues(value, FIELD_ALIASES.title)) {
    const year = parseYear(candidate);
    if (year) years.add(year);
  }
  if (!years.size) {
    const year = parseYear(firstField(value, FIELD_ALIASES.deadline));
    if (year) years.add(year);
  }
  return [...years].sort((left, right) => left - right);
}

function primaryYear(value) {
  return parseYear(firstField(value, FIELD_ALIASES.editionYear))
    ?? parseYear(firstField(value, FIELD_ALIASES.callYear))
    ?? parseYear(firstField(value, FIELD_ALIASES.title))
    ?? parseYear(firstField(value, FIELD_ALIASES.deadline));
}

function allUrlKeys(value) {
  const keys = fieldValues(value, FIELD_ALIASES.urls)
    .flatMap((candidate) => Array.isArray(candidate) ? candidate : [candidate])
    .map(canonicalUrlKey)
    .filter(Boolean);
  return [...new Set(keys)];
}

function broadGeography(value) {
  const geography = normalizeIdentityText(value);
  if (!geography) return "Unknown";
  if (/\b(?:usa|united states|canada|north america)\b/.test(geography)) return "USA / Canada";
  if (/\b(?:mexico|latin america|south america|central america|caribbean|argentina|bolivia|brazil|brasil|chile|colombia|costa rica|cuba|ecuador|guatemala|panama|paraguay|peru|puerto rico|uruguay|venezuela)\b/.test(geography)) return "Latin America / Caribbean";
  if (/\b(?:mena|middle east|qatar|uae|united arab emirates|bahrain|iran|iraq|israel|jordan|kuwait|lebanon|oman|palestine|saudi arabia|syria|yemen)\b/.test(geography)) return "Middle East";
  if (/\b(?:australia|new zealand|oceania|pacific islands?)\b/.test(geography)) return "Oceania";
  if (/\b(?:africa|algeria|angola|cameroon|egypt|ethiopia|ghana|kenya|morocco|nigeria|senegal|south africa|tunisia|uganda|zimbabwe)\b/.test(geography)) return "Africa";
  if (/\b(?:asia|japan|china|hong kong|india|indonesia|korea|malaysia|philippines|singapore|taiwan|thailand|vietnam)\b/.test(geography)) return "Asia";
  if (/\b(?:europe|eu|uk|united kingdom|england|scotland|wales|ireland|italy|france|germany|spain|portugal|austria|belgium|bulgaria|croatia|czech|denmark|finland|greece|hungary|iceland|netherlands|norway|poland|romania|serbia|slovakia|slovenia|sweden|switzerland)\b/.test(geography)) return "Europe";
  if (/\bglobal\b|\binternational\b/.test(geography)) return "Global / International";
  return "Other / Unclassified";
}

export function categoryGroup(value) {
  const category = normalizeIdentityText(value);
  if (!category) return "Unknown";
  if (/\b(?:music video)\b/.test(category)) return "Music video";
  if (/\b(?:animation|animated)\b/.test(category)) return "Animation";
  if (/\b(?:residency|artist in residence|research residency)\b/.test(category)) return "Residencies";
  if (/\b(?:grant|fund|funding|commission)\b/.test(category)) return "Grants / funding / commissions";
  if (/\b(?:lab|fellowship|development programme|development program|co production forum)\b/.test(category)) return "Labs / fellowships";
  if (/\b(?:brand|advertising|platform sponsored|creator challenge|hackathon)\b/.test(category)) return "Platform / branded challenges";
  if (/\b(?:xr|immersive)\b/.test(category)) return "XR / immersive";
  if (/\b(?:media art|new media|moving image|video art|digital art|experimental|art science|technology prize)\b/.test(category)) return "Experimental / new media";
  if (/\b(?:ai|generative|human ai|artificial intelligence)\b/.test(category)) return "AI / generative film";
  if (/\b(?:festival|short film|filmmaking|film competition)\b/.test(category)) return "Film festivals / competitions";
  return "Other";
}

export function geographyGroup(value) {
  return broadGeography(value);
}

export function sourceFamily(value) {
  const explicit = normalizeIdentityText(firstField(value, FIELD_ALIASES.sourceFamily));
  if (explicit) return explicit;
  const host = urlHost(allUrlKeys(value)[0]);
  if (!host) return "unknown";
  if (host === "filmfreeway.com" || host.endsWith(".filmfreeway.com")) return "structured/filmfreeway";
  if (host === "festhome.com" || host.endsWith(".festhome.com")) return "structured/festhome";
  if (host === "shortfilmdepot.com" || host.endsWith(".shortfilmdepot.com")) return "structured/shortfilmdepot";
  if (host === "eventival.com" || host.endsWith(".eventival.com")) return "structured/eventival";
  if (host === "submittable.com" || host.endsWith(".submittable.com")) return "structured/submittable";
  if (/^(?:www\.)?(?:facebook|instagram|linkedin|reddit|tiktok|x|twitter)\.com$/.test(host)) return "social/community";
  return "direct/official-or-publisher";
}

export function normalizeOpportunity(value, { benchmark = false, index = 0 } = {}) {
  const title = String(firstField(value, FIELD_ALIASES.title) ?? "").trim();
  const organizer = String(firstField(value, FIELD_ALIASES.organizer) ?? "").trim();
  const eventSeries = String(firstField(value, FIELD_ALIASES.eventSeries) ?? title).trim();
  const geography = String(firstField(value, FIELD_ALIASES.geography) ?? "").trim();
  const category = String(firstField(value, FIELD_ALIASES.category) ?? "").trim();
  const edition = normalizeEdition(firstField(value, FIELD_ALIASES.edition));
  const editionYear = parseYear(firstField(value, FIELD_ALIASES.editionYear));
  const year = primaryYear(value);
  const urls = allUrlKeys(value);
  return {
    id: String(
      benchmark
        ? value.benchmark_id ?? value.id ?? `benchmark-${index + 1}`
        : value.id ?? value.slug ?? `record-${index + 1}`,
    ),
    title,
    titleKey: normalizeIdentityText(title),
    organizer,
    organizerKey: normalizeIdentityText(organizer),
    eventSeries,
    eventSeriesKey: normalizeEventSeries(eventSeries),
    edition,
    editionYear,
    year,
    years: explicitYears(value),
    geography,
    geographyKey: normalizeIdentityText(geography),
    geographyGroup: broadGeography(geography),
    category,
    categoryGroup: categoryGroup(category),
    sourceFamily: sourceFamily(value),
    urls,
    hosts: [...new Set(urls.map(urlHost).filter(Boolean))],
    tier: benchmark
      ? String(value.discovery_tier ?? value.benchmark_class ?? "UNCLASSIFIED").trim().toUpperCase()
      : null,
  };
}

function temporalSignals(benchmark, record) {
  const editionConflict = benchmark.editionYear && record.editionYear
    && benchmark.editionYear !== record.editionYear;
  const editionExact = Boolean(
    benchmark.editionYear && record.editionYear && benchmark.editionYear === record.editionYear,
  ) || Boolean(benchmark.edition && record.edition && benchmark.edition === record.edition);
  const sharedYears = benchmark.years.filter((year) => record.years.includes(year));
  const yearExact = editionExact || sharedYears.length > 0
    || Boolean(benchmark.year && record.year && benchmark.year === record.year);
  const yearConflict = !yearExact && Boolean(benchmark.year && record.year && benchmark.year !== record.year);
  return { conflict: Boolean(editionConflict || yearConflict), editionExact, yearExact };
}

function exactIntersection(left, right) {
  const rightSet = new Set(right);
  return left.find((value) => rightSet.has(value)) ?? null;
}

function tokenDice(left, right) {
  const leftTokens = new Set(left.split(" ").filter(Boolean));
  const rightTokens = new Set(right.split(" ").filter(Boolean));
  if (!leftTokens.size || !rightTokens.size) return 0;
  let intersection = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) intersection += 1;
  return (2 * intersection) / (leftTokens.size + rightTokens.size);
}

function jaroWinkler(left, right) {
  if (left === right) return left ? 1 : 0;
  if (!left || !right) return 0;
  const range = Math.max(0, Math.floor(Math.max(left.length, right.length) / 2) - 1);
  const leftMatched = Array(left.length).fill(false);
  const rightMatched = Array(right.length).fill(false);
  let matches = 0;
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const start = Math.max(0, leftIndex - range);
    const end = Math.min(right.length, leftIndex + range + 1);
    for (let rightIndex = start; rightIndex < end; rightIndex += 1) {
      if (rightMatched[rightIndex] || left[leftIndex] !== right[rightIndex]) continue;
      leftMatched[leftIndex] = true;
      rightMatched[rightIndex] = true;
      matches += 1;
      break;
    }
  }
  if (!matches) return 0;
  let transpositions = 0;
  let rightIndex = 0;
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    if (!leftMatched[leftIndex]) continue;
    while (!rightMatched[rightIndex]) rightIndex += 1;
    if (left[leftIndex] !== right[rightIndex]) transpositions += 1;
    rightIndex += 1;
  }
  const jaro = (
    matches / left.length
    + matches / right.length
    + (matches - transpositions / 2) / matches
  ) / 3;
  let prefix = 0;
  while (prefix < 4 && left[prefix] === right[prefix]) prefix += 1;
  return jaro + prefix * 0.1 * (1 - jaro);
}

export function titleSimilarity(left, right) {
  const normalizedLeft = normalizeEventSeries(left);
  const normalizedRight = normalizeEventSeries(right);
  if (!normalizedLeft || !normalizedRight) return 0;
  return 0.55 * jaroWinkler(normalizedLeft, normalizedRight)
    + 0.45 * tokenDice(normalizedLeft, normalizedRight);
}

function rounded(value, precision = 4) {
  const multiplier = 10 ** precision;
  return Math.round(value * multiplier) / multiplier;
}

export function compareOpportunity(benchmarkValue, recordValue, options = {}) {
  const benchmark = benchmarkValue.titleKey
    ? benchmarkValue
    : normalizeOpportunity(benchmarkValue, { benchmark: true });
  const record = recordValue.titleKey
    ? recordValue
    : normalizeOpportunity(recordValue);
  const fuzzyThreshold = options.fuzzyThreshold ?? 0.94;
  const temporal = temporalSignals(benchmark, record);
  if (temporal.conflict) return null;

  const url = exactIntersection(benchmark.urls, record.urls);
  const titleExact = Boolean(benchmark.titleKey && benchmark.titleKey === record.titleKey);
  const seriesExact = Boolean(
    benchmark.eventSeriesKey && benchmark.eventSeriesKey === record.eventSeriesKey,
  );
  const organizerExact = Boolean(
    benchmark.organizerKey && benchmark.organizerKey === record.organizerKey,
  );
  const geographyExact = Boolean(
    benchmark.geographyKey && benchmark.geographyKey === record.geographyKey,
  );
  const host = exactIntersection(
    benchmark.hosts.filter((value) => !isSharedPlatformHost(value)),
    record.hosts.filter((value) => !isSharedPlatformHost(value)),
  );

  if (url) {
    const rootUrl = url.slice(urlHost(url).length).split("?", 1)[0] === "/";
    const sharedPlatform = isSharedPlatformHost(urlHost(url));
    // A canonical URL proves where a record was seen, not which opportunity it
    // describes. Shared submission pages and publisher homepages are especially
    // prone to false benchmark credit without corroborating identity.
    const identitySupported = sharedPlatform
      ? titleExact || (seriesExact && organizerExact)
      : titleExact || seriesExact || (organizerExact && geographyExact && temporal.yearExact);
    if (identitySupported && (!rootUrl || (organizerExact && (titleExact || seriesExact)))) {
      return {
        method: "canonical_url",
        confidence: rounded(Math.min(
          0.999,
          0.97
            + (titleExact || seriesExact ? 0.012 : 0)
            + (temporal.yearExact ? 0.008 : 0)
            + (organizerExact ? 0.004 : 0),
        )),
        signals: {
          canonical_url: url,
          title_exact: titleExact,
          event_series_exact: seriesExact,
          organizer_exact: organizerExact,
          year_exact: temporal.yearExact,
        },
      };
    }
  }

  if (organizerExact && seriesExact && (temporal.editionExact || temporal.yearExact)) {
    return {
      method: "organizer_event_series_edition",
      confidence: temporal.editionExact ? 0.965 : 0.955,
      signals: {
        organizer_exact: true,
        event_series_exact: true,
        edition_exact: temporal.editionExact,
        year_exact: temporal.yearExact,
      },
    };
  }

  if (titleExact && organizerExact && geographyExact && temporal.yearExact) {
    return {
      method: "title_organizer_geography_year",
      confidence: 0.935,
      signals: {
        title_exact: true,
        organizer_exact: true,
        geography_exact: true,
        year_exact: true,
      },
    };
  }

  const similarity = titleSimilarity(benchmark.eventSeries, record.eventSeries);
  const strongSourceSupport = organizerExact || Boolean(host);
  const contextualSupport = temporal.yearExact || geographyExact;
  const supportCount = [
    organizerExact,
    Boolean(host),
    temporal.yearExact,
    geographyExact,
    benchmark.categoryGroup === record.categoryGroup && benchmark.categoryGroup !== "Unknown",
  ].filter(Boolean).length;
  if (
    similarity >= fuzzyThreshold
    && strongSourceSupport
    && contextualSupport
    && supportCount >= 2
  ) {
    return {
      method: "fuzzy_secondary",
      confidence: rounded(Math.min(0.929, 0.88 + (similarity - fuzzyThreshold) * 0.5)),
      signals: {
        title_similarity: rounded(similarity),
        organizer_exact: organizerExact,
        direct_host_exact: host ?? null,
        geography_exact: geographyExact,
        year_exact: temporal.yearExact,
        category_group_exact: benchmark.categoryGroup === record.categoryGroup,
      },
    };
  }
  return null;
}

const METHOD_ORDER = new Map([
  ["canonical_url", 4],
  ["organizer_event_series_edition", 3],
  ["title_organizer_geography_year", 2],
  ["fuzzy_secondary", 1],
]);

function compareCandidates(left, right) {
  return right.confidence - left.confidence
    || (METHOD_ORDER.get(right.method) ?? 0) - (METHOD_ORDER.get(left.method) ?? 0)
    || left.benchmark.id.localeCompare(right.benchmark.id)
    || left.record.id.localeCompare(right.record.id);
}

function publicIdentity(value) {
  return {
    id: value.id,
    title: value.title || null,
    year: value.year,
    category: value.category || null,
    geography: value.geography || null,
    tier: value.tier,
  };
}

export function matchBenchmarkRows(benchmarkRows, discoveredRows, options = {}) {
  const benchmarks = benchmarkRows.map((row, index) => normalizeOpportunity(
    row,
    { benchmark: true, index },
  ));
  const records = discoveredRows.map((row, index) => normalizeOpportunity(row, { index }));
  const candidates = [];
  for (const benchmark of benchmarks) {
    for (const record of records) {
      const comparison = compareOpportunity(benchmark, record, options);
      if (comparison) candidates.push({ benchmark, record, ...comparison });
    }
  }
  candidates.sort(compareCandidates);

  const byRecord = new Map();
  for (const candidate of candidates) {
    const list = byRecord.get(candidate.record.id) ?? [];
    list.push(candidate);
    byRecord.set(candidate.record.id, list);
  }
  const ambiguousRecordIds = new Set();
  const ambiguityTolerance = options.ambiguityTolerance ?? 0.006;
  for (const record of records) {
    if (byRecord.has(record.id)) continue;
    const sharedUrlRows = benchmarks.filter((benchmark) =>
      benchmark.urls.some((url) =>
        isSharedPlatformHost(urlHost(url)) && record.urls.includes(url),
      ),
    );
    if (sharedUrlRows.length > 1) ambiguousRecordIds.add(record.id);
  }
  for (const [recordId, list] of byRecord) {
    list.sort(compareCandidates);
    if (
      list.length > 1
      && list[0].method === list[1].method
      && list[0].benchmark.id !== list[1].benchmark.id
      && list[0].confidence - list[1].confidence <= ambiguityTolerance
    ) {
      ambiguousRecordIds.add(recordId);
    }
  }

  const byBenchmark = new Map();
  for (const candidate of candidates) {
    const list = byBenchmark.get(candidate.benchmark.id) ?? [];
    list.push(candidate);
    byBenchmark.set(candidate.benchmark.id, list);
  }
  const ambiguousBenchmarkIds = new Set();
  for (const [benchmarkId, list] of byBenchmark) {
    list.sort(compareCandidates);
    if (
      list.length > 1
      && list[0].method === "fuzzy_secondary"
      && list[1].method === "fuzzy_secondary"
      && list[0].record.id !== list[1].record.id
      && list[0].confidence - list[1].confidence <= ambiguityTolerance
    ) {
      ambiguousBenchmarkIds.add(benchmarkId);
    }
  }

  const usedBenchmarks = new Set();
  const usedRecords = new Set();
  const matches = [];
  for (const candidate of candidates) {
    if (
      usedBenchmarks.has(candidate.benchmark.id)
      || usedRecords.has(candidate.record.id)
      || ambiguousRecordIds.has(candidate.record.id)
      || ambiguousBenchmarkIds.has(candidate.benchmark.id)
    ) continue;
    usedBenchmarks.add(candidate.benchmark.id);
    usedRecords.add(candidate.record.id);
    matches.push({
      benchmark: publicIdentity(candidate.benchmark),
      record: publicIdentity(candidate.record),
      method: candidate.method,
      confidence: candidate.confidence,
      signals: candidate.signals,
    });
  }
  matches.sort((left, right) => left.benchmark.id.localeCompare(right.benchmark.id));

  const misses = benchmarks
    .filter((benchmark) => !usedBenchmarks.has(benchmark.id))
    .map((benchmark) => ({
      benchmark: publicIdentity(benchmark),
      reason: ambiguousBenchmarkIds.has(benchmark.id)
        ? "ambiguous_candidates"
        : (byBenchmark.has(benchmark.id) ? "candidate_collision_or_ambiguous_record" : "no_conservative_match"),
    }));
  return {
    matches,
    misses,
    candidate_count: candidates.length,
    ambiguous_benchmark_ids: [...ambiguousBenchmarkIds].sort(),
    ambiguous_record_ids: [...ambiguousRecordIds].sort(),
    unmatched_record_ids: records
      .filter((record) => !usedRecords.has(record.id))
      .map((record) => record.id)
      .sort(),
    normalized_benchmarks: benchmarks,
  };
}

export function deterministicBenchmarkSplit(value, options = {}) {
  const holdoutRatio = options.holdoutRatio ?? 0.2;
  if (!(holdoutRatio >= 0 && holdoutRatio < 1)) {
    throw new Error("holdoutRatio must be at least 0 and less than 1");
  }
  const id = String(value.benchmark_id ?? value.id ?? firstField(value, FIELD_ALIASES.title) ?? "");
  const salt = options.salt ?? "cineradar-benchmark-v1";
  const digest = createHash("sha256").update(`${salt}|${id}`).digest();
  const bucket = digest.readUIntBE(0, 6) / 2 ** 48;
  return bucket < holdoutRatio ? "holdout" : "train";
}

function metric(rows, matchedIds) {
  const total = rows.length;
  const matched = rows.filter((row) => matchedIds.has(row.id)).length;
  const recall = total ? matched / total : null;
  return {
    total,
    matched,
    missed: total - matched,
    recall: recall === null ? null : rounded(recall),
    recall_percent: recall === null ? null : rounded(recall * 100, 2),
  };
}

function groupedMetrics(rows, matchedIds, key) {
  const groups = new Map();
  for (const row of rows) {
    const label = String(key(row) ?? "Unknown") || "Unknown";
    const values = groups.get(label) ?? [];
    values.push(row);
    groups.set(label, values);
  }
  return Object.fromEntries(
    [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([label, values]) => [label, metric(values, matchedIds)]),
  );
}

export function buildBenchmarkReport(benchmarkRows, discoveredRows, options = {}) {
  const matching = matchBenchmarkRows(benchmarkRows, discoveredRows, options);
  const matchedIds = new Set(matching.matches.map((match) => match.benchmark.id));
  const rows = matching.normalized_benchmarks;
  const rowById = new Map(benchmarkRows.map((row, index) => [
    String(row.benchmark_id ?? row.id ?? `benchmark-${index + 1}`),
    row,
  ]));
  const splitById = new Map(rows.map((row) => [
    row.id,
    deterministicBenchmarkSplit(rowById.get(row.id) ?? row, options),
  ]));
  const byTier = groupedMetrics(rows, matchedIds, (row) => row.tier);
  for (const tier of BENCHMARK_TIERS) byTier[tier] ??= metric([], matchedIds);
  const core = byTier.CORE;
  const hidden = byTier.HIDDEN;
  const overall = metric(rows, matchedIds);
  const gates = {
    core: { target: 0.95, actual: core.recall, passed: core.recall !== null && core.recall >= 0.95 },
    overall: { target: 0.8, actual: overall.recall, passed: overall.recall !== null && overall.recall >= 0.8 },
    hidden: { target: 0.5, actual: hidden.recall, passed: hidden.recall !== null && hidden.recall >= 0.5 },
  };
  gates.all_passed = gates.core.passed && gates.overall.passed && gates.hidden.passed;

  const trainRows = rows.filter((row) => splitById.get(row.id) === "train");
  const holdoutRows = rows.filter((row) => splitById.get(row.id) === "holdout");
  return {
    schema_version: 1,
    protocol: {
      mode: "post-discovery evaluation only",
      discovery_receives_benchmark: false,
      benchmark_used_as_production_seed: false,
      note: "The harness evaluates already-discovered records. It never invokes or supplies rows to discovery.",
    },
    benchmark: {
      authoritative_sheet: "Benchmark_Items",
      rows: rows.length,
      split: {
        algorithm: "SHA-256(salt|benchmark_id)",
        salt: options.salt ?? "cineradar-benchmark-v1",
        requested_holdout_ratio: options.holdoutRatio ?? 0.2,
        train: metric(trainRows, matchedIds),
        holdout: metric(holdoutRows, matchedIds),
        note: "Split labels are deterministic evaluation partitions; neither partition is passed to discovery.",
      },
    },
    records_evaluated: discoveredRows.length,
    recall: {
      overall,
      by_tier: byTier,
      by_category: groupedMetrics(rows, matchedIds, (row) => row.categoryGroup),
      by_category_raw: groupedMetrics(rows, matchedIds, (row) => row.category || "Unknown"),
      by_geography: groupedMetrics(rows, matchedIds, (row) => row.geographyGroup),
      by_geography_raw: groupedMetrics(rows, matchedIds, (row) => row.geography || "Unknown"),
      by_source_family: groupedMetrics(rows, matchedIds, (row) => row.sourceFamily),
      by_year_or_edition: groupedMetrics(rows, matchedIds, (row) => row.editionYear ?? row.year ?? "Unknown"),
    },
    gates,
    matching: {
      matched: matching.matches,
      missed: matching.misses,
      candidate_count: matching.candidate_count,
      ambiguous_benchmark_ids: matching.ambiguous_benchmark_ids,
      ambiguous_record_ids: matching.ambiguous_record_ids,
      unmatched_discovered_records: matching.unmatched_record_ids.length,
      unmatched_record_ids: matching.unmatched_record_ids,
      note: "Unmatched discovered records are not labeled false positives; the workbook is not the total market.",
    },
  };
}
