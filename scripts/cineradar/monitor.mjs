import { createHash } from "node:crypto";
import { config } from "./config.mjs";
import { fetchWithTimeout, mapPool } from "./http.mjs";
import { extractOpportunity } from "./llm.mjs";
import { finishRun, ingest, startRun, supabase } from "./supabase.mjs";

function plainText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

const run = await startRun("monitor");
let candidates = 0;
let written = 0;

try {
  const sources = await supabase("sources?select=*&enabled=eq.true&order=tier.asc&limit=2000");
  const changed = (await mapPool(sources, 20, async (source) => {
    try {
      const response = await fetchWithTimeout(source.url, {
        headers: { "User-Agent": "CineRadarBot/1.0 (+https://cineradar.example)" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const html = await response.text();
      const text = plainText(html).slice(0, 24000);
      const hash = createHash("sha256").update(text).digest("hex");
      const now = new Date().toISOString();
      await supabase(`sources?id=eq.${source.id}`, {
        method: "PATCH",
        prefer: "return=minimal",
        body: JSON.stringify({
          last_hash: hash,
          last_checked_at: now,
          last_changed_at: hash !== source.last_hash ? now : source.last_changed_at,
          consecutive_failures: 0,
        }),
      });
      return hash !== source.last_hash ? { ...source, text } : null;
    } catch (error) {
      console.warn(`Monitor failed for ${source.url}: ${error.message}`);
      await supabase(`sources?id=eq.${source.id}`, {
        method: "PATCH",
        prefer: "return=minimal",
        body: JSON.stringify({
          last_checked_at: new Date().toISOString(),
          consecutive_failures: Number(source.consecutive_failures ?? 0) + 1,
        }),
      });
      return null;
    }
  })).filter(Boolean);

  const limited = changed.slice(0, config.maxLlmCalls);
  candidates = limited.length;
  const extracted = await mapPool(limited, 5, async (source) => {
    try {
      return await extractOpportunity({ url: source.url, title: source.name, text: source.text });
    } catch (error) {
      console.warn(`Extraction skipped for ${source.url}: ${error.message}`);
      return null;
    }
  });
  const records = extracted.filter(Boolean);
  await ingest(records);
  written = records.length;
  await finishRun(run.id, { status: "succeeded", candidates, records_written: written });
  console.log(JSON.stringify({ status: "succeeded", checked: sources.length, changed: candidates, written }));
} catch (error) {
  await finishRun(run.id, { status: "failed", candidates, records_written: written, error: String(error.message).slice(0, 1000) });
  throw error;
}
