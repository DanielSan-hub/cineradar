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

export type AiPolicy = "allowed" | "required" | "restricted" | "unclear";

export type Opportunity = {
  id: string;
  slug: string;
  title: string;
  organizer: string;
  category: OpportunityCategory;
  status: OpportunityStatus;
  aiPolicy: AiPolicy;
  deadline: string | null;
  opensAt: string | null;
  prizeAmount: number | null;
  prizeCurrency: "EUR" | "USD" | "GBP" | null;
  entryFeeAmount: number | null;
  entryFeeCurrency: "EUR" | "USD" | "GBP" | null;
  location: string;
  remote: boolean;
  maxRuntimeMinutes: number | null;
  sourceUrl: string;
  officialUrl: string | null;
  sourceType: "official" | "press" | "social" | "community";
  confidence: number;
  summary: string;
  eligibility: string[];
  formats: string[];
  tags: string[];
  discoveredAt: string;
  verifiedAt: string | null;
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
