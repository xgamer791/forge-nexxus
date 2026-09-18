/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import { planFor } from "./plans";
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
    await t.mutation(internal.billing.grantPlan, { userId: member.userId, plan: "starter" });
    const { siteId, conversationId } = await member.as.mutation(api.sites.create, { name: "Shop" });
    await member.as.mutation(api.domains.add, { siteId, hostname: "shop.example" });
    await member.as.mutation(api.conversations.remove, { id: conversationId });
    expect(await member.as.query(api.sites.list, {})).toEqual([]);
    expect(await member.as.query(api.domains.list, {})).toEqual([]);
  });
});
