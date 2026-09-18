import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { requireMemberId, requireOwnedSite } from "./access";
import { currentPlan } from "./billing";
import { deleteConversation } from "./conversations";
import type { Doc, Id } from "./_generated/dataModel";
import { internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";

// Sites on a plan without `removeBadge` carry a small Forge credit. It goes
// into the page as served, never into the stored version, so upgrading takes
// it off every build at once. Inline styles are what the public route's
// policy allows.
export const BADGE_TEXT = "Built with Forge";
function withBadge(html: string) {
  const href = process.env.SITE_URL?.replace(/\/+$/, "") ?? "#";
  const badge =
    `<a href="${href}/" rel="noopener" style="position:fixed;right:12px;bottom:12px;z-index:2147483647;padding:6px 11px;border-radius:999px;background:#121315;color:#e9ebee;font:600 12px/16px -apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;text-decoration:none;box-shadow:0 2px 8px rgba(0,0,0,.3)">${BADGE_TEXT}</a>`;
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${badge}</body>`) : html + badge;
}

// The page as a visitor sees it: the version's HTML, plus the badge unless the
// owner's plan removes it.
export async function renderedHtml(
  ctx: QueryCtx | MutationCtx,
  site: Doc<"sites">,
  html: string,
) {
  const plan = await currentPlan(ctx, site.userId);
  return plan.removeBadge ? html : withBadge(html);
}

const DEFAULT_NAME = "Untitled site";
const NAME_LIMIT = 80;
const SLUG_LIMIT = 40;

export function cleanSiteName(name: string | undefined) {
  const trimmed = (name ?? "").replace(/\s+/g, " ").trim();
  return (trimmed || DEFAULT_NAME).slice(0, NAME_LIMIT);
}

// Where a published site lives: the deployment's own origin. Null when the
// deployment has not told us its address, which only happens in tests.
export function publishedUrlFor(slug: string) {
  const origin = process.env.CONVEX_SITE_URL?.replace(/\/+$/, "");
  return origin ? `${origin}/sites/${slug}` : null;
}

function present(site: Doc<"sites">) {
  const { userId: _owner, ...rest } = site;
  return {
    ...rest,
    publishedUrl: site.status === "published" && site.slug ? publishedUrlFor(site.slug) : null,
  };
}

// Most recently edited first, which is how the drawer lists them.
export const list = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const sites = await ctx.db
      .query("sites")
      .withIndex("by_user_updated", (q) => q.eq("userId", userId))
      .order("desc")
      .collect();
    return sites.map(present);
  },
});

// The latest build of a site, for the preview. Null rather than an error for
// anyone but the owner, since this backs a subscription.
export const currentHtml = query({
  args: { siteId: v.id("sites") },
  handler: async (ctx, { siteId }) => {
    const userId = await getAuthUserId(ctx);
    const site = await ctx.db.get(siteId);
    if (!userId || !site || site.userId !== userId || !site.currentVersionId) return null;
    const version = await ctx.db.get(site.currentVersionId);
    if (!version) return null;
    return {
      versionId: version._id,
      html: await renderedHtml(ctx, site, version.html),
      summary: version.summary,
      createdAt: version.createdAt,
      published: site.publishedVersionId === version._id,
    };
  },
});

// A site and its build thread are made together. Only members build, and a
// plan caps how many sites it holds.
export const create = mutation({
  args: { name: v.optional(v.string()) },
  handler: async (ctx, { name }) => {
    const userId = await requireMemberId(ctx);
    const plan = await currentPlan(ctx, userId);
    if (plan.maxSites !== null) {
      const owned = await ctx.db
        .query("sites")
        .withIndex("by_user_updated", (q) => q.eq("userId", userId))
        .collect();
      if (owned.length >= plan.maxSites) {
        throw new ConvexError(
          `The ${plan.name} plan holds ${plan.maxSites} sites. Upgrade to add more.`,
        );
      }
    }
    const now = Date.now();
    const title = cleanSiteName(name);
    const conversationId = await ctx.db.insert("conversations", { userId, title, updatedAt: now });
    const siteId = await ctx.db.insert("sites", {
      userId,
      conversationId,
      name: title,
      status: "draft",
      createdAt: now,
      updatedAt: now,
    });
    return { siteId, conversationId };
  },
});

export const rename = mutation({
  args: { id: v.id("sites"), name: v.string() },
  handler: async (ctx, { id, name }) => {
    const site = await requireOwnedSite(ctx, id);
    const title = cleanSiteName(name);
    await ctx.db.patch(id, { name: title });
    await ctx.db.patch(site.conversationId, { title });
  },
});

export const remove = mutation({
  args: { id: v.id("sites") },
  handler: async (ctx, { id }) => {
    const site = await requireOwnedSite(ctx, id);
    await deleteConversation(ctx, site.conversationId);
  },
});

// Puts the latest build on the site's public address. The slug is chosen once,
// from the name, and kept through unpublishing so links keep working.
export const publish = mutation({
  args: { id: v.id("sites") },
  handler: async (ctx, { id }) => {
    const site = await requireOwnedSite(ctx, id);
    await requireMemberId(ctx);
    if (!site.currentVersionId) throw new ConvexError("Build the site before publishing it");
    const slug = site.slug ?? (await uniqueSlug(ctx, site.name));
    const now = Date.now();
    await ctx.db.patch(id, {
      status: "published",
      slug,
      publishedVersionId: site.currentVersionId,
      publishedAt: now,
      updatedAt: now,
    });
    return { slug, url: publishedUrlFor(slug) };
  },
});

export const unpublish = mutation({
  args: { id: v.id("sites") },
  handler: async (ctx, { id }) => {
    await requireOwnedSite(ctx, id);
    await ctx.db.patch(id, { status: "draft", publishedVersionId: undefined, updatedAt: Date.now() });
  },
});

// What the public route serves. Null for a draft, an unknown slug, or a site
// whose published build has gone.
export const publishedHtml = internalQuery({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const site = await ctx.db
      .query("sites")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .first();
    if (!site || site.status !== "published" || !site.publishedVersionId) return null;
    const version = await ctx.db.get(site.publishedVersionId);
    return version ? await renderedHtml(ctx, site, version.html) : null;
  },
});

export function slugify(name: string) {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_LIMIT)
    .replace(/-+$/, "");
}

async function uniqueSlug(ctx: QueryCtx | MutationCtx, name: string) {
  const base = slugify(name) || "site";
  const taken = async (slug: string) =>
    (await ctx.db.query("sites").withIndex("by_slug", (q) => q.eq("slug", slug)).first()) !== null;
  if (!(await taken(base))) return base;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = `${base}-${Math.random().toString(36).slice(2, 6)}`;
    if (!(await taken(candidate))) return candidate;
  }
  throw new ConvexError("Could not find a free address for this site");
}

// Sending a prompt is what makes a site recently edited.
export async function touchSite(
  ctx: MutationCtx,
  conversationId: Id<"conversations">,
  now: number,
) {
  const site = await ctx.db
    .query("sites")
    .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
    .first();
  if (site) await ctx.db.patch(site._id, { updatedAt: now });
}
