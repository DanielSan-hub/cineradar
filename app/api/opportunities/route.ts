import { NextResponse } from "next/server";

import { getOpportunities } from "@/lib/server/data";

export async function GET() {
  const result = await getOpportunities();
  return NextResponse.json(result, {
    headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" },
  });
}
