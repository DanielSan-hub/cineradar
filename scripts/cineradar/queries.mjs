const SOURCE_DISCOVERY_HINTS = Object.freeze({
  en: "official directory calendar organizer opportunities",
  it: "portale bandi calendario opportunità ente promotore",
  fr: "annuaire appels à projets calendrier organisme officiel",
  es: "directorio convocatorias calendario organismo oficial",
  pt: "diretório editais calendário instituição oficial",
  de: "Verzeichnis Ausschreibungen Kalender offizielle Institution",
  ja: "公募情報 ポータル 一覧 主催団体",
  ko: "공모 정보 포털 목록 주최 기관",
  zh: "公开征集 目录 官方机构",
  ar: "دليل الفرص الدعوات الجهة الرسمية",
});

function query(id, family, region, language, text, priority = "normal") {
  const fundingFamilies = new Set(["grants", "residencies", "labs-fellowships", "support"]);
  const platformFamilies = new Set(["ai-generative", "platform-challenges", "branded-open-calls"]);
  const sourceType = platformFamilies.has(family)
    ? "official-news"
    : fundingFamilies.has(family)
      ? "funding-directory"
      : "structured-directory";
  const sourceIntent = sourceType === "official-news"
    ? "official company announcements news archive and creator competition pages"
    : sourceType === "funding-directory"
      ? "public funding institution calls portal organizer calendar"
      : "public submission directory organizer calendar and source index";
  return {
    id,
    family,
    category: family,
    region,
    language,
    text: `${language === "en" ? `${sourceIntent} ` : ""}${text} ${SOURCE_DISCOVERY_HINTS[language] ?? SOURCE_DISCOVERY_HINTS.en}`,
    priority,
    purpose: "source-gap",
    sourceType,
    timeWindow: sourceType === "official-news"
      ? "recent-announcement"
      : sourceType === "funding-directory"
        ? "current-funding-cycle"
        : "current-next-cycle",
  };
}

