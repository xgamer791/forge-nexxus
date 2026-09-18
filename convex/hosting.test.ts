/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { brandedHostFor, isReservedHost, sitesDomain, slugFromHost } from "./hosting";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");
const fresh = () => convexTest(schema, modules);

const APEX = "sites.forgenexxus.com";
const PAGE =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Shop</title></head><body><h1>Shop</h1></body></html>';

function deployment(apex: string | null = APEX) {
  if (apex === null) delete process.env.SITES_DOMAIN;
  else process.env.SITES_DOMAIN = apex;
  process.env.CONVEX_SITE_URL = "https://test.convex.site";
}

afterEach(() => {
  delete process.env.SITES_DOMAIN;
  delete process.env.CONVEX_SITE_URL;
});

async function createUser(
  t: ReturnType<typeof fresh>,
  fields: { isAnonymous?: boolean; email?: string },
) {
  const { userId, sessionId } = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", fields);
    const sessionId = await ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 60_000,
    });
    return { userId, sessionId };
  });
  return { userId, as: t.withIdentity({ subject: `${userId}|${sessionId}` }) };
}

// A site with one build on it, ready to publish.
async function build(t: ReturnType<typeof fresh>, siteId: Id<"sites">, html = PAGE) {
  return await t.run(async (ctx) => {
    const site = (await ctx.db.get(siteId))!;
    const versionId = await ctx.db.insert("siteVersions", {
      userId: site.userId,
      siteId,
      html,
      summary: "Built",
      requestKind: "generate",
      createdAt: Date.now(),
    });
    await ctx.db.patch(siteId, { currentVersionId: versionId });
    return versionId;
  });
}

describe("branded addresses", () => {
  test("an apex is used only when the deployment names a real one", () => {
    deployment(null);
    expect(sitesDomain()).toBe(null);
    expect(brandedHostFor("shop")).toBe(null);
    expect(slugFromHost("shop.sites.forgenexxus.com")).toBe(null);
    for (const bad of ["", "   ", "not-a-domain", "."]) {
      deployment(bad);
      expect(sitesDomain()).toBe(null);
    }
    // A pasted URL or a stray trailing dot still names the apex it meant.
    deployment("HTTPS://Sites.ForgeNexxus.com/");
    expect(sitesDomain()).toBe(APEX);
    expect(brandedHostFor("shop")).toBe(`shop.${APEX}`);
  });

  test("a branded host names one site, and only at its own label", () => {
    deployment();
    expect(slugFromHost(`bakery-on-main.${APEX}`)).toBe("bakery-on-main");
    // The apex itself is nobody's site, and a nested label is nobody's either.
    expect(slugFromHost(APEX)).toBe(null);
    expect(slugFromHost(`a.b.${APEX}`)).toBe(null);
    expect(slugFromHost("shop.example.com")).toBe(null);
    expect(slugFromHost(`shop.${APEX}.evil.com`)).toBe(null);
  });

  test("Forge's own addresses are not a member's to claim", () => {
    deployment();
    expect(isReservedHost(APEX)).toBe(true);
    expect(isReservedHost(`shop.${APEX}`)).toBe(true);
    expect(isReservedHost("forgenexxus.com")).toBe(false);
    expect(isReservedHost("test.convex.site")).toBe(true);
    expect(isReservedHost("anything.convex.cloud")).toBe(true);
    expect(isReservedHost("shop.example.com")).toBe(false);
  });

  test("publishing hands out the branded address once there is an apex", async () => {
    deployment();
    const t = fresh();
    const member = await createUser(t, { email: "m@example.com" });
    const { siteId } = await member.as.mutation(api.sites.create, { name: "Bakery on Main" });
    await build(t, siteId);
    expect(await member.as.mutation(api.sites.publish, { id: siteId })).toEqual({
      slug: "bakery-on-main",
      url: `https://bakery-on-main.${APEX}`,
    });
    const [site] = await member.as.query(api.sites.list, {});
    expect(site.publishedUrl).toBe(`https://bakery-on-main.${APEX}`);
    // The path address keeps working, so a link given out earlier never dies.
    expect((await t.fetch("/sites/bakery-on-main")).status).toBe(200);
  });

  test("the branded host serves the published build and nothing else", async () => {
    deployment();
    const t = fresh();
    const member = await createUser(t, { email: "m@example.com" });
    await t.mutation(internal.billing.grantPlan, { userId: member.userId, plan: "starter" });
    const { siteId } = await member.as.mutation(api.sites.create, { name: "Shop" });
    await build(t, siteId);
    // A draft answers nowhere, even on its own address.
    expect(await t.query(internal.sites.hostedHtml, { host: `shop.${APEX}` })).toBe(null);
    await member.as.mutation(api.sites.publish, { id: siteId });
    expect(await t.query(internal.sites.hostedHtml, { host: `shop.${APEX}` })).toEqual({
      html: PAGE,
      domainId: null,
    });
    // A browser's port, a resolver's trailing dot and shouting all name it too.
    for (const host of [`shop.${APEX}:443`, `shop.${APEX}.`, `SHOP.${APEX}`]) {
      expect(await t.query(internal.sites.hostedHtml, { host })).toMatchObject({ html: PAGE });
    }
    for (const host of ["", APEX, `nobody.${APEX}`, `a.shop.${APEX}`, "shop.example.com"]) {
      expect(await t.query(internal.sites.hostedHtml, { host })).toBe(null);
    }
    await member.as.mutation(api.sites.unpublish, { id: siteId });
    expect(await t.query(internal.sites.hostedHtml, { host: `shop.${APEX}` })).toBe(null);
  });

  test("the hosting query tells the client where sites are served from", async () => {
    deployment();
    expect(await fresh().query(api.sites.hosting, {})).toEqual({
      sitesDomain: APEX,
      dnsTarget: "test.convex.site",
    });
    deployment(null);
    expect(await fresh().query(api.sites.hosting, {})).toEqual({
      sitesDomain: null,
      dnsTarget: "test.convex.site",
    });
  });
});

