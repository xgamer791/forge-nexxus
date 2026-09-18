/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import { normalizeHostname } from "./domains";
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
    ).rejects.toThrow("Custom domains come with the Premium plan");
    await t.mutation(internal.billing.grantPlan, { userId: member.userId, plan: "starter" });
    await expect(
      member.as.mutation(api.domains.add, { siteId, hostname: "shop.example" }),
    ).rejects.toThrow("Custom domains come with the Premium plan");
    expect(await member.as.query(api.domains.list, {})).toEqual([]);
  });

  test("a pasted URL becomes a hostname; duplicates and nonsense are refused", async () => {
    const t = fresh();
    const member = await createUser(t, { email: "m@example.com" });
    await t.mutation(internal.billing.grantPlan, { userId: member.userId, plan: "premium" });
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
    await t.mutation(internal.billing.grantPlan, { userId: alice.userId, plan: "premium" });
    await t.mutation(internal.billing.grantPlan, { userId: bob.userId, plan: "premium" });
    const { siteId } = await alice.as.mutation(api.sites.create, { name: "Alice's" });
    const id = await alice.as.mutation(api.domains.add, { siteId, hostname: "alice.example" });
    expect(await bob.as.query(api.domains.list, {})).toEqual([]);
    await expect(
      bob.as.mutation(api.domains.add, { siteId, hostname: "bob.example" }),
    ).rejects.toThrow("Site not found");
    await expect(bob.as.mutation(api.domains.remove, { id })).rejects.toThrow("Domain not found");
    expect(await alice.as.query(api.domains.list, {})).toHaveLength(1);
  });
});
