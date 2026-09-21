// The plan catalog, modelled on Wegic's plans and credits (help.wegic.ai, "Plan
// and Credits", and wegic.ai/pricing). This is product configuration rather
// than user data, so it lives here and reaches the client through
// `billing.catalog`: nothing in `docs/` hardcodes a price, an allowance, or
// what a request costs. Stripe price ids attach to these entries when checkout
// is wired up.
import { v } from "convex/values";

export const planKey = v.union(
  v.literal("free"),
  v.literal("starter"),
  v.literal("pro"),
  v.literal("ultra"),
);
export type PlanKey = "free" | "starter" | "pro" | "ultra";

// Rows and Stripe metadata written when the paid tier was called Premium still
// say `premium`. The schema accepts that key so those documents stay valid;
// every reader maps it to `pro`, and every writer stores `pro`.
export const storedPlanKey = v.union(planKey, v.literal("premium"));
export type StoredPlanKey = PlanKey | "premium";
export const incomingPlanKey = storedPlanKey;

export const PAID_PLAN_KEYS = ["starter", "pro", "ultra"] as const;
export type PaidPlanKey = (typeof PAID_PLAN_KEYS)[number];

// How a purchase divides. Half of what Stripe collects pays the providers for
// that member's work and Forge keeps the other half. It is applied to the
// money actually received, so a promotion code or a proration splits the same
// way a full-price month does.
export const API_SHARE = 0.5;

// The two halves of a payment, in whole cents. The remainder goes to Forge, so
// an odd amount never loses a cent to rounding.
export function splitPayment(paidCents: number) {
  const paid = Math.max(0, Math.round(paidCents));
  const apiCents = Math.round(paid * API_SHARE);
  return { paidCents: paid, apiCents, forgeCents: paid - apiCents };
}

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
  // Whether the plan gets a public address at all. Unpaid accounts cannot
  // publish; putting a site on an address of its own starts with Starter.
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

// Unpaid is not a product. Existing rows, a cancelled card, and a member who
// has not checked out yet still store `free` so the schema stays valid. The
// catalog never lists it.
export const UNPAID: Plan = {
  key: "free",
  name: "Unpaid",
  tagline: "Choose a plan to build.",
  monthlyPriceCents: 0,
  yearlyPriceCents: 0,
  monthlyCredits: 10,
  signupCredits: 20,
  maxSites: 1,
  visitorsPerMonth: null,
  publicAddress: false,
  customDomains: false,
  removeBadge: false,
  codeDownload: false,
  topUps: false,
  features: [],
};

export const PLANS: readonly Plan[] = [
  {
    key: "starter",
    name: "Starter",
    tagline: "Build and publish real sites every month.",
    monthlyPriceCents: 6000,
    yearlyPriceCents: 43200,
    monthlyCredits: 2500,
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
    key: "pro",
    name: "Pro",
    tagline: "Your own domain, unlimited sites, and analytics.",
    monthlyPriceCents: 10000,
    yearlyPriceCents: 72000,
    // An allowance rather than `null`: unlimited credits mean unlimited
    // provider spend against a fixed monthly price, which the deployment pays
    // for. Sites and visitors stay uncapped; the model calls do not.
    monthlyCredits: 5000,
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
  {
    key: "ultra",
    name: "Ultra",
    tagline: "Every entitlement, and the largest monthly allowance.",
    monthlyPriceCents: 20000,
    yearlyPriceCents: 144000,
    monthlyCredits: 12000,
    signupCredits: 0,
    maxSites: null,
    visitorsPerMonth: null,
    publicAddress: true,
    customDomains: true,
    removeBadge: true,
    codeDownload: true,
    topUps: true,
    features: [
      "Everything in Pro",
      "12,000 credits every month",
      "Unlimited pages and visitors",
      "Custom domains and SSL",
      "Google Analytics",
      "Priority support",
    ],
  },
];

export type TopUp = { key: string; credits: number; priceCents: number };

// Whether extra credits are on sale. They are off unless the deployment says
// otherwise: the packs stay in the plan sheet, greyed out, so a member can see
// what is coming back and at what price, and checkout refuses them so nothing
// can be bought by calling the API directly. `npx convex env set TOP_UPS_OPEN
// true` puts them back on sale without a code change.
export function topUpsOpen() {
  return process.env.TOP_UPS_OPEN === "true";
}

// Extra credits bought inside a period, on plans that allow it. They expire
// with the period, like the monthly allowance does. $30 per 1,000 through
// 5,000 is 3¢ a credit — above Starter (2.4¢) and Pro (2¢). The 10,000 pack
// is a volume break at 2¢, the same unit rate as Pro's included allowance.
export const TOP_UPS: readonly TopUp[] = [
  { key: "topup-1000", credits: 1000, priceCents: 3000 },
  { key: "topup-2000", credits: 2000, priceCents: 6000 },
  { key: "topup-3000", credits: 3000, priceCents: 9000 },
  { key: "topup-4000", credits: 4000, priceCents: 12000 },
  { key: "topup-5000", credits: 5000, priceCents: 15000 },
  { key: "topup-10000", credits: 10000, priceCents: 20000 },
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

// Premium was renamed to Pro. Stored rows and Stripe metadata still say
// `premium`; treat that as Pro and write `pro` from here on.
export function normalizePlanKey(key: string): PlanKey {
  if (key === "premium") return "pro";
  if (key === "free" || key === "starter" || key === "pro" || key === "ultra") return key;
  return "free";
}

// A paid plan from checkout metadata or a grant. Unknown and Free are refused.
export function paidPlanKey(key: string): PaidPlanKey | null {
  if (key === "premium") return "pro";
  if (key === "starter" || key === "pro" || key === "ultra") return key;
  return null;
}

export function planFor(key: string): Plan {
  const normalized = normalizePlanKey(key);
  if (normalized === "free") return UNPAID;
  return PLANS.find((plan) => plan.key === normalized) ?? UNPAID;
}

// The catalog runs cheapest first, so the last plan is the top tier: what an
// admin account is held on, and what "everything included" means here.
export function topPlan(): Plan {
  return PLANS[PLANS.length - 1];
}

export function topUpFor(key: string): TopUp | null {
  return TOP_UPS.find((pack) => pack.key === key) ?? null;
}