describe("custom domains", () => {
  async function premiumWithSite(t: ReturnType<typeof fresh>, email: string) {
    const member = await createUser(t, { email });
    await t.mutation(internal.billing.grantPlan, { userId: member.userId, plan: "premium" });
    const { siteId } = await member.as.mutation(api.sites.create, { name: "Shop" });
    await build(t, siteId);
    await member.as.mutation(api.sites.publish, { id: siteId });
    return { ...member, siteId };
  }

  test("a domain serves its site, and serving it is what makes it active", async () => {
    deployment();
    const t = fresh();
    const member = await premiumWithSite(t, "m@example.com");
    const id = await member.as.mutation(api.domains.add, {
      siteId: member.siteId,
      hostname: "www.my-shop.example",
    });
    expect(await member.as.query(api.domains.list, {})).toMatchObject([{ status: "pending" }]);
    // A pending domain still answers: it is the request arriving that proves
    // the record is in place, so it has to be served before it can be active.
    const hosted = await t.query(internal.sites.hostedHtml, { host: "www.my-shop.example" });
    expect(hosted).toEqual({ html: PAGE, domainId: id });
    await t.mutation(internal.domains.markVerified, { id });
    const [domain] = await member.as.query(api.domains.list, {});
    expect(domain.status).toBe("active");
    expect(domain.verifiedAt).toEqual(expect.any(Number));
    // Marking it again leaves the moment it first answered alone.
    await t.mutation(internal.domains.markVerified, { id });
    expect((await member.as.query(api.domains.list, {}))[0].verifiedAt).toBe(domain.verifiedAt);
    // And an address already answering asks for no further write per page view.
    expect(await t.query(internal.sites.hostedHtml, { host: "www.my-shop.example" })).toEqual({
      html: PAGE,
      domainId: null,
    });
  });

  test("a domain stops answering when the plan no longer includes one", async () => {
    deployment();
    const t = fresh();
    const member = await premiumWithSite(t, "m@example.com");
    await member.as.mutation(api.domains.add, {
      siteId: member.siteId,
      hostname: "shop.example",
    });
    expect(await t.query(internal.sites.hostedHtml, { host: "shop.example" })).toMatchObject({
      html: PAGE,
    });
    await t.mutation(internal.billing.grantPlan, { userId: member.userId, plan: "starter" });
    expect(await t.query(internal.sites.hostedHtml, { host: "shop.example" })).toBe(null);
    // It is kept rather than dropped, so upgrading brings the address back.
    expect(await member.as.query(api.domains.list, {})).toHaveLength(1);
    await t.mutation(internal.billing.grantPlan, { userId: member.userId, plan: "premium" });
    expect(await t.query(internal.sites.hostedHtml, { host: "shop.example" })).toMatchObject({
      html: PAGE,
    });
  });

  test("a hostname belongs to one site across the whole deployment", async () => {
    deployment();
    const t = fresh();
    const alice = await premiumWithSite(t, "a@example.com");
    const bob = await premiumWithSite(t, "b@example.com");
    await alice.as.mutation(api.domains.add, { siteId: alice.siteId, hostname: "shop.example" });
    await expect(
      bob.as.mutation(api.domains.add, { siteId: bob.siteId, hostname: "https://shop.example/x" }),
    ).rejects.toThrow("already pointed at another Forge site");
    await expect(
      alice.as.mutation(api.domains.add, { siteId: alice.siteId, hostname: "shop.example" }),
    ).rejects.toThrow("already added");
    expect(await bob.as.query(api.domains.list, {})).toEqual([]);
  });

  test("Forge's own addresses cannot be claimed as a custom domain", async () => {
    deployment();
    const t = fresh();
    const member = await premiumWithSite(t, "m@example.com");
    for (const host of [APEX, `someone-else.${APEX}`, "test.convex.site", "x.convex.cloud"]) {
      await expect(
        member.as.mutation(api.domains.add, { siteId: member.siteId, hostname: host }),
      ).rejects.toThrow("Forge's own");
    }
    expect(await member.as.query(api.domains.list, {})).toEqual([]);
  });

  test("a domain whose site was deleted serves nothing", async () => {
    deployment();
    const t = fresh();
    const member = await premiumWithSite(t, "m@example.com");
    await member.as.mutation(api.domains.add, { siteId: member.siteId, hostname: "shop.example" });
    await member.as.mutation(api.sites.remove, { id: member.siteId });
    expect(await t.query(internal.sites.hostedHtml, { host: "shop.example" })).toBe(null);
  });
});