function poolsForYear(year) {
  const nextYear = year + 1;
  return {
    global: [
      query("global-festivals", "festival", "global", "en", `official directory or submission portal listing international film festivals and open calls ${year} ${nextYear}`, "high"),
      query("global-support", "support", "global", "en", `directory or institutional calendar of filmmaker grants residencies labs fellowships open applications ${year} ${nextYear}`, "high"),
    ],
    categories: [
      [
        query("ai-open-call", "ai-generative", "global", "en", `AI generative film competition open call submissions ${year} ${nextYear} official`),
        query("ai-cinema-prize", "ai-generative", "global", "en", `artificial intelligence cinema prize filmmakers applications open ${year}`),
        query("ai-video-creator", "ai-generative", "global", "en", `generative video creator challenge film competition worldwide ${year}`),
      ],
      [
        query("short-open", "short-general", "global", "en", `international short film festival call for entries ${year} ${nextYear} official`),
        query("documentary-open", "short-general", "global", "en", `documentary and short film submissions open worldwide ${year}`),
        query("screen-open", "short-general", "global", "en", `independent film and screenplay competition open submissions ${year}`),
      ],
      [
        query("animation-open", "animation", "global", "en", `animation festival competition open submissions filmmakers ${year} ${nextYear}`),
        query("animated-short", "animation", "global", "en", `animated short film call for entries international ${year}`),
        query("animation-new-media", "animation", "global", "en", `animation new media festival open call artists ${year}`),
      ],
      [
        query("music-video-award", "music-video", "global", "en", `music video awards competition entries open directors ${year}`),
        query("music-video-festival", "music-video", "global", "en", `international music video festival call for submissions ${year}`),
        query("music-visuals", "music-video", "global", "en", `music visuals filmmaking contest open call ${year}`),
      ],
      [
        query("experimental-moving-image", "experimental-new-media", "global", "en", `experimental moving image festival open call ${year} ${nextYear}`),
        query("media-art-video", "experimental-new-media", "global", "en", `media art video art moving image public screen commission open-call directory ${year}`),
        query("immersive-xr", "experimental-new-media", "global", "en", `immersive XR digital art creative technology open-call calendar ${year}`),
      ],
      [
        query("film-production-grant", "grants", "global", "en", `film production grant open applications filmmakers ${year} ${nextYear}`),
        query("short-film-fund", "grants", "global", "en", `short film fund grant open call international ${year}`),
        query("audiovisual-fund", "grants", "global", "en", `audiovisual project funding call filmmakers open ${year}`),
      ],
      [
        query("filmmaker-residency", "residencies", "global", "en", `filmmaker residency moving image open applications ${year}`),
        query("media-artist-residency", "residencies", "global", "en", `media artist residency moving image artist mobility open-call directory ${year} ${nextYear}`),
        query("creative-tech-residency", "residencies", "global", "en", `creative technology storytelling residency open call ${year}`),
      ],
      [
        query("film-lab", "labs-fellowships", "global", "en", `film development lab open applications emerging filmmakers ${year}`),
        query("screen-fellowship", "labs-fellowships", "global", "en", `screenwriting directing fellowship open applications ${year}`),
        query("feature-development", "labs-fellowships", "global", "en", `feature film project development lab international applications ${year} ${nextYear}`),
      ],
      [
        query("platform-creator", "platform-challenges", "global", "en", `video platform creator challenge filmmaking competition open ${year}`),
        query("creative-software-film", "platform-challenges", "global", "en", `creative software film challenge official open call ${year}`),
        query("video-tool-contest", "platform-challenges", "global", "en", `AI video tool filmmaking contest cash prize official ${year}`),
      ],
      [
        query("branded-film", "branded-open-calls", "global", "en", `branded content film competition open entries directors ${year}`),
        query("commercial-creators", "branded-open-calls", "global", "en", `advertising commercial filmmaker open call creator competition ${year}`),
        query("brand-short-film", "branded-open-calls", "global", "en", `brand sponsored short film challenge submissions ${year}`),
      ],
    ],
    regions: [
      [
        query("eu-labs", "regional", "europe", "en", `Europe film development labs residencies grants open applications ${year}`),
        query("eu-festivals", "regional", "europe", "en", `European short film animation new media festival submissions ${year} ${nextYear}`),
        query("eu-fr", "regional", "europe", "fr", `appel à projets cinéma résidence laboratoire festival candidatures ${year}`),
        query("eu-de", "regional", "europe", "de", `Filmfestival Förderung Residenz Einreichung Wettbewerb ${year}`),
        query("eu-it", "regional", "europe", "it", `bando cinema laboratorio residenza festival cortometraggi ${year}`),
      ],
      [
        query("na-us-festival", "regional", "usa-canada", "en", `United States film TV festival submissions open ${year} ${nextYear}`),
        query("na-support", "regional", "usa-canada", "en", `North America filmmaker grants labs fellowships open applications ${year}`),
        query("na-canada", "regional", "usa-canada", "en", `Canada film funding residency festival call for submissions ${year}`),
        query("na-fr-ca", "regional", "usa-canada", "fr", `Canada appel à projets cinéma financement résidence ${year}`),
      ],
      [
        query("asia-ai", "regional", "asia", "en", `Asia AI generative film festival competition open call ${year}`),
        query("asia-support", "regional", "asia", "en", `Asia filmmaker grant lab fellowship open applications ${year}`),
        query("asia-ja", "regional", "asia", "ja", `日本 映画祭 短編映画 募集 助成金 ${year}`),
        query("asia-ko", "regional", "asia", "ko", `한국 영화제 단편영화 출품 제작지원 ${year}`),
        query("asia-zh", "regional", "asia", "zh", `亚洲 电影节 短片 征集 创作基金 ${year}`),
      ],
      [
        query("me-film", "regional", "middle-east", "en", `Middle East film festival grant lab open submissions ${year}`),
        query("me-gulf", "regional", "middle-east", "en", `Gulf UAE filmmaker fund competition open call ${year}`),
        query("me-ar-festival", "regional", "middle-east", "ar", `مهرجان أفلام دعوة لتقديم الأفلام ${year}`),
        query("me-ar-fund", "regional", "middle-east", "ar", `منحة إنتاج سينمائي طلبات التقديم ${year}`),
      ],
      [
        query("oc-short", "regional", "oceania", "en", `Australia New Zealand short film festival submissions ${year} ${nextYear}`),
        query("oc-support", "regional", "oceania", "en", `Oceania filmmaker grant residency lab open applications ${year}`),
        query("oc-animation", "regional", "oceania", "en", `Australia animation music video competition open entries ${year}`),
        query("oc-branded", "regional", "oceania", "en", `Australia New Zealand branded film creator challenge ${year}`),
      ],
      [
        query("latam-es-fund", "regional", "latin-america", "es", `fondo audiovisual convocatoria cineastas México Centroamérica ${year}`),
        query("latam-es-festival", "regional", "latin-america", "es", `festival cine convocatoria cortometrajes inscripciones Latinoamérica ${year}`),
        query("latam-pt-fund", "regional", "latin-america", "pt", `edital audiovisual fomento cinema inscrições Brasil ${year}`),
        query("latam-lab", "regional", "latin-america", "es", `laboratorio residencia beca cine convocatoria Latinoamérica ${year}`),
      ],
    ],
  };
}

function utcDaySlot(now) {
  const date = now instanceof Date ? now : new Date(now);
  return Math.floor(date.getTime() / 86_400_000);
}

function rotateOne(pool, slot, offset) {
  return pool[(slot + offset) % pool.length];
}

function rotateTwo(pool, slot, offset) {
  const first = (slot * 2 + offset) % pool.length;
  return [pool[first], pool[(first + 1) % pool.length]];
}

function rotateItems(items, slot) {
  if (!items.length) return [];
  const offset = ((slot % items.length) + items.length) % items.length;
  return [...items.slice(offset), ...items.slice(0, offset)];
}

