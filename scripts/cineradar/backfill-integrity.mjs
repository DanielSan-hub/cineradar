import { canonicalOpportunityKey } from "./normalization.mjs";
import { supportsIntegritySchema, supabase } from "./supabase.mjs";

async function main() {
  if (!await supportsIntegritySchema()) {
    throw new Error(
      "Integrity migration is not visible through PostgREST; apply 202609220001 first",
    );
  }

  const pageSize = 1000;
  const rows = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await supabase(
      `opportunities?select=id,title,organizer,location,deadline,edition_year,canonical_key,raw_payload&order=id.asc&limit=${pageSize}&offset=${offset}`,
    );
    rows.push(...page);
    if (page.length < pageSize) break;
  }

  let patched = 0;
  const failures = [];
  for (const row of rows.filter((item) => !item.canonical_key)) {
    const raw = row.raw_payload && typeof row.raw_payload === "object"
      ? row.raw_payload
      : {};
    const canonicalKey = canonicalOpportunityKey({
      title: row.title,
      canonical_name: raw.extraction?.canonical_name,
      organizer: row.organizer,
      location: row.location,
      deadline: row.deadline,
      opportunity_year: row.edition_year,
      edition: raw.normalization?.edition,
    });
    try {
      await supabase(`opportunities?id=eq.${encodeURIComponent(row.id)}`, {
        method: "PATCH",
        prefer: "return=minimal",
        body: JSON.stringify({ canonical_key: canonicalKey }),
      });
      patched += 1;
    } catch (error) {
      failures.push({ id: row.id, error: error.message.slice(0, 300) });
    }
  }

  const verified = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await supabase(
      `opportunities?select=id,canonical_key&order=id.asc&limit=${pageSize}&offset=${offset}`,
    );
    verified.push(...page);
    if (page.length < pageSize) break;
  }
  const nullKeys = verified.filter((row) => !row.canonical_key).map((row) => row.id);
  const counts = new Map();
  for (const row of verified) {
    if (!row.canonical_key) continue;
    counts.set(row.canonical_key, (counts.get(row.canonical_key) ?? 0) + 1);
  }
  const duplicateKeys = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([canonical_key, count]) => ({ canonical_key, count }));

  const report = {
    total: verified.length,
    patched,
    canonical_keys_present: verified.length - nullKeys.length,
    null_key_ids: nullKeys,
    duplicate_keys: duplicateKeys,
    failures,
  };
  console.log(JSON.stringify(report, null, 2));
  if (nullKeys.length || duplicateKeys.length || failures.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
