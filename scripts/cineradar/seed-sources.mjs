import { supabase } from "./supabase.mjs";

const sources = [
  ["Runway News", "https://runwayml.com/news", 1],
  ["Higgsfield", "https://higgsfield.ai", 1],
  ["Luma AI", "https://lumalabs.ai/news", 1],
  ["FilmFreeway", "https://filmfreeway.com/festivals", 2],
  ["Ars Electronica", "https://ars.electronica.art", 2],
  ["Sundance Institute", "https://www.sundance.org/festivals/sundance-film-festival/submit/", 2],
].map(([name, url, tier]) => ({ name, url, tier, enabled: true, source_type: "official" }));

const result = await supabase("sources?on_conflict=url", {
  method: "POST",
  prefer: "resolution=merge-duplicates,return=representation",
  body: JSON.stringify(sources),
});

console.log(JSON.stringify({ seeded: result.length }));
