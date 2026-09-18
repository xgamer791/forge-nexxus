/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { exportPKCS8, generateKeyPair } from "jose";
import { beforeAll, describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");
const fresh = () => convexTest(schema, modules);

const subjectOf = (token: string) =>
  JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).sub as string;

beforeAll(async () => {
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  process.env.JWT_PRIVATE_KEY = (await exportPKCS8(privateKey)).trimEnd().replace(/\n/g, " ");
  process.env.CONVEX_SITE_URL = "https://test.convex.site";
  process.env.SITE_URL = "https://example.test/forge-nexxus";
});

describe("sign-in", () => {
  test("a first anonymous sign-in creates a guest and issues tokens", async () => {
    const t = fresh();
    const result = await t.action(api.auth.signIn, { provider: "anonymous" });
    expect(result.tokens?.token).toBeTruthy();
    const users = await t.run((ctx) => ctx.db.query("users").collect());
    expect(users).toHaveLength(1);
    expect(users[0].isAnonymous).toBe(true);
    expect(subjectOf(result.tokens!.token).startsWith(users[0]._id)).toBe(true);
  });

  test("signing in from a guest session moves the guest's conversations to the new user", async () => {
    const t = fresh();
    const first = await t.action(api.auth.signIn, { provider: "anonymous" });
    const guestSubject = subjectOf(first.tokens!.token);
    const guestId = guestSubject.split("|")[0];
    const asGuest = t.withIdentity({ subject: guestSubject });
    const draft = await asGuest.mutation(api.conversations.create, { title: "Draft" });
    await asGuest.mutation(api.messages.send, { conversationId: draft, body: "keep me" });

    const second = await asGuest.action(api.auth.signIn, { provider: "anonymous" });
    const memberSubject = subjectOf(second.tokens!.token);
    expect(memberSubject.split("|")[0]).not.toBe(guestId);

    const asMember = t.withIdentity({ subject: memberSubject });
    const conversations = await asMember.query(api.conversations.list, {});
    expect(conversations.map((c) => c._id)).toEqual([draft]);
    const messages = await asMember.query(api.messages.list, { conversationId: draft });
    expect(messages.map((m) => m.body)).toEqual(["keep me"]);
    expect(await t.run((ctx) => ctx.db.query("users").collect())).toHaveLength(1);
    const accounts = await t.run((ctx) => ctx.db.query("authAccounts").collect());
    expect(accounts.every((a) => a.userId !== guestId)).toBe(true);
  });

  test("adoptGuest never moves data away from a real account", async () => {
    const t = fresh();
    const { memberId, otherId, kept } = await t.run(async (ctx) => {
      const memberId = await ctx.db.insert("users", { email: "member@example.com" });
      const otherId = await ctx.db.insert("users", { email: "other@example.com" });
      const kept = await ctx.db.insert("conversations", {
        userId: memberId,
        title: "Mine",
        updatedAt: Date.now(),
      });
      return { memberId, otherId, kept };
    });
    await t.mutation(internal.auth.adoptGuest, { guestId: memberId, userId: otherId });
    const conversation = await t.run((ctx) => ctx.db.get(kept));
    expect(conversation?.userId).toBe(memberId);
    expect(await t.run((ctx) => ctx.db.get(memberId))).not.toBeNull();
  });
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
  return { userId, sessionId, as: t.withIdentity({ subject: `${userId}|${sessionId}` }) };
}

describe("guest adoption", () => {
  test("a guest's sites and domains follow them into the account", async () => {
    const t = fresh();
    const { guestId, memberId, siteId, domainId } = await t.run(async (ctx) => {
      const guestId = await ctx.db.insert("users", { isAnonymous: true });
      const memberId = await ctx.db.insert("users", { email: "member@example.com" });
      const conversationId = await ctx.db.insert("conversations", {
        userId: guestId,
        title: "Shop",
        updatedAt: 1,
      });
      const siteId = await ctx.db.insert("sites", {
        userId: guestId,
        conversationId,
        name: "Shop",
        status: "draft",
        createdAt: 1,
        updatedAt: 1,
      });
      const domainId = await ctx.db.insert("domains", {
        userId: guestId,
        siteId,
        hostname: "shop.example",
        status: "pending",
        createdAt: 1,
      });
      return { guestId, memberId, siteId, domainId };
    });
    await t.mutation(internal.auth.adoptGuest, { guestId, userId: memberId });
    expect((await t.run((ctx) => ctx.db.get(siteId)))?.userId).toBe(memberId);
    expect((await t.run((ctx) => ctx.db.get(domainId)))?.userId).toBe(memberId);
    expect(await t.run((ctx) => ctx.db.get(guestId))).toBeNull();
    const asMember = t.withIdentity({ subject: `${memberId}|session` });
    expect((await asMember.query(api.sites.list, {})).map((site) => site.name)).toEqual(["Shop"]);
  });
});

describe("profile", () => {
  test("members rename themselves; guests cannot", async () => {
    const t = fresh();
    const member = await createUser(t, { email: "m@example.com" });
    await member.as.mutation(api.users.updateProfile, { name: "  Sam   Lee  " });
    expect((await member.as.query(api.users.me, {}))?.name).toBe("Sam Lee");
    await expect(member.as.mutation(api.users.updateProfile, { name: "   " })).rejects.toThrow(
      "Enter a name",
    );
    const guest = await createUser(t, { isAnonymous: true });
    await expect(guest.as.mutation(api.users.updateProfile, { name: "Nope" })).rejects.toThrow(
      "Sign in to build",
    );
  });

  test("providers lists linked sign-in methods without the anonymous one", async () => {
    const t = fresh();
    expect(await t.query(api.users.providers, {})).toEqual([]);
    const member = await createUser(t, { email: "m@example.com" });
    await t.run(async (ctx) => {
      await ctx.db.insert("authAccounts", {
        userId: member.userId,
        provider: "google",
        providerAccountId: "g-1",
      });
      await ctx.db.insert("authAccounts", {
        userId: member.userId,
        provider: "anonymous",
        providerAccountId: "anon-1",
      });
    });
    expect(await member.as.query(api.users.providers, {})).toEqual(["google"]);
  });

  test("deleting the account removes everything it owned and its sessions", async () => {
    const t = fresh();
    const member = await createUser(t, { email: "m@example.com" });
    const bystander = await createUser(t, { email: "b@example.com" });
    await t.mutation(internal.billing.grantPlan, { userId: member.userId, plan: "premium" });
    const { siteId, conversationId } = await member.as.mutation(api.sites.create, { name: "Shop" });
    await member.as.mutation(api.messages.send, { conversationId, body: "hi" });
    await member.as.mutation(api.domains.add, { siteId, hostname: "shop.example" });
    await member.as.mutation(api.settings.update, { theme: "light" });
    await t.mutation(internal.billing.reserve, { userId: member.userId, requestKind: "edit" });
    await t.run(async (ctx) => {
      const accountId = await ctx.db.insert("authAccounts", {
        userId: member.userId,
        provider: "google",
        providerAccountId: "g-1",
      });
      await ctx.db.insert("authVerificationCodes", {
        accountId,
        provider: "google",
        code: "abc",
        expirationTime: Date.now() + 1000,
      });
      await ctx.db.insert("authRefreshTokens", {
        sessionId: member.sessionId,
        expirationTime: Date.now() + 1000,
      });
    });
    await bystander.as.mutation(api.settings.update, { theme: "dark" });

    await member.as.mutation(api.users.deleteAccount, {});
    const tables = [
      "sites",
      "conversations",
      "messages",
      "domains",
      "subscriptions",
      "creditLedger",
      "creditHolds",
      "authAccounts",
      "authRefreshTokens",
      "authVerificationCodes",
    ] as const;
    for (const table of tables) {
      expect(await t.run((ctx) => ctx.db.query(table).collect()), table).toEqual([]);
    }
    expect(await t.run((ctx) => ctx.db.get(member.userId))).toBeNull();
    // The bystander is untouched.
    expect(await t.run((ctx) => ctx.db.get(bystander.userId))).not.toBeNull();
    expect(await bystander.as.query(api.settings.get, {})).toEqual({ theme: "dark" });
    expect(await t.run((ctx) => ctx.db.query("authSessions").collect())).toHaveLength(1);
    expect(await t.run((ctx) => ctx.db.query("settings").collect())).toHaveLength(1);
  });

  test("a guest cannot delete an account", async () => {
    const t = fresh();
    const guest = await createUser(t, { isAnonymous: true });
    await expect(guest.as.mutation(api.users.deleteAccount, {})).rejects.toThrow("Sign in to build");
  });
});

describe("users.me", () => {
  test("is null when signed out", async () => {
    expect(await fresh().query(api.users.me, {})).toBeNull();
  });

  test("reports guests and members", async () => {
    const t = fresh();
    const guest = await t.action(api.auth.signIn, { provider: "anonymous" });
    const asGuest = t.withIdentity({ subject: subjectOf(guest.tokens!.token) });
    expect(await asGuest.query(api.users.me, {})).toMatchObject({
      isAnonymous: true,
      email: null,
      name: null,
    });

    const memberId = await t.run((ctx) =>
      ctx.db.insert("users", { email: "chris@example.com", name: "Chris" }),
    );
    const asMember = t.withIdentity({ subject: `${memberId}|session` });
    expect(await asMember.query(api.users.me, {})).toEqual({
      _id: memberId,
      name: "Chris",
      email: "chris@example.com",
      image: null,
      isAnonymous: false,
    });
  });
});
