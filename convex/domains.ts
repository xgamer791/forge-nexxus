import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { requireOwnedDomain, requireOwnedSite } from "./access";
import { currentPlan } from "./billing";
import { PLANS } from "./plans";
import { siteHostFor, sitesDomain } from "./sites";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type QueryCtx,
} from "./_generated/server";

// Labels of letters, digits and inner hyphens, then a real top-level domain.
const HOSTNAME = /^(?=.{1,253}$)((?!-)[a-z0-9-]{1,63}(?<!-)\.)+[a-z]{2,63}$/;

// What a user pastes is often a URL; keep just the host they meant.
export function normalizeHostname(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .split(/[/?#]/)[0]
    .replace(/:\d+$/, "")
    .replace(/\.$/, "");
}

// One record, the way Wegic asks for it: point the host at the site's own
// address. A name with a single label left of the domain is a subdomain and
// takes a plain CNAME; a bare domain needs whatever its registrar calls a
// CNAME at the root (ALIAS or ANAME), because a root CNAME is not allowed.
export function dnsRecordFor(hostname: string, target: string | null) {
  const labels = hostname.split(".");
  const root = labels.length <= 2;
  return {
    type: root ? "ALIAS" : "CNAME",
    name: root ? "@" : labels[0],
    value: target,
    root,
  };
}

// The host a domain has to resolve to, which is the site's own address.
async function targetFor(ctx: QueryCtx, domain: Doc<"domains">) {
  const site = await ctx.db.get(domain.siteId);
  return site?.slug ? siteHostFor(site.slug) : null;
}

function presentable(domain: Doc<"domains">, target: string | null) {
  const { userId: _owner, ...rest } = domain;
  return { ...rest, target, record: dnsRecordFor(domain.hostname, target) };
}

export const list = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const domains = await ctx.db
      .query("domains")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    return await Promise.all(
      domains.map(async (domain) => presentable(domain, await targetFor(ctx, domain))),
    );
  },
});

export const add = mutation({
  args: { siteId: v.id("sites"), hostname: v.string() },
  handler: async (ctx, { siteId, hostname }) => {
    const site = await requireOwnedSite(ctx, siteId);
    const plan = await currentPlan(ctx, site.userId);
    if (!plan.customDomains) {
      const needed = PLANS.find((candidate) => candidate.customDomains)?.name ?? "Pro";
      throw new ConvexError(`Custom domains come with the ${needed} plan`);
    }
    const host = normalizeHostname(hostname);
    if (!HOSTNAME.test(host)) throw new ConvexError("Enter a domain like example.com");
    const domain = sitesDomain();
    if (domain && (host === domain || host.endsWith(`.${domain}`))) {
      throw new ConvexError(`Every site already has an address on ${domain}`);
    }
    const existing = await ctx.db
      .query("domains")
      .withIndex("by_hostname", (q) => q.eq("hostname", host))
      .first();
    if (existing) {
      throw new ConvexError(
        existing.userId === site.userId
          ? "That domain is already added"
          : "That domain is pointed at another account",
      );
    }
    return await ctx.db.insert("domains", {
      userId: site.userId,
      siteId,
      hostname: host,
      status: "pending",
      createdAt: Date.now(),
    });
  },
});

export const remove = mutation({
  args: { id: v.id("domains") },
  handler: async (ctx, { id }) => {
    await requireOwnedDomain(ctx, id);
    await ctx.db.delete(id);
  },
});

// What the check needs to know, and what it writes back. Both are internal:
// the action in between is the only thing that calls them.
export const forCheck = internalQuery({
  args: { id: v.id("domains") },
  handler: async (ctx, { id }) => {
    const domain = await requireOwnedDomain(ctx, id);
    return { hostname: domain.hostname, target: await targetFor(ctx, domain) };
  },
});

export const recordCheck = internalMutation({
  args: {
    id: v.id("domains"),
    status: v.union(v.literal("pending"), v.literal("active"), v.literal("failed")),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { id, status, note }) => {
    const domain = await requireOwnedDomain(ctx, id);
    const now = Date.now();
    await ctx.db.patch(domain._id, {
      status,
      note,
      checkedAt: now,
      verifiedAt: status === "active" ? now : domain.verifiedAt,
    });
  },
});

// A DNS answer, over HTTPS, from the resolver Google runs. Only CNAME chains
// matter: the record we ask for is the record we told them to add.
async function resolveCname(hostname: string) {
  const url = new URL("https://dns.google/resolve");
  url.searchParams.set("name", hostname);
  url.searchParams.set("type", "CNAME");
  const response = await fetch(url, { headers: { accept: "application/dns-json" } });
  if (!response.ok) throw new Error(`Lookup failed (${response.status})`);
  const answer = (await response.json()) as {
    Answer?: Array<{ type: number; data: string }>;
  };
  return (answer.Answer ?? [])
    .filter((record) => record.type === 5)
    .map((record) => record.data.trim().toLowerCase().replace(/\.$/, ""));
}

// Verification is one button: look the domain up, and say plainly what is
// there if it is not us yet. Nothing here can be trusted to a client, so the
// status is written by an internal mutation the user cannot call.
export const verify = action({
  args: { id: v.id("domains") },
  handler: async (ctx, { id }): Promise<{ status: string; note: string }> => {
    const { hostname, target } = await ctx.runQuery(internal.domains.forCheck, { id });
    if (!target) {
      const note = "Give the site an address first, then point this domain at it.";
      await ctx.runMutation(internal.domains.recordCheck, { id, status: "pending", note });
      return { status: "pending", note };
    }
    let found: string[];
    try {
      found = await resolveCname(hostname);
    } catch {
      const note = "Could not reach DNS just now. Try again in a moment.";
      await ctx.runMutation(internal.domains.recordCheck, { id, status: "pending", note });
      return { status: "pending", note };
    }
    if (found.includes(target)) {
      const note = `${hostname} points at ${target}.`;
      await ctx.runMutation(internal.domains.recordCheck, { id, status: "active", note });
      return { status: "active", note };
    }
    const record = dnsRecordFor(hostname, target);
    const note = found.length
      ? `${hostname} points at ${found[0]}. Change that record to ${target}.`
      : `No ${record.type} record yet. Add ${record.name} → ${target} at your registrar; it can take a few minutes.`;
    await ctx.runMutation(internal.domains.recordCheck, { id, status: "pending", note });
    return { status: "pending", note };
  },
});