function balancedOrder(global, categories, regions) {
  const ordered = [...global];
  const max = Math.max(categories.length, regions.length);
  for (let index = 0; index < max; index += 1) {
    if (categories[index]) ordered.push(categories[index]);
    if (regions[index]) ordered.push(regions[index]);
  }
  return ordered;
}

export function buildDiscoveryQueryCatalog(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  const pools = poolsForYear(date.getUTCFullYear());
  return [
    ...pools.global,
    ...pools.categories.flat(),
    ...pools.regions.flat(),
  ];
}

export function buildDiscoveryQueries(now = new Date()) {
  return buildDiscoveryQueryCatalog(now).map((item) => item.text);
}

export function selectDiscoveryQueryDescriptors(limit, now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  const pools = poolsForYear(date.getUTCFullYear());
  const slot = utcDaySlot(date);
  const categories = pools.categories.map((pool, index) =>
    rotateOne(pool, slot, index),
  );
  const regionPairs = pools.regions.map((pool, index) =>
    rotateTwo(pool, slot, index),
  );
  // Full runs still contain every family and both regional slots. Reduced
  // budget modes rotate the leading families/regions instead of permanently
  // dropping the same blind spots at the end of the list.
  const rotatedCategories = rotateItems(categories, slot);
  const rotatedRegionPairs = rotateItems(regionPairs, slot);
  const regions = [
    ...rotatedRegionPairs.map((pair) => pair[0]),
    ...rotatedRegionPairs.map((pair) => pair[1]),
  ];
  const plan = balancedOrder(pools.global, rotatedCategories, regions);
  const requested = Math.max(0, Math.min(24, Math.trunc(Number(limit) || 0)));
  return plan.slice(0, requested);
}

export function selectDiscoveryQueries(limit, now = new Date()) {
  return selectDiscoveryQueryDescriptors(limit, now).map((item) => item.text);
}

function attemptSummary(attempts) {
  const byQuery = new Map();
  for (const attempt of attempts ?? []) {
    const id = attempt.query_id ?? attempt.queryId;
    if (!id) continue;
    const current = byQuery.get(id) ?? {
      runs: 0,
      candidates: 0,
      validated: 0,
      newSources: 0,
      costEur: 0,
    };
    current.runs += 1;
    current.candidates += Number(attempt.candidate_count ?? attempt.candidates ?? 0);
    current.validated += Number(attempt.validated_count ?? attempt.validated ?? 0);
    current.newSources += Number(attempt.unique_source_count ?? attempt.new_source_count ?? attempt.new_sources ?? 0);
    current.costEur += Number(attempt.estimated_cost_eur ?? attempt.costEur ?? 0);
    byQuery.set(id, current);
  }
  return byQuery;
}

/**
 * Allocate most gap-search capacity to productive/weak segments while keeping
 * an exploration floor. Inputs contain aggregate economics only; benchmark
 * names and URLs are never accepted by this planner.
 */
export function selectAdaptiveDiscoveryQueryDescriptors(
  limit,
  attempts = [],
  { now = new Date(), gapWeights = {}, explorationShare = 0.2 } = {},
) {
  const requested = Math.max(0, Math.min(24, Math.trunc(Number(limit) || 0)));
  if (!requested) return [];
  const slot = utcDaySlot(now);
  const summaries = attemptSummary(attempts);
  const catalog = buildDiscoveryQueryCatalog(now).map((item, index) => {
    const stats = summaries.get(item.id) ?? {
      runs: 0,
      candidates: 0,
      validated: 0,
      newSources: 0,
      costEur: 0,
    };
    const validationYield = stats.validated / Math.max(1, stats.candidates);
    const sourceYield = stats.newSources / Math.max(1, stats.runs);
    const costPenalty = stats.costEur / Math.max(1, stats.validated + stats.newSources);
    const gap = Number(gapWeights[item.family] ?? 0)
      + Number(gapWeights[item.region] ?? 0);
    const score = (item.priority === "high" ? 2 : 0)
      + validationYield * 5
      + sourceYield * 3
      + gap * 4
      + 2 / Math.sqrt(stats.runs + 1)
      - Math.min(4, costPenalty * 20)
      + (((slot + index * 17) % 101) / 10_000);
    return { item, stats, score };
  });
  const explorationCount = Math.min(
    requested,
    Math.max(1, Math.ceil(requested * Math.max(0.15, Math.min(0.5, explorationShare)))),
  );
  const explored = [...catalog]
    .sort((a, b) => a.stats.runs - b.stats.runs || b.score - a.score)
    .slice(0, explorationCount);
  const selected = new Map(explored.map((entry) => [entry.item.id, entry]));
  for (const entry of [...catalog].sort((a, b) => b.score - a.score)) {
    if (selected.size >= requested) break;
    selected.set(entry.item.id, entry);
  }
  return [...selected.values()].map((entry) => entry.item);
}

export const discoveryQueries = buildDiscoveryQueries();
