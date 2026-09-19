// The plan catalog, modelled on Wegic's plans and credits (help.wegic.ai, "Plan
// and Credits", and wegic.ai/pricing). This is product configuration rather
// than user data, so it lives here and reaches the client through
// `billing.catalog`: nothing in `docs/` hardcodes a price, an allowance, or
// what a request costs. Stripe price ids attach to these entries when checkout
// is wired up.
import { v } from "convex/values";

export const planKey = v.union(v.literal("free"), v.literal("starter"), v.literal("premium"));
export type PlanKey = "free" | "starter" | "premium";

export type Plan = {
  key: PlanKey;
  name: string;
  tagline: string;
  // Cents per month, and cents per year when billed yearly; zero is free.
  monthlyPriceCents: number;
  yearlyPriceCents: number;
  // Credits granted each period. `null` means the plan is unlimited and no
  // request is ever held against a balance -- no plan in the catalog is, and
  // one should not be without a cap on what a period can cost to serve.
  monthlyCredits: number | null;
  // A one-time grant when the account first gets a plan.
  signupCredits: number;
  // How many sites the plan holds at once; null is unlimited.
  maxSites: number | null;
  // Whether the plan gets a public address at all. Free is for planning and
  // building a site; putting one on an address of its own, and pointing a
  // domain at that, start with the first paid plan.
  publicAddress: boolean;
  // Shown on the plan card; nothing enforces it yet.
  visitorsPerMonth: number | null;
  customDomains: boolean;
  removeBadge: boolean;
  codeDownload: boolean;
  // Whether extra credits can be bought inside a period.
  topUps: boolean;
  // Extra selling points for the card, in the order they are shown.
  features: string[];
};

export const PLANS: readonly Plan[] = [
  {
    key: "free",
    name: "Free",
    tagline: "Explore Forge and plan your site.",
    monthlyPriceCents: 0,
    yearlyPriceCents: 0,
    // A small monthly allowance so planning a site out loud keeps working past
    // the first period, and a welcome grant that together with it opens at less
    // than a build costs. Free buys conversation, never a build.
    monthlyCredits: 10,
    signupCredits: 20,
    maxSites: 1,
    visitorsPerMonth: null,
    publicAddress: false,
    customDomains: false,
    removeBadge: false,
    codeDownload: false,
    topUps: false,
    features: ["Mobile-optimized", "Forge badge on your site"],
  },
  {
    key: "starter",
    name: "Starter",
    tagline: "Build and publish real sites every month.",
    monthlyPriceCents: 3990,
    yearlyPriceCents: 28680,
    monthlyCredits: 600,
    signupCredits: 0,
    maxSites: 15,
    visitorsPerMonth: 10000,
    publicAddress: true,
    customDomains: false,
    removeBadge: true,
    codeDownload: true,
    topUps: false,
    features: [
      "Basic custom design",
      "AI-generated images",
      "Mobile-optimized",
      "Priority support",
    ],
  },
  {
    key: "premium",
    name: "Premium",
    tagline: "Your own domain, unlimited sites, and analytics.",
    monthlyPriceCents: 6990,
    yearlyPriceCents: 50280,
    // An allowance rather than `null`: unlimited credits mean unlimited
    // provider spend against a fixed monthly price, which the deployment pays
    // for. Sites and visitors stay uncapped; the model calls do not.
    monthlyCredits: 2000,
    signupCredits: 0,
    maxSites: null,
    visitorsPerMonth: null,
    publicAddress: true,
    customDomains: true,
    removeBadge: true,
    codeDownload: true,
    topUps: true,
    features: [
      "Unlimited pages and visitors",
      "SSL certificate",
      "Google Analytics",
      "AI-generated images",
      "Priority support",
    ],
  },
];

export type TopUp = { key: string; credits: number; priceCents: number };

// Extra credits bought inside a period, on plans that allow it. They expire
// with the period, like the monthly allowance does. Wegic does not publish its
// pack prices; these are ours until it does.
export const TOP_UPS: readonly TopUp[] = [
  { key: "topup-100", credits: 100, priceCents: 990 },
  { key: "topup-300", credits: 300, priceCents: 2490 },
  { key: "topup-1000", credits: 1000, priceCents: 6990 },
];

// What each kind of AI request holds when it starts. Wegic prices a complete
// site build at 40 credits and describes edits as cheaper and media as dearer
// without numbers, so the rest are Forge's own until it publishes them.
// The generation pipeline reserves by kind and settles with what the request
// actually cost, never more than the hold: a prompt that turns out to be a
// question rather than a build holds the build cost and settles at `chat`.
// `chat` is not free because it is still a provider call, but it is a fortieth
// of a build, so planning a site out loud is not what spends an allowance.
export const REQUEST_COSTS = {
  chat: 1,
  generate: 40,
  edit: 8,
  image: 15,
  video: 40,
} as const;
export type RequestKind = keyof typeof REQUEST_COSTS;
export const requestKind = v.union(
  v.literal("chat"),
  v.literal("generate"),
  v.literal("edit"),
  v.literal("image"),
  v.literal("video"),
);
export const REQUEST_LABELS: Record<RequestKind, string> = {
  chat: "Chat",
  generate: "Site build",
  edit: "Edit",
  image: "Image",
  video: "Video",
};

export function planFor(key: string): Plan {
  return PLANS.find((plan) => plan.key === key) ?? PLANS[0];
}

// The catalog runs cheapest first, so the last plan is the top tier: what an
// admin account is held on, and what "everything included" means here.
export function topPlan(): Plan {
  return PLANS[PLANS.length - 1];
}

export function topUpFor(key: string): TopUp | null {
  return TOP_UPS.find((pack) => pack.key === key) ?? null;
}
