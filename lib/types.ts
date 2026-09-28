export type OpportunityStatus =
  | "signal"
  | "discovered"
  | "verified"
  | "open"
  | "closing-soon"
  | "closed";

export type OpportunityCategory =
  | "AI film festival"
  | "Traditional festival"
  | "Platform challenge"
  | "Grant"
  | "Residency"
  | "Advertising competition";

export type ReviewDecision = "pending" | "approved" | "rejected" | "archived";
export type ReviewView = "pending" | "approved" | "rejected";

export type AiPolicy = "allowed" | "required" | "restricted" | "unclear";
export type OpportunitySortMode = "urgent" | "newest" | "prize";
export type DeadlineStatus = "confirmed" | "estimated" | "unknown" | "rolling";

export type UrlVerificationStatus =
  | "verified"
  | "redirected"
  | "invalid"
  | "unreachable"
  | "unchecked";

export type Opportunity = {
  id: string;
  slug: string;
  title: string;
  organizer: string;
  category: OpportunityCategory;
  status: OpportunityStatus;
  aiPolicy: AiPolicy;
  deadline: string | null;
  deadlineStatus?: DeadlineStatus;
  deadlineSourceUrl?: string | null;
  deadlineLastVerifiedAt?: string | null;
  opensAt: string | null;
  prizeAmount: number | null;
  prizeCurrency: "EUR" | "USD" | "GBP" | null;
  entryFeeAmount: number | null;
  entryFeeCurrency: "EUR" | "USD" | "GBP" | null;
  location: string;
  remote: boolean;
  maxRuntimeMinutes: number | null;
  sourceUrl: string | null;
  officialUrl: string | null;
  applicationUrl?: string | null;
  sourceUrlStatus?: UrlVerificationStatus;
  officialUrlStatus?: UrlVerificationStatus;
  applicationUrlStatus?: UrlVerificationStatus;
  sourceUrlHttpStatus?: number | null;
  officialUrlHttpStatus?: number | null;
  applicationUrlHttpStatus?: number | null;
  sourceUrlLastCheckedAt?: string | null;
  officialUrlLastCheckedAt?: string | null;
  applicationUrlLastCheckedAt?: string | null;
  sourceUrlVerified?: boolean;
  officialUrlVerified?: boolean;
  applicationUrlVerified?: boolean;
  sourceType: "official" | "press" | "social" | "community";
  confidence: number;
  summary: string;
  eligibility: string[];
  formats: string[];
  tags: string[];
  discoveredAt: string;
  verifiedAt: string | null;
  reviewRequired?: boolean;
  reviewDecision?: ReviewDecision;
  reviewReason?: string | null;
  updatedAt?: string | null;
  hasConflict?: boolean;
  previousStatus?: OpportunityStatus | null;
  previousDeadline?: string | null;
  featured?: boolean;
  demo?: boolean;
};

export type PipelineHealth = {
  lastDiscoveryAt: string | null;
  lastMonitorAt: string | null;
  sourcesTracked: number;
  leadsPending: number;
  recordsOpen: number;
  demoMode: boolean;
};

export type OpportunitiesPage = {
  opportunities: Opportunity[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  demoMode: boolean;
  error?: string;
};

export type OpportunityPageOptions = {
  limit?: number;
  offset?: number;
  query?: string;
  category?: OpportunityCategory | "all";
  aiPolicy?: AiPolicy | "all";
  sort?: OpportunitySortMode;
};
