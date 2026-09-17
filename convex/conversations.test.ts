/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { exportPKCS8, generateKeyPair } from "jose";
import { beforeAll, describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import { adoptGuestData } from "./auth";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

function fresh() {
  return convexTest(schema, modules);
}

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

describe("conversations", () => {
  test("signed-out list is empty and create is rejected", async () => {
    const t = fresh();
    expect(await t.query(api.conversations.list, {})).toEqual([]);
    await expect(t.mutation(api.conversations.create, {})).rejects.toThrow("Not signed in");
  });

  test("owner can create, message, rename, and delete; others cannot see it", async () => {
    const t = fresh();
    const alice = await createUser(t, { isAnonymous: true });
    const bob = await createUser(t, { isAnonymous: true });

    const id = await alice.as.mutation(api.conversations.create, { title: "   " });
    const [created] = await alice.as.query(api.conversations.list, {});
    expect(created._id).toBe(id);
    expect(created.title).toBe("New conversation");

    await alice.as.mutation(api.messages.send, { conversationId: id, body: "  hello  " });
    const messages = await alice.as.query(api.messages.list, { conversationId: id });
    expect(messages.map((m) => [m.role, m.body])).toEqual([["user", "hello"]]);
    const [bumped] = await alice.as.query(api.conversations.list, {});
    expect(bumped.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);

    expect(await bob.as.query(api.conversations.list, {})).toEqual([]);
    expect(await bob.as.query(api.messages.list, { conversationId: id })).toEqual([]);
    await expect(
      bob.as.mutation(api.conversations.rename, { id, title: "stolen" }),
    ).rejects.toThrow("Conversation not found");
    await expect(
      bob.as.mutation(api.messages.send, { conversationId: id, body: "hi" }),
    ).rejects.toThrow("Conversation not found");

    await alice.as.mutation(api.conversations.rename, { id, title: "  Renamed  " });
    expect((await alice.as.query(api.conversations.list, {}))[0].title).toBe("Renamed");

    await alice.as.mutation(api.conversations.remove, { id });
    expect(await alice.as.query(api.conversations.list, {})).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("messages").collect())).toEqual([]);
  });

  test("empty messages are rejected", async () => {
    const t = fresh();
    const alice = await createUser(t, { isAnonymous: true });
    const id = await alice.as.mutation(api.conversations.create, {});
    await expect(
      alice.as.mutation(api.messages.send, { conversationId: id, body: " \n " }),
    ).rejects.toThrow("Message is empty");
  });

  test("list orders by most recent activity", async () => {
    const t = fresh();
    const alice = await createUser(t, { isAnonymous: true });
    const first = await alice.as.mutation(api.conversations.create, { title: "first" });
    const second = await alice.as.mutation(api.conversations.create, { title: "second" });
    expect((await alice.as.query(api.conversations.list, {})).map((c) => c._id)).toEqual([
      second,
      first,
    ]);
    await t.run(async (ctx) => {
      await ctx.db.patch(first, { updatedAt: Date.now() + 1000 });
    });
    expect((await alice.as.query(api.conversations.list, {})).map((c) => c._id)).toEqual([
      first,
      second,
    ]);
  });
});

describe("guest upgrade", () => {
  test("adoptGuestData moves conversations to the account and removes the guest", async () => {
    const t = fresh();
    const guest = await createUser(t, { isAnonymous: true });
    const member = await createUser(t, { email: "member@example.com" });
    const kept = await member.as.mutation(api.conversations.create, { title: "Existing" });
    const draft = await guest.as.mutation(api.conversations.create, { title: "Draft" });
    await guest.as.mutation(api.messages.send, { conversationId: draft, body: "guest text" });
    await t.run(async (ctx) => {
      await ctx.db.insert("authAccounts", {
        userId: guest.userId,
        provider: "anonymous",
        providerAccountId: "guest-account",
      });
    });

    await t.run((ctx) => adoptGuestData(ctx, guest.userId, member.userId));

    const ids = (await member.as.query(api.conversations.list, {})).map((c) => c._id);
    expect(ids.sort()).toEqual([kept, draft].sort());
    const messages = await member.as.query(api.messages.list, { conversationId: draft });
    expect(messages.map((m) => m.body)).toEqual(["guest text"]);
    expect(await t.run((ctx) => ctx.db.get(guest.userId))).toBeNull();
    expect(await t.run((ctx) => ctx.db.query("authAccounts").collect())).toEqual([]);
  });
});

describe("anonymous sign-in", () => {
  beforeAll(async () => {
    const { privateKey } = await generateKeyPair("RS256", { extractable: true });
    process.env.JWT_PRIVATE_KEY = (await exportPKCS8(privateKey)).trimEnd().replace(/\n/g, " ");
    process.env.CONVEX_SITE_URL = "https://test.convex.site";
    process.env.SITE_URL = "https://example.test/forge-nexxus/";
  });

  test("issues tokens for a brand-new anonymous user", async () => {
    const t = fresh();
    const result = await t.action(api.auth.signIn, { provider: "anonymous" });
    expect(result.tokens?.token).toBeTruthy();
    const users = await t.run((ctx) => ctx.db.query("users").collect());
    expect(users).toHaveLength(1);
    expect(users[0].isAnonymous).toBe(true);
    const payload = JSON.parse(atob(result.tokens!.token.split(".")[1]));
    expect(payload.sub.startsWith(users[0]._id)).toBe(true);
  });
});
