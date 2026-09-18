/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
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

describe("settings", () => {
  test("null until something is saved", async () => {
    const t = fresh();
    expect(await t.query(api.settings.get, {})).toBeNull();
    const user = await createUser(t, { isAnonymous: true });
    expect(await user.as.query(api.settings.get, {})).toBeNull();
    await expect(t.mutation(api.settings.update, { theme: "light" })).rejects.toThrow(
      "Not signed in",
    );
  });

  test("update creates the row, then patches only what it is given", async () => {
    const t = fresh();
    const user = await createUser(t, { isAnonymous: true });
    await user.as.mutation(api.settings.update, { theme: "light", density: 40 });
    expect(await user.as.query(api.settings.get, {})).toEqual({ theme: "light", density: 40 });
    await user.as.mutation(api.settings.update, { codeWrap: true });
    expect(await user.as.query(api.settings.get, {})).toEqual({
      theme: "light",
      density: 40,
      codeWrap: true,
    });
    await user.as.mutation(api.settings.update, {});
    expect(await t.run((ctx) => ctx.db.query("settings").collect())).toHaveLength(1);
  });

  test("density is clamped to the slider's range", async () => {
    const t = fresh();
    const user = await createUser(t, { isAnonymous: true });
    await user.as.mutation(api.settings.update, { density: 140 });
    expect((await user.as.query(api.settings.get, {}))?.density).toBe(100);
    await user.as.mutation(api.settings.update, { density: -5 });
    expect((await user.as.query(api.settings.get, {}))?.density).toBe(0);
    await user.as.mutation(api.settings.update, { density: 33.6 });
    expect((await user.as.query(api.settings.get, {}))?.density).toBe(34);
  });

  test("settings are private to the account that saved them", async () => {
    const t = fresh();
    const alice = await createUser(t, { email: "a@example.com" });
    const bob = await createUser(t, { email: "b@example.com" });
    await alice.as.mutation(api.settings.update, { theme: "light" });
    expect(await bob.as.query(api.settings.get, {})).toBeNull();
    expect(await alice.as.query(api.settings.get, {})).toEqual({ theme: "light" });
  });
});

describe("guest adoption", () => {
  test("settings follow a guest into the account", async () => {
    const t = fresh();
    const guest = await createUser(t, { isAnonymous: true });
    const member = await createUser(t, { email: "m@example.com" });
    await guest.as.mutation(api.settings.update, { theme: "light", density: 20 });
    await t.mutation(internal.auth.adoptGuest, { guestId: guest.userId, userId: member.userId });
    expect(await member.as.query(api.settings.get, {})).toEqual({ theme: "light", density: 20 });
    expect(await t.run((ctx) => ctx.db.get(guest.userId))).toBeNull();
  });

  test("an account keeps the settings it already saved", async () => {
    const t = fresh();
    const guest = await createUser(t, { isAnonymous: true });
    const member = await createUser(t, { email: "m@example.com" });
    await member.as.mutation(api.settings.update, { theme: "dark" });
    await guest.as.mutation(api.settings.update, { theme: "light" });
    await t.mutation(internal.auth.adoptGuest, { guestId: guest.userId, userId: member.userId });
    expect(await member.as.query(api.settings.get, {})).toEqual({ theme: "dark" });
    expect(await t.run((ctx) => ctx.db.query("settings").collect())).toHaveLength(1);
  });
});
