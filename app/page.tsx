import { getChatGPTUser } from "@/app/chatgpt-auth";
import { RadarApp } from "@/components/cineradar/radar-app";
import { getOpportunities, getPipelineHealth } from "@/lib/server/data";

export const dynamic = "force-dynamic";

export default async function Home() {
  const [{ opportunities, demoMode }, health, user] = await Promise.all([
    getOpportunities(),
    getPipelineHealth(),
    getChatGPTUser(),
  ]);

  return (
    <RadarApp
      initialOpportunities={opportunities}
      health={{ ...health, demoMode }}
      user={user ? { displayName: user.displayName, email: user.email } : null}
    />
  );
}
