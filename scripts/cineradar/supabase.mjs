import { config, requireEnv } from "./config.mjs";
import { fetchWithTimeout } from "./http.mjs";

function headers(prefer) {
  const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    ...(prefer ? { Prefer: prefer } : {}),
  };
}

export async function supabase(path, init = {}) {
  const base = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  const response = await fetchWithTimeout(`${base}/rest/v1/${path}`, {
    ...init,
    headers: { ...headers(init.prefer), ...(init.headers ?? {}) },
  });
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${await response.text()}`);
  if (response.status === 204) return null;
  return response.json();
}

export async function startRun(kind) {
  const [run] = await supabase("pipeline_runs", {
    method: "POST",
    prefer: "return=representation",
    body: JSON.stringify({ kind, status: "running" }),
  });
  return run;
}

export async function finishRun(id, values) {
  return supabase(`pipeline_runs?id=eq.${id}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: JSON.stringify({ ...values, finished_at: new Date().toISOString() }),
  });
}

export async function ingest(records) {
  if (!records.length) return [];
  if (config.ingestUrl && config.ingestSecret) {
    const response = await fetchWithTimeout(config.ingestUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.ingestSecret}`, "Content-Type": "application/json" },
      body: JSON.stringify(records),
    });
    if (!response.ok) throw new Error(`CineRadar ingest ${response.status}: ${await response.text()}`);
    return response.json();
  }
  return supabase("opportunities?on_conflict=source_url", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=representation",
    body: JSON.stringify(records),
  });
}
