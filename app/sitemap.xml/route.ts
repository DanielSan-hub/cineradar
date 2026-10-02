import { getPublicOpportunitySlugs } from "@/lib/server/data";

const SITE_URL = "https://cineradar.danielmaker.chatgpt.site";

function escapeXml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function GET() {
  const entries = await getPublicOpportunitySlugs().catch(() => []);
  const urls = [
    `<url><loc>${SITE_URL}/</loc><changefreq>daily</changefreq></url>`,
    ...entries.map((entry) => {
      const lastmod = entry.updatedAt ? `<lastmod>${escapeXml(entry.updatedAt.slice(0, 10))}</lastmod>` : "";
      return `<url><loc>${SITE_URL}/o/${escapeXml(encodeURIComponent(entry.slug))}</loc>${lastmod}</url>`;
    }),
  ];
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join("")}</urlset>\n`;
  return new Response(body, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
