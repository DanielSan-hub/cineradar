import { NextRequest, NextResponse } from "next/server";

import { upsertOpportunities } from "@/lib/server/data";

export async function POST(request: NextRequest) {
  const expected = process.env.INGEST_SECRET;
  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!expected || provided !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!Array.isArray(body) || body.length === 0 || body.length > 250) {
    return NextResponse.json(
      { error: "Expected an array of 1–250 opportunities" },
      { status: 400 },
    );
  }
  try {
    const records = await upsertOpportunities(body as Record<string, unknown>[]);
    return NextResponse.json({ accepted: records.length, records });
  } catch (error) {
    console.error("Ingest failed", error);
    return NextResponse.json({ error: "Ingest unavailable" }, { status: 503 });
  }
}
