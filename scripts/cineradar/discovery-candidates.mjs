import { canonicalizeUrl } from "./web-validation.mjs";

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "invalid";
  }
}

export function admitDiscoveryCandidates(
  batches,
  { limit, perHostLimit = 3, observedAt = new Date().toISOString() },
) {
  const admitted = new Map();
  const hostCounts = new Map();
  const maxRank = Math.max(0, ...batches.map((batch) => batch.results?.length ?? 0));
  for (let rank = 0; rank < maxRank; rank += 1) {
    for (const batch of batches) {
      const result = batch.results?.[rank];
      if (!result) continue;
      const url = canonicalizeUrl(result.url);
      if (!url) continue;
      const hit = {
        provider: "exa",
        queryId: batch.query.id,
        queryText: batch.query.text,
        sourceId: null,
        sourceUrl: url,
        resultRank: rank,
        observedAt,
        metadata: {
          family: batch.query.family,
          region: batch.query.region,
          language: batch.query.language,
        },
      };
      const existing = admitted.get(url);
      if (existing) {
        existing.provenance.push(hit);
        continue;
      }
      if (admitted.size >= limit) continue;
      const host = hostOf(url);
      const hostCount = hostCounts.get(host) ?? 0;
      if (hostCount >= perHostLimit) continue;
      hostCounts.set(host, hostCount + 1);
      admitted.set(url, {
        ...result,
        url,
        provenance: [hit],
      });
    }
  }
  return [...admitted.values()];
}
