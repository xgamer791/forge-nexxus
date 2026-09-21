/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { planFor } from "./plans";
import { BADGE_TEXT, siteHostFor, slugProblem, slugify } from "./sites";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");
const fresh = () => convexTest(schema, modules);

// These tests are about host-based addresses, which only exist on a deployment
// that has a sites domain. There is no default for one: naming it is the last
// step of setting the domain up, so a deployment where nobody did the DNS
// serves sites from its own origin instead. See HOSTING.md.
beforeEach(() => {
  process.env.SITES_DOMAIN = "sites.forgenexxus.com";
});
afterEach(() => {
  delete process.env.SITES_DOMAIN;
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

describe("sites", () => {
  test("signed-out list is empty and guests cannot build", async () => {
    const t = fresh();
    expect(await t.query(api.sites.list, {})).toEqual([]);
    await expect(t.mutation(api.sites.create, {})).rejects.toThrow("Not signed in");
    const guest = await createUser(t, { isAnonymous: true });
    expect(await guest.as.query(api.sites.list, {})).toEqual([]);
    await expect(guest.as.mutation(api.sites.create, { name: "Mine" })).rejects.toThrow(
      "Sign in to build",
    );
  });

  test("a member creates a site with its build thread, renames it, and deletes both", async () => {
    const t = fresh();
    const member = await createUser(t, { email: "m@example.com" });
    const { siteId, conversationId } = await member.as.mutation(api.sites.create, {
      name: "  Bakery   site  ",
    });
    const [site] = await member.as.query(api.sites.list, {});
    expect(site).toMatchObject({ _id: siteId, conversationId, name: "Bakery site", status: "draft" });
    expect(site).not.toHaveProperty("userId");
    expect(await member.as.query(api.conversations.list, {})).toMatchObject([
      { _id: conversationId, title: "Bakery site" },
    ]);

    await member.as.mutation(api.messages.send, { conversationId, body: "Make it warm" });
    await member.as.mutation(api.sites.rename, { id: siteId, name: "   " });
    expect((await member.as.query(api.sites.list, {}))[0].name).toBe("Untitled site");
    expect((await member.as.query(api.conversations.list, {}))[0].title).toBe("Untitled site");

    await member.as.mutation(api.sites.remove, { id: siteId });
    expect(await member.as.query(api.sites.list, {})).toEqual([]);
    expect(await member.as.query(api.conversations.list, {})).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("messages").collect())).toEqual([]);
  });

  test("sending a prompt moves a site to the top of the list", async () => {
    const t = fresh();
    const member = await createUser(t, { email: "m@example.com" });
    await t.mutation(internal.billing.grantPlan, { userId: member.userId, plan: "starter" });
    const first = await member.as.mutation(api.sites.create, { name: "First" });
    const second = await member.as.mutation(api.sites.create, { name: "Second" });
    await t.run(async (ctx) => {
      await ctx.db.patch(first.siteId, { updatedAt: 1000 });
      await ctx.db.patch(second.siteId, { updatedAt: 2000 });
    });
    const names = async () => (await member.as.query(api.sites.list, {})).map((site) => site.name);
    expect(await names()).toEqual(["Second", "First"]);
    await member.as.mutation(api.messages.send, {
      conversationId: first.conversationId,
      body: "Hello",
    });
    expect(await names()).toEqual(["First", "Second"]);
  });

  test("the plan caps how many sites an account holds", async () => {
    const t = fresh();
    const member = await createUser(t, { email: "m@example.com" });
    const cap = planFor("free").maxSites!;
    for (let i = 0; i < cap; i += 1) {
      await member.as.mutation(api.sites.create, { name: `Site ${i}` });
    }
    await expect(member.as.mutation(api.sites.create, {})).rejects.toThrow(`holds ${cap} sites`);
    await t.mutation(internal.billing.grantPlan, { userId: member.userId, plan: "pro" });
    await member.as.mutation(api.sites.create, { name: "One more" });
    expect(await member.as.query(api.sites.list, {})).toHaveLength(cap + 1);
  });

  test("another account can neither see nor change a site", async () => {
    const t = fresh();
    const alice = await createUser(t, { email: "a@example.com" });
    const bob = await createUser(t, { email: "b@example.com" });
    const { siteId, conversationId } = await alice.as.mutation(api.sites.create, { name: "Alice's" });
    expect(await bob.as.query(api.sites.list, {})).toEqual([]);
    await expect(bob.as.mutation(api.sites.rename, { id: siteId, name: "Bob's" })).rejects.toThrow(
      "Site not found",
    );
    await expect(bob.as.mutation(api.sites.remove, { id: siteId })).rejects.toThrow("Site not found");
    await expect(
      bob.as.mutation(api.messages.send, { conversationId, body: "hi" }),
    ).rejects.toThrow("Conversation not found");
    expect(await alice.as.query(api.sites.list, {})).toHaveLength(1);
  });

  test("deleting a thread directly takes its site and domains with it", async () => {
    const t = fresh();
    const member = await createUser(t, { email: "m@example.com" });
    await t.mutation(internal.billing.grantPlan, { userId: member.userId, plan: "pro" });
    const { siteId, conversationId } = await member.as.mutation(api.sites.create, { name: "Shop" });
    await member.as.mutation(api.domains.add, { siteId, hostname: "shop.example" });
    await member.as.mutation(api.conversations.remove, { id: conversationId });
    expect(await member.as.query(api.sites.list, {})).toEqual([]);
    expect(await member.as.query(api.domains.list, {})).toEqual([]);
  });
});

