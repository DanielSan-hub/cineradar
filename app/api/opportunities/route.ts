import { NextRequest, NextResponse } from "next/server";

import { normalizeOpportunityQuery, parseBoundedInteger } from "@/lib/opportunity-pagination.mjs";
import {
  DEFAULT_OPPORTUNITIES_PAGE_SIZE,
  getOpportunitiesPage,
  MAX_OPPORTUNITIES_OFFSET,
  MAX_OPPORTUNITIES_PAGE_SIZE,
} from "@/lib/server/data";
import type {
  AiPolicy,
  OpportunityCategory,
  OpportunitySortMode,
} from "@/lib/types";

const categories = new Set<OpportunityCategory>([
  "AI film festival",
  "Traditional festival",
  "Platform challenge",
  "Grant",
  "Residency",
  "Advertising competition",
]);
const aiPolicies = new Set<AiPolicy>([
  "allowed",
  "required",
  "restricted",
  "unclear",
]);
const sortModes = new Set<OpportunitySortMode>([
  "urgent",
  "newest",
  "prize",
]);

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const limit = parseBoundedInteger(params.get("limit"), DEFAULT_OPPORTUNITIES_PAGE_SIZE, {
    min: 1,
    max: MAX_OPPORTUNITIES_PAGE_SIZE,
  });
  const offset = parseBoundedInteger(params.get("offset"), 0, {
    min: 0,
    max: MAX_OPPORTUNITIES_OFFSET,
  });
  if (limit === null || offset === null) {
    return NextResponse.json(
      { error: "limit and offset must be non-negative integers" },
      { status: 400 },
    );
  }

  const categoryValue = params.get("category") ?? "all";
  const aiPolicyValue = params.get("aiPolicy") ?? "all";
  const sortValue = params.get("sort") ?? "urgent";
  if (categoryValue !== "all" && !categories.has(categoryValue as OpportunityCategory)) {
    return NextResponse.json({ error: "Invalid category" }, { status: 400 });
  }
  if (aiPolicyValue !== "all" && !aiPolicies.has(aiPolicyValue as AiPolicy)) {
    return NextResponse.json({ error: "Invalid AI policy" }, { status: 400 });
  }
  if (!sortModes.has(sortValue as OpportunitySortMode)) {
    return NextResponse.json({ error: "Invalid sort mode" }, { status: 400 });
  }

  const result = await getOpportunitiesPage({
    limit,
    offset,
    query: normalizeOpportunityQuery(params.get("query")),
    category:
      categoryValue === "all"
        ? "all"
        : (categoryValue as OpportunityCategory),
    aiPolicy:
      aiPolicyValue === "all" ? "all" : (aiPolicyValue as AiPolicy),
    sort: sortValue as OpportunitySortMode,
  });
  return NextResponse.json(result, {
    headers: {
      "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
    },
  });
}
