import { config, discoveryQueries, requireEnv } from "./config.mjs";
import { mapPool, fetchWithTimeout } from "./http.mjs";
import { extractOpportunity } from "./llm.mjs";
import { finishRun, ingest, startRun } from "./supabase.mjs";

requireEnv("EXA_API_KEY");
const run = await startRun("discovery");
let candidates = 0;
let written = 0;

try {
  const queries = discoveryQueries.slice(0, config.discoveryQueryLimit);
  const batches = await mapPool(queries, 6, async (query) => {
    const response = await fetchWithTimeout("https://api.exa.ai/search", {
      method: "POST",
      headers: { "x-api-key": config.exaApiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        type: "auto",
        numResults: config.discoveryResultLimit,
        startPublishedDate: new Date(Date.now() - 120 * 86_400_000).toISOString(),
        contents: { text: { maxCharacters: 18000 }, highlights: { numSentences: 8 } },
      }),
    });
    if (!response.ok) throw new Error(`Exa ${response.status}: ${await response.text()}`);
    const body = await response.json();
    return body.results ?? [];
  });

  const unique = new Map();
  for (const result of batches.flat()) {
    if (result?.url && !unique.has(result.url)) unique.set(result.url, result);
  }
  const pages = [...unique.values()].slice(0, config.maxLlmCalls);
  candidates = pages.length;

  const extracted = await mapPool(pages, 5, async (result) => {
    try {
      return await extractOpportunity({
        url: result.url,
        title: result.title,
        text: result.text ?? result.highlights?.join("\n") ?? "",
      });
    } catch (error) {
      console.warn(`Skipped ${result.url}: ${error.message}`);
      return null;
    }
  });
  const records = extracted.filter(Boolean);
  await ingest(records);
  written = records.length;
  await finishRun(run.id, { status: "succeeded", candidates, records_written: written });
  console.log(JSON.stringify({ status: "succeeded", candidates, written }));
} catch (error) {
  await finishRun(run.id, { status: "failed", candidates, records_written: written, error: String(error.message).slice(0, 1000) });
  throw error;
}
