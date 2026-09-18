// The plan catalog. This is product configuration rather than user data, so it
// lives here and reaches the client through `billing.catalog`: nothing in
// `docs/` hardcodes a price, an allowance, or what a request costs. Stripe
// price ids attach to these entries when checkout is wired up.
import { v } from "convex/values";

export const planKey = v.union(
  v.literal("free"),
  v.literal("starter"),
  v.literal("pro"),
  v.literal("business"),
);
export type PlanKey = "free" | "starter" | "pro" | "business";

export type Plan = {
  key: PlanKey;
  name: string;
  tagline: string;
  // Cents per month; zero is the free plan.
  monthlyPriceCents: number;
  monthlyCredits: number;
  // How many sites the plan holds at once; null is unlimited.
  maxSites: number | null;
  customDomains: boolean;
  removeBadge: boolean;
};

export const PLANS: readonly Plan[] = [
  {
    key: "free",
    name: "Free",
    tagline: "Build your first site and see how Forge works.",
    monthlyPriceCents: 0,
    monthlyCredits: 20,
    maxSites: 3,
    customDomains: false,
    removeBadge: false,
  },
  {
    key: "starter",
    name: "Starter",
    tagline: "For a personal site or a small business.",
    monthlyPriceCents: 1900,
    monthlyCredits: 100,
    maxSites: 10,
    customDomains: true,
    removeBadge: false,
  },
  {
    key: "pro",
    name: "Pro",
    tagline: "For people who ship a new site every week.",
    monthlyPriceCents: 4900,
    monthlyCredits: 300,
    maxSites: null,
    customDomains: true,
    removeBadge: true,
  },
  {
    key: "business",
    name: "Business",
    tagline: "For agencies and teams building for clients.",
    monthlyPriceCents: 9900,
    monthlyCredits: 800,
    maxSites: null,
    customDomains: true,
    removeBadge: true,
  },
];

export type TopUp = { key: string; credits: number; priceCents: number };

// Extra credits bought inside a period. They expire with the period, like the
// monthly allowance does.
export const TOP_UPS: readonly TopUp[] = [
  { key: "topup-50", credits: 50, priceCents: 1000 },
  { key: "topup-150", credits: 150, priceCents: 2500 },
  { key: "topup-400", credits: 400, priceCents: 6000 },
];

// What each kind of AI request holds when it starts. The generation pipeline
// reserves by kind and settles with what the request actually cost, never more
// than the hold.
export const REQUEST_COSTS = {
  generate: 5,
  edit: 1,
  image: 2,
  video: 10,
} as const;
export type RequestKind = keyof typeof REQUEST_COSTS;
export const requestKind = v.union(
  v.literal("generate"),
  v.literal("edit"),
  v.literal("image"),
  v.literal("video"),
);
export const REQUEST_LABELS: Record<RequestKind, string> = {
  generate: "Site generation",
  edit: "Edit",
  image: "Image",
  video: "Video",
};

export function planFor(key: string): Plan {
  return PLANS.find((plan) => plan.key === key) ?? PLANS[0];
}

export function topUpFor(key: string): TopUp | null {
  return TOP_UPS.find((pack) => pack.key === key) ?? null;
}