describe("publishing", () => {
  const PAGE =
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Shop</title></head><body><h1>Shop</h1></body></html>';

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

  test("slugify keeps a readable, safe address", () => {
    expect(slugify("Bakery on Main!")).toBe("bakery-on-main");
    expect(slugify("  Café — Résumé  ")).toBe("cafe-resume");
    expect(slugify("!!!")).toBe("");
    expect(slugify("x".repeat(80)).length).toBe(40);
  });

  test("publishing puts the latest build on a stable address that the route serves", async () => {
    process.env.CONVEX_SITE_URL = "https://test.convex.site/";
    const t = fresh();
    const member = await createUser(t, { email: "m@example.com" });
    const { siteId } = await member.as.mutation(api.sites.create, { name: "Bakery on Main" });
    // Free is for planning and building: there is no address to publish to.
    await expect(member.as.mutation(api.sites.publish, { id: siteId })).rejects.toThrow(
      "A site address comes with the Starter plan",
    );
    await t.mutation(internal.billing.grantPlan, { userId: member.userId, plan: "starter" });
    await expect(member.as.mutation(api.sites.publish, { id: siteId })).rejects.toThrow(
      "Build the site before publishing",
    );
    const first = await build(t, siteId);
    const published = await member.as.mutation(api.sites.publish, { id: siteId });
    expect(published).toEqual({
      slug: "bakery-on-main",
      url: "https://bakery-on-main.sites.forgenexxus.com",
    });
    const [site] = await member.as.query(api.sites.list, {});
    expect(site).toMatchObject({
      status: "published",
      slug: "bakery-on-main",
      publishedVersionId: first,
      publishedUrl: "https://bakery-on-main.sites.forgenexxus.com",
      address: "https://bakery-on-main.sites.forgenexxus.com",
      host: "bakery-on-main.sites.forgenexxus.com",
    });
    expect((await member.as.query(api.sites.currentHtml, { siteId }))?.published).toBe(true);

    const served = await t.fetch("/sites/bakery-on-main");
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toContain("text/html");
    expect(served.headers.get("content-security-policy")).toContain("default-src 'none'");
    // Every plan that has an address also takes the badge off, so what is
    // served is the build itself.
    expect(await served.text()).toBe(PAGE);
    expect((await member.as.query(api.sites.currentHtml, { siteId }))?.html).toBe(PAGE);
    expect((await t.fetch("/sites/nobody-home")).status).toBe(404);

    // A newer draft build does not change what is served until published again.
    await build(t, siteId, PAGE.replace("Shop", "Shop v2"));
    expect(await (await t.fetch("/sites/bakery-on-main")).text()).toBe(PAGE);
    expect((await member.as.query(api.sites.currentHtml, { siteId }))?.published).toBe(false);
    await member.as.mutation(api.sites.publish, { id: siteId });
    expect(await (await t.fetch("/sites/bakery-on-main")).text()).toContain("Shop v2");

    await member.as.mutation(api.sites.unpublish, { id: siteId });
    expect((await t.fetch("/sites/bakery-on-main")).status).toBe(404);
    const [draft] = await member.as.query(api.sites.list, {});
    // The address is kept and still shown while the site is a draft; only the
    // live URL goes away.
    expect(draft).toMatchObject({
      status: "draft",
      slug: "bakery-on-main",
      publishedUrl: null,
      address: "https://bakery-on-main.sites.forgenexxus.com",
    });
    expect(await member.as.mutation(api.sites.publish, { id: siteId })).toMatchObject({ slug: "bakery-on-main" });
    delete process.env.CONVEX_SITE_URL;
  });

  test("a free plan's build carries the badge in the preview it does get", async () => {
    const t = fresh();
    const member = await createUser(t, { email: "m@example.com" });
    const { siteId } = await member.as.mutation(api.sites.create, { name: "Bakery" });
    await build(t, siteId);
    const badged = (await member.as.query(api.sites.currentHtml, { siteId }))!.html;
    expect(badged).toContain(BADGE_TEXT);
    expect(badged.endsWith("</body></html>")).toBe(true);
    expect(badged.replace(/<a href="[^"]*" rel="noopener" style="[^"]*">Built with Forge<\/a>/, "")).toBe(PAGE);
    // A plan with an address takes the badge off every build at once.
    await t.mutation(internal.billing.grantPlan, { userId: member.userId, plan: "starter" });
    expect((await member.as.query(api.sites.currentHtml, { siteId }))?.html).toBe(PAGE);
  });

  test("addresses are unique across accounts, and only the owner publishes", async () => {
    const t = fresh();
    const alice = await createUser(t, { email: "a@example.com" });
    const bob = await createUser(t, { email: "b@example.com" });
    await t.mutation(internal.billing.grantPlan, { userId: alice.userId, plan: "starter" });
    await t.mutation(internal.billing.grantPlan, { userId: bob.userId, plan: "starter" });
    const a = await alice.as.mutation(api.sites.create, { name: "Shop" });
    const b = await bob.as.mutation(api.sites.create, { name: "Shop" });
    await build(t, a.siteId);
    await build(t, b.siteId);
    const first = await alice.as.mutation(api.sites.publish, { id: a.siteId });
    const second = await bob.as.mutation(api.sites.publish, { id: b.siteId });
    expect(first.slug).toBe("shop");
    expect(second.slug).toMatch(/^shop-[a-z0-9]{4}$/);
    await expect(bob.as.mutation(api.sites.publish, { id: a.siteId })).rejects.toThrow("Site not found");
    await expect(bob.as.mutation(api.sites.unpublish, { id: a.siteId })).rejects.toThrow("Site not found");
    expect(await bob.as.query(api.sites.currentHtml, { siteId: a.siteId })).toBeNull();
    const guest = await createUser(t, { isAnonymous: true });
    expect(await guest.as.query(api.sites.currentHtml, { siteId: a.siteId })).toBeNull();
  });

  test("an address has to be usable before anyone can be sent to it", () => {
    expect(slugProblem("bakery-on-main")).toBeNull();
    expect(slugProblem("ab")).toContain("at least 3");
    expect(slugProblem("x".repeat(41))).toContain("at most 40");
    expect(slugProblem("-shop")).toContain("starting and ending");
    expect(slugProblem("shop-")).toContain("starting and ending");
    expect(slugProblem("www")).toBe("That address is reserved");
    expect(siteHostFor("bakery")).toBe("bakery.sites.forgenexxus.com");
  });

  test("a member chooses the address and can change it once", async () => {
    const t = fresh();
    const member = await createUser(t, { email: "m@example.com" });
    const other = await createUser(t, { email: "o@example.com" });
    const { siteId } = await member.as.mutation(api.sites.create, { name: "Bakery on Main" });
    // Choosing an address is the same entitlement as publishing to one.
    await expect(
      member.as.mutation(api.sites.setSlug, { id: siteId, slug: "The Bakery!" }),
    ).rejects.toThrow("A site address comes with the Starter plan");
    await t.mutation(internal.billing.grantPlan, { userId: member.userId, plan: "starter" });
    await t.mutation(internal.billing.grantPlan, { userId: other.userId, plan: "starter" });
    const mine = await member.as.mutation(api.sites.setSlug, { id: siteId, slug: "The Bakery!" });
    expect(mine).toEqual({
      slug: "the-bakery",
      host: "the-bakery.sites.forgenexxus.com",
      url: "https://the-bakery.sites.forgenexxus.com",
    });
    // Chosen before publishing, and kept by the publish that follows.
    await build(t, siteId);
    expect(await member.as.mutation(api.sites.publish, { id: siteId })).toMatchObject({
      slug: "the-bakery",
    });
    // Nobody else can take it, and saying it again is not a clash with itself.
    const theirs = await other.as.mutation(api.sites.create, { name: "Other" });
    await expect(
      other.as.mutation(api.sites.setSlug, { id: theirs.siteId, slug: "the-bakery" }),
    ).rejects.toThrow("taken");
    await member.as.mutation(api.sites.setSlug, { id: siteId, slug: "the-bakery" });
    await expect(
      member.as.mutation(api.sites.setSlug, { id: siteId, slug: "www" }),
    ).rejects.toThrow("reserved");
    await expect(
      other.as.mutation(api.sites.setSlug, { id: siteId, slug: "stolen" }),
    ).rejects.toThrow("Site not found");
    expect(await t.query(api.sites.slugAvailable, { slug: "free-one" })).toBeNull();
    expect(await member.as.query(api.sites.slugAvailable, { slug: "the-bakery", siteId })).toMatchObject({
      available: true,
    });
    expect(await other.as.query(api.sites.slugAvailable, { slug: "The Bakery" })).toMatchObject({
      slug: "the-bakery",
      available: false,
    });
    // Moving the address moves the site; the old one stops answering.
    await member.as.mutation(api.sites.setSlug, { id: siteId, slug: "bakery-on-main" });
    expect((await t.fetch("/", { headers: { host: "bakery-on-main.sites.forgenexxus.com" } })).status).toBe(200);
    expect((await t.fetch("/", { headers: { host: "the-bakery.sites.forgenexxus.com" } })).status).toBe(404);
    await expect(
      member.as.mutation(api.sites.setSlug, { id: siteId, slug: "bakery-third-address" }),
    ).rejects.toThrow("already been changed");
    expect(await member.as.query(api.sites.slugAvailable, {
      slug: "bakery-third-address",
      siteId,
    })).toMatchObject({
      available: false,
      problem: "This site's address has already been changed",
    });
    expect(await member.as.query(api.sites.list, {})).toEqual([
      expect.objectContaining({ addressChangeAvailable: false, slug: "bakery-on-main" }),
    ]);
  });

  test("a site answers on its own host, and on a domain pointed at it", async () => {
    const t = fresh();
    const member = await createUser(t, { email: "m@example.com" });
    await t.mutation(internal.billing.grantPlan, { userId: member.userId, plan: "pro" });
    const { siteId } = await member.as.mutation(api.sites.create, { name: "Shop" });
    await build(t, siteId);
    await member.as.mutation(api.sites.publish, { id: siteId });
    await member.as.mutation(api.domains.add, { siteId, hostname: "www.shop.example" });
    const host = (hostname: string) => t.fetch("/", { headers: { host: hostname } });
    expect(await (await host("shop.sites.forgenexxus.com")).text()).toBe(PAGE);
    // A domain that resolves here is served while verification catches up.
    expect(await (await host("www.shop.example")).text()).toBe(PAGE);
    expect((await host("nobody.sites.forgenexxus.com")).status).toBe(404);
    expect((await host("not-added.example")).status).toBe(404);
    await member.as.mutation(api.sites.unpublish, { id: siteId });
    expect((await host("www.shop.example")).status).toBe(404);
  });

  test("deleting a site removes its versions", async () => {
    const t = fresh();
    const member = await createUser(t, { email: "m@example.com" });
    const { siteId } = await member.as.mutation(api.sites.create, { name: "Shop" });
    await build(t, siteId);
    await member.as.mutation(api.sites.remove, { id: siteId });
    expect(await t.run((ctx) => ctx.db.query("siteVersions").collect())).toEqual([]);
  });
});
