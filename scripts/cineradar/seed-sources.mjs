import { sourceCatalog } from "./source-catalog.mjs";
import { supabase } from "./supabase.mjs";

const result = await supabase("sources?on_conflict=url", {
  method: "POST",
  prefer: "resolution=merge-duplicates,return=representation",
  body: JSON.stringify(sourceCatalog),
});

const retiredSourceUrls = [
  "https://runwayml.com/news",
  "https://ars.electronica.art",
];
for (const url of retiredSourceUrls) {
  await supabase(`sources?url=eq.${encodeURIComponent(url)}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: JSON.stringify({ enabled: false }),
  });
}

console.log(JSON.stringify({
  seeded: result.length,
  total_seed_catalog: sourceCatalog.length,
  retired_duplicates: retiredSourceUrls.length,
}));
