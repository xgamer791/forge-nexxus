/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { dnsRecordFor, normalizeHostname } from "./domains";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");
const fresh = () => convexTest(schema, modules);

// A custom domain is pointed at the site's own address, so these tests need a
// deployment that has a sites domain. There is no default for one; see
// HOSTING.md for why, and for what setting it up takes.
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

// Forge assigns the first address when a build is published. The one change
// a member gets is what these tests use to land on a known host.
async function publishThenRename(
  t: ReturnType<typeof fresh>,
  member: Awaited<ReturnType<typeof createUser>>,
  siteId: Id<"sites">,
  slug: string,
) {
  await t.run(async (ctx) => {
    const site = (await ctx.db.get(siteId))!;
    const versionId = await ctx.db.insert("siteVersions", {
      userId: site.userId,
      siteId,
      html: "<!doctype html><html><head><title>Shop</title></head><body>Shop</body></html>",
      summary: "Built",
      requestKind: "generate",
      createdAt: Date.now(),
    });
    await ctx.db.patch(siteId, { currentVersionId: versionId });
  });
  await member.as.mutation(api.sites.publish, { id: siteId });
  await member.as.mutation(api.sites.setSlug, { id: siteId, slug });
}

describe("domains", () => {
  test("normalizeHostname keeps only the host a user meant", () => {
    expect(normalizeHostname("  HTTPS://www.My-Shop.example/path?x=1 ")).toBe("www.my-shop.example");
    expect(normalizeHostname("http://example.com:8080/x")).toBe("example.com");
    expect(normalizeHostname("example.com.")).toBe("example.com");
    expect(normalizeHostname("shop.example#top")).toBe("shop.example");
  });

  test("signed-out list is empty", async () => {
    expect(await fresh().query(api.domains.list, {})).toEqual([]);
  });

  test("custom domains need a paid plan", async () => {
    const t = fresh();
    const member = await createUser(t, { email: "m@example.com" });
    const { siteId } = await member.as.mutation(api.sites.create, { name: "Shop" });
    await expect(
      member.as.mutation(api.domains.add, { siteId, hostname: "shop.example" }),
    ).rejects.toThrow("Custom domains come with the Pro plan");
    await t.mutation(internal.billing.grantPlan, { userId: member.userId, plan: "starter" });
    await expect(
      member.as.mutation(api.domains.add, { siteId, hostname: "shop.example" }),
    ).rejects.toThrow("Custom domains come with the Pro plan");
    expect(await member.as.query(api.domains.list, {})).toEqual([]);
  });

  test("a pasted URL becomes a hostname; duplicates and nonsense are refused", async () => {
    const t = fresh();
    const member = await createUser(t, { email: "m@example.com" });
    await t.mutation(internal.billing.grantPlan, { userId: member.userId, plan: "pro" });
    const { siteId } = await member.as.mutation(api.sites.create, { name: "Shop" });
    const id = await member.as.mutation(api.domains.add, {
      siteId,
      hostname: "  HTTPS://www.My-Shop.example/path?x=1 ",
    });
    const [domain] = await member.as.query(api.domains.list, {});
    expect(domain).toMatchObject({ _id: id, siteId, hostname: "www.my-shop.example", status: "pending" });
    expect(domain).not.toHaveProperty("userId");
    await expect(
      member.as.mutation(api.domains.add, { siteId, hostname: "www.my-shop.example." }),
    ).rejects.toThrow("already added");
    for (const bad of ["", "shop", "-shop.example", "shop-.example", "shop.example.1", "a b.example"]) {
      await expect(member.as.mutation(api.domains.add, { siteId, hostname: bad })).rejects.toThrow(
        "like example.com",
      );
    }
    await member.as.mutation(api.domains.remove, { id });
    expect(await member.as.query(api.domains.list, {})).toEqual([]);
  });

  test("another account cannot see, add to, or remove a domain", async () => {
    const t = fresh();
    const alice = await createUser(t, { email: "a@example.com" });
    const bob = await createUser(t, { email: "b@example.com" });
    await t.mutation(internal.billing.grantPlan, { userId: alice.userId, plan: "pro" });
    await t.mutation(internal.billing.grantPlan, { userId: bob.userId, plan: "pro" });
    const { siteId } = await alice.as.mutation(api.sites.create, { name: "Alice's" });
    const id = await alice.as.mutation(api.domains.add, { siteId, hostname: "alice.example" });
    expect(await bob.as.query(api.domains.list, {})).toEqual([]);
    await expect(
      bob.as.mutation(api.domains.add, { siteId, hostname: "bob.example" }),
    ).rejects.toThrow("Site not found");
    await expect(bob.as.mutation(api.domains.remove, { id })).rejects.toThrow("Domain not found");
    expect(await alice.as.query(api.domains.list, {})).toHaveLength(1);
  });

  test("a domain is pointed at the site's own address with one record", async () => {
    const t = fresh();
    const member = await createUser(t, { email: "m@example.com" });
    await t.mutation(internal.billing.grantPlan, { userId: member.userId, plan: "pro" });
    const { siteId } = await member.as.mutation(api.sites.create, { name: "Shop" });
    // The first address is assigned, not chosen. The DNS record is what this test checks.
    await t.run(async (ctx) => {
      await ctx.db.patch(siteId, { slug: "shop" });
    });
    await member.as.mutation(api.domains.add, { siteId, hostname: "www.shop.example" });
    await member.as.mutation(api.domains.add, { siteId, hostname: "shop.example" });
    const [subdomain, root] = await member.as.query(api.domains.list, {});
    expect(subdomain.record).toEqual({
      type: "CNAME",
      name: "www",
      value: "shop.sites.forgenexxus.com",
      root: false,
    });
    // A bare domain cannot hold a CNAME, so it asks for the root alias instead.
    expect(root.record).toEqual({
      type: "ALIAS",
      name: "@",
      value: "shop.sites.forgenexxus.com",
      root: true,
    });
    expect(dnsRecordFor("deep.www.example.com", null).name).toBe("deep");
  });

  test("our own hosting domain is not somebody's custom domain", async () => {
    const t = fresh();
    const member = await createUser(t, { email: "m@example.com" });
    await t.mutation(internal.billing.grantPlan, { userId: member.userId, plan: "pro" });
    const { siteId } = await member.as.mutation(api.sites.create, { name: "Shop" });
    await expect(
      member.as.mutation(api.domains.add, { siteId, hostname: "mine.sites.forgenexxus.com" }),
    ).rejects.toThrow("already has an address");
  });

  test("a domain another account holds is refused rather than moved", async () => {
    const t = fresh();
    const alice = await createUser(t, { email: "a@example.com" });
    const bob = await createUser(t, { email: "b@example.com" });
    await t.mutation(internal.billing.grantPlan, { userId: alice.userId, plan: "pro" });
    await t.mutation(internal.billing.grantPlan, { userId: bob.userId, plan: "pro" });
    const alices = await alice.as.mutation(api.sites.create, { name: "Alice's" });
    const bobs = await bob.as.mutation(api.sites.create, { name: "Bob's" });
    await alice.as.mutation(api.domains.add, { siteId: alices.siteId, hostname: "shop.example" });
    await expect(
      bob.as.mutation(api.domains.add, { siteId: bobs.siteId, hostname: "shop.example" }),
    ).rejects.toThrow("another account");
  });

  test("verification records what DNS actually says, and only the server writes it", async () => {
    const t = fresh();
    const member = await createUser(t, { email: "m@example.com" });
    await t.mutation(internal.billing.grantPlan, { userId: member.userId, plan: "pro" });
    const { siteId } = await member.as.mutation(api.sites.create, { name: "Shop" });
    await t.run(async (ctx) => {
      await ctx.db.patch(siteId, { slug: "shop" });
    });
    const id = await member.as.mutation(api.domains.add, { siteId, hostname: "www.shop.example" });
    const answers: Array<{ type: number; data: string }[]> = [
      [],
      [{ type: 5, data: "somewhere-else.example." }],
      [{ type: 5, data: "shop.sites.forgenexxus.com." }],
    ];
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ Answer: answers.shift() }), {
        headers: { "content-type": "application/dns-json" },
      })) as typeof fetch;
    try {
      const missing = await member.as.action(api.domains.verify, { id });
      expect(missing.status).toBe("pending");
      expect(missing.note).toContain("No CNAME record yet");
      const elsewhere = await member.as.action(api.domains.verify, { id });
      expect(elsewhere.status).toBe("pending");
      expect(elsewhere.note).toContain("somewhere-else.example");
      const found = await member.as.action(api.domains.verify, { id });
      expect(found.status).toBe("active");
      const [domain] = await member.as.query(api.domains.list, {});
      expect(domain).toMatchObject({ status: "active" });
      expect(domain.verifiedAt).toBeGreaterThan(0);
      // Someone else's domain is not theirs to check.
      const bob = await createUser(t, { email: "b@example.com" });
      await expect(bob.as.action(api.domains.verify, { id })).rejects.toThrow("Domain not found");
    } finally {
      globalThis.fetch = original;
    }
  });
});
