/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { planFor } from "./plans";
import { BADGE_TEXT, slugify } from "./sites";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");
const fresh = () => convexTest(schema, modules);

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
    await t.mutation(internal.billing.grantPlan, { userId: member.userId, plan: "premium" });
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
    await t.mutation(internal.billing.grantPlan, { userId: member.userId, plan: "premium" });
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
    await expect(member.as.mutation(api.sites.publish, { id: siteId })).rejects.toThrow(
      "Build the site before publishing",
    );
    const first = await build(t, siteId);
    const published = await member.as.mutation(api.sites.publish, { id: siteId });
    expect(published).toEqual({ slug: "bakery-on-main", url: "https://test.convex.site/sites/bakery-on-main" });
    const [site] = await member.as.query(api.sites.list, {});
    expect(site).toMatchObject({
      status: "published",
      slug: "bakery-on-main",
      publishedVersionId: first,
      publishedUrl: "https://test.convex.site/sites/bakery-on-main",
    });
    expect((await member.as.query(api.sites.currentHtml, { siteId }))?.published).toBe(true);

    const served = await t.fetch("/sites/bakery-on-main");
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toContain("text/html");
    expect(served.headers.get("content-security-policy")).toContain("default-src 'none'");
    // A free plan's site carries the badge, in the preview and on the address alike.
    const badged = await served.text();
    expect(badged).toContain(BADGE_TEXT);
    expect(badged.endsWith("</body></html>")).toBe(true);
    expect(badged.replace(/<a href="[^"]*" rel="noopener" style="[^"]*">Built with Forge<\/a>/, "")).toBe(PAGE);
    expect((await member.as.query(api.sites.currentHtml, { siteId }))?.html).toContain(BADGE_TEXT);
    await t.mutation(internal.billing.grantPlan, { userId: member.userId, plan: "starter" });
    expect(await (await t.fetch("/sites/bakery-on-main")).text()).toBe(PAGE);
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
    expect(draft).toMatchObject({ status: "draft", slug: "bakery-on-main", publishedUrl: null });
    expect(await member.as.mutation(api.sites.publish, { id: siteId })).toMatchObject({ slug: "bakery-on-main" });
    delete process.env.CONVEX_SITE_URL;
  });

  test("addresses are unique across accounts, and only the owner publishes", async () => {
    const t = fresh();
    const alice = await createUser(t, { email: "a@example.com" });
    const bob = await createUser(t, { email: "b@example.com" });
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

  test("deleting a site removes its versions", async () => {
    const t = fresh();
    const member = await createUser(t, { email: "m@example.com" });
    const { siteId } = await member.as.mutation(api.sites.create, { name: "Shop" });
    await build(t, siteId);
    await member.as.mutation(api.sites.remove, { id: siteId });
    expect(await t.run((ctx) => ctx.db.query("siteVersions").collect())).toEqual([]);
  });
});
