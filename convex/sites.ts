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
const SLUG_MIN = 3;

// Addresses a visitor would read as ours rather than someone's site, and the
// labels hosting needs for itself.
const RESERVED_SLUGS = new Set([
  "admin", "api", "app", "assets", "auth", "billing", "blog", "cdn", "dashboard",
  "dns", "docs", "forge", "ftp", "help", "host", "mail", "nexxus", "ns", "ns1",
  "ns2", "preview", "root", "sites", "smtp", "static", "status", "support",
  "system", "test", "webmail", "www",
]);

export function cleanSiteName(name: string | undefined) {
  const trimmed = (name ?? "").replace(/\s+/g, " ").trim();
  return (trimmed || DEFAULT_NAME).slice(0, NAME_LIMIT);
}

// Every site gets a name of its own under one domain: `<slug>.sites.forgenexxus.com`.
// `SITES_DOMAIN` names it so a deployment can host somewhere else; emptying it
// falls back to the deployment's own origin, which is all a test has.
export function sitesDomain() {
  const configured = process.env.SITES_DOMAIN ?? "sites.forgenexxus.com";
  return configured.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
}

// The host a site answers on, and what a custom domain is pointed at.
export function siteHostFor(slug: string) {
  const domain = sitesDomain();
  return domain ? `${slug}.${domain}` : null;
}

// Where a published site lives. Null when there is neither a sites domain nor
// a deployment origin to fall back on, which only happens in tests.
export function publishedUrlFor(slug: string) {
  const host = siteHostFor(slug);
  if (host) return `https://${host}`;
  const origin = process.env.CONVEX_SITE_URL?.replace(/\/+$/, "");
  return origin ? `${origin}/sites/${slug}` : null;
}

// What a chosen address has to be before anyone can be sent to it.
export function slugProblem(slug: string) {
  if (slug.length < SLUG_MIN) return `An address needs at least ${SLUG_MIN} characters`;
  if (slug.length > SLUG_LIMIT) return `An address can be at most ${SLUG_LIMIT} characters`;
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug)) {
    return "Use letters, numbers and hyphens, starting and ending with a letter or number";
  }
  if (RESERVED_SLUGS.has(slug)) return "That address is reserved";
  return null;
}

function present(site: Doc<"sites">) {
  const { userId: _owner, ...rest } = site;
  return {
    ...rest,
    // The address the site would answer on, chosen or assigned, whether or not
    // it is published; `publishedUrl` is only there once it is live.
    address: site.slug ? publishedUrlFor(site.slug) : null,
    host: site.slug ? siteHostFor(site.slug) : null,
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

// Where this deployment puts sites, and what a custom domain is pointed at.
// Hosting configuration rather than user data, so `docs/` carries no domain of
// its own and a deployment can be moved by setting one variable.
export const hosting = query({
  args: {},
  handler: async () => {
    const domain = sitesDomain();
    return { domain, minLength: SLUG_MIN, maxLength: SLUG_LIMIT };
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

// The address is the user's to choose, not just whatever the name made. Taking
// one holds it for this site until they change it, published or not, and a
// published site moves to the new address as soon as it is saved.
export const setSlug = mutation({
  args: { id: v.id("sites"), slug: v.string() },
  handler: async (ctx, { id, slug }) => {
    const site = await requireOwnedSite(ctx, id);
    await requireMemberId(ctx);
    const wanted = slugify(slug);
    const problem = slugProblem(wanted);
    if (problem) throw new ConvexError(problem);
    if (wanted !== site.slug) {
      const taken = await ctx.db
        .query("sites")
        .withIndex("by_slug", (q) => q.eq("slug", wanted))
        .first();
      if (taken) throw new ConvexError("That address is taken. Try another one.");
      await ctx.db.patch(id, { slug: wanted, updatedAt: Date.now() });
    }
    return { slug: wanted, host: siteHostFor(wanted), url: publishedUrlFor(wanted) };
  },
});

// Whether an address can be taken, for the field to answer as it is typed.
export const slugAvailable = query({
  args: { slug: v.string(), siteId: v.optional(v.id("sites")) },
  handler: async (ctx, { slug, siteId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const wanted = slugify(slug);
    const problem = slugProblem(wanted);
    if (problem) return { slug: wanted, available: false, problem };
    const taken = await ctx.db
      .query("sites")
      .withIndex("by_slug", (q) => q.eq("slug", wanted))
      .first();
    const mine = taken !== null && siteId !== undefined && taken._id === siteId;
    return {
      slug: wanted,
      available: taken === null || mine,
      problem: taken === null || mine ? null : "That address is taken. Try another one.",
      host: siteHostFor(wanted),
    };
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

// The page a published site is currently serving, or null while it is a draft
// or its published build has gone.
async function livePage(ctx: QueryCtx, site: Doc<"sites"> | null) {
  if (!site || site.status !== "published" || !site.publishedVersionId) return null;
  const version = await ctx.db.get(site.publishedVersionId);
  return version ? await renderedHtml(ctx, site, version.html) : null;
}

// What the public route serves. Null for a draft, an unknown slug, or a site
// whose published build has gone.
export const publishedHtml = internalQuery({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const site = await ctx.db
      .query("sites")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .first();
    return await livePage(ctx, site);
  },
});

// The same page, found by the host the visitor typed: a site's own
// `<slug>.sites.forgenexxus.com`, or a custom domain pointed at it. A domain
// that resolves here is served whether or not verification has caught up —
// DNS arriving is the proof — but it still has to belong to a published site.
export const publishedHtmlForHost = internalQuery({
  args: { host: v.string() },
  handler: async (ctx, { host }) => {
    const hostname = host.trim().toLowerCase().split(":")[0].replace(/\.$/, "");
    if (!hostname) return null;
    const domain = sitesDomain();
    if (domain && hostname.endsWith(`.${domain}`)) {
      const slug = hostname.slice(0, hostname.length - domain.length - 1);
      if (!slug || slug.includes(".")) return null;
      const site = await ctx.db
        .query("sites")
        .withIndex("by_slug", (q) => q.eq("slug", slug))
        .first();
      return await livePage(ctx, site);
    }
    const mapped = await ctx.db
      .query("domains")
      .withIndex("by_hostname", (q) => q.eq("hostname", hostname))
      .first();
    if (!mapped || mapped.status === "failed") return null;
    return await livePage(ctx, await ctx.db.get(mapped.siteId));
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
