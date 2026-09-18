/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { exportPKCS8, generateKeyPair } from "jose";
import { beforeAll, describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.*s", "!./remote.ts"]);
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
