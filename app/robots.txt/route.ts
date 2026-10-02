const SITE_URL = "https://cineradar.danielmaker.chatgpt.site";

export function GET() {
  const body = [
    "User-agent: *",
    "Allow: /",
    "Disallow: /team",
    "Disallow: /api/",
    `Sitemap: ${SITE_URL}/sitemap.xml`,
    "",
  ].join("\n");
  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, s-maxage=86400" },
  });
}
