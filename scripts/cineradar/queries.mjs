function buildDiscoveryQueriesForYear(year) {
  const nextYear = year + 1;
  return [
    // Stable anchors: the Athens case and a broad global control query run every cycle.
    `Athens Greece film festival open call submissions ${year} ${nextYear} official`,
    `international film festival open submissions filmmakers ${year} ${nextYear} official`,

    `Athens International Film Festival submissions call for entries official`,
    `Athens International Digital Film Festival submissions official`,
    `Athens Digital Arts Festival open call moving image animation official`,
    `AI Filmfest Athens submissions official`,
    `Αθήνα φεστιβάλ κινηματογράφου υποβολή ταινιών ανοιχτή πρόσκληση ${year}`,
    `Ελλάδα φεστιβάλ ταινιών διαγωνισμός υποβολές ${year} ${nextYear}`,

    `traditional film festival call for entries ${year} ${nextYear}`,
    `international short film festival submissions ${year} ${nextYear}`,
    `animation festival film submissions ${year} ${nextYear}`,
    `experimental film festival moving image open call ${year}`,
    `new media digital art festival video art open call ${year}`,
    `documentary film festival call for entries ${year} ${nextYear}`,
    `screenplay competition open submissions international ${year}`,
    `music video competition awards open entries ${year}`,
    `branded content advertising film competition entries ${year}`,
    `exhibition open call moving image video art ${year}`,

    `AI film festival call for entries ${year} ${nextYear}`,
    `generative AI film competition open submissions cash prize`,
    `AI video competition creator challenge open worldwide`,
    `AI assisted films accepted festival submissions`,
    `university creative AI film competition open call`,
    `audiovisual generative AI hackathon challenge filmmakers`,
    `Runway AI film competition challenge official`,
    `Higgsfield film competition challenge official`,
    `Kling AI video competition challenge official`,
    `Google Veo creative film competition challenge official`,
    `Adobe video competition open call filmmakers official`,

    `film grant open applications international filmmakers ${year} ${nextYear}`,
    `short film production grant open call ${year}`,
    `artist grant moving image digital art open applications`,
    `filmmaker residency open applications international ${year}`,
    `artist residency moving image machine learning open call`,
    `film lab open applications emerging filmmakers ${year}`,
    `screenwriting lab fellowship open applications ${year}`,
    `creative technology storytelling fellowship open call`,
    `cinema innovation fund filmmakers open call`,

    `Europe film festival submissions open ${year} ${nextYear}`,
    `Italy film festival concorso bando cortometraggi ${year}`,
    `France festival cinéma appel à films candidatures ${year}`,
    `Germany Filmfestival Einreichung Wettbewerb Kurzfilm ${year}`,
    `Spain festival cine convocatoria cortometrajes ${year}`,
    `UK film festival open submissions grant filmmakers ${year}`,
    `Netherlands film festival moving image open call ${year}`,
    `Switzerland Austria film festival call for entries ${year}`,
    `Nordic film festival grant residency open call ${year}`,
    `Canada film festival filmmaker grant submissions ${year}`,
    `USA film festival labs grants submissions ${year}`,
    `Latin America festival cine convocatoria cortometraje ${year}`,
    `Brasil festival cinema inscrições edital curta metragem ${year}`,
    `Africa film festival filmmaker grant open submissions ${year}`,
    `Middle East film festival open call filmmakers ${year}`,
    `UAE film competition grant open submissions ${year}`,
    `India film festival short film competition submissions ${year}`,
    `Singapore film festival media arts open call ${year}`,
    `Australia film festival filmmaker grant open call ${year}`,
    `New Zealand film festival short film submissions ${year}`,
    `日本 映画祭 短編映画 募集 ${year}`,
    `韓国 영화제 단편영화 출품 공모 ${year}`,
    `中国 电影节 短片 征集 报名 ${year}`,

    `site:filmfreeway.com festival AI film submissions ${year}`,
    `site:festhome.com film festival submissions ${year}`,
    `site:shortfilmdepot.com festival call for films ${year}`,
    `site:reddit.com filmmaker grant festival open call ${year}`,
  ];
}

export function buildDiscoveryQueries(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  return buildDiscoveryQueriesForYear(date.getUTCFullYear());
}

export const discoveryQueries = buildDiscoveryQueries();

export function selectDiscoveryQueries(
  limit,
  now = new Date(),
  catalog = buildDiscoveryQueries(now),
) {
  const requested = Math.max(0, Math.min(catalog.length, Number(limit) || 0));
  if (!requested) return [];
  const anchors = catalog.slice(0, Math.min(2, requested));
  if (anchors.length === requested) return anchors;

  const rotating = catalog.slice(2);
  const date = now instanceof Date ? now : new Date(now);
  const halfDaySlot = Math.floor(date.getTime() / (12 * 60 * 60 * 1000));
  const offset = ((halfDaySlot * 17) % rotating.length + rotating.length) % rotating.length;
  const selected = [...anchors];
  for (let index = 0; selected.length < requested; index += 1) {
    selected.push(rotating[(offset + index) % rotating.length]);
  }
  return selected;
}
