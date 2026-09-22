import { getChatGPTUser } from "@/app/chatgpt-auth";
import { RadarApp } from "@/components/cineradar/radar-app";
import {
  DEFAULT_OPPORTUNITIES_PAGE_SIZE,
  getOpportunitiesPage,
  getPipelineHealth,
} from "@/lib/server/data";

export const dynamic = "force-dynamic";

export default async function Home() {
  const [page, health, user] = await Promise.all([
    getOpportunitiesPage({
      limit: DEFAULT_OPPORTUNITIES_PAGE_SIZE,
      offset: 0,
    }),
    getPipelineHealth(),
    getChatGPTUser(),
  ]);

  return (
    <RadarApp
      initialOpportunities={page.opportunities}
      initialTotal={page.total}
      initialLimit={page.limit}
      initialHasMore={page.hasMore}
      initialError={page.error ?? null}
      health={{ ...health, demoMode: page.demoMode }}
      user={user ? { displayName: user.displayName, email: user.email } : null}
    />
  );
}
