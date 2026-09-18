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

describe("connections", () => {
  test("signed-out list is empty and add is rejected", async () => {
    const t = fresh();
    expect(await t.query(api.connections.list, {})).toEqual([]);
    await expect(
      t.mutation(api.connections.add, { kind: "cloud", name: "Box", detail: "root@10.0.0.1" }),
    ).rejects.toThrow("Not signed in");
  });

  test("a new account sees nothing until it adds something", async () => {
    const t = fresh();
    const alice = await createUser(t, { isAnonymous: true });
    expect(await alice.as.query(api.connections.list, {})).toEqual([]);
  });

  test("add trims, rejects blanks, and lists by name", async () => {
    const t = fresh();
    const alice = await createUser(t, { isAnonymous: true });
    await alice.as.mutation(api.connections.add, {
      kind: "repo",
      name: "  truckpay-calculator  ",
      detail: "  xgamer791/truckpay-calculator  ",
    });
    await alice.as.mutation(api.connections.add, {
      kind: "repo",
      name: "forge-nexxus",
      detail: "xgamer791/forge-nexxus",
    });
    await expect(
      alice.as.mutation(api.connections.add, { kind: "cloud", name: " ", detail: "root@10.0.0.1" }),
    ).rejects.toThrow("A workspace needs a name and an address");

    const listed = await alice.as.query(api.connections.list, {});
    expect(listed.map((c) => [c.name, c.detail, c.connected])).toEqual([
      ["forge-nexxus", "xgamer791/forge-nexxus", false],
      ["truckpay-calculator", "xgamer791/truckpay-calculator", false],
    ]);
  });

  test("adding the same address twice renames rather than duplicates", async () => {
    const t = fresh();
    const alice = await createUser(t, { isAnonymous: true });
    const first = await alice.as.mutation(api.connections.add, {
      kind: "cloud",
      name: "Box",
      detail: "master_x@138.197.83.241",
    });
    const again = await alice.as.mutation(api.connections.add, {
      kind: "cloud",
      name: "Chris ( Cloudways )",
      detail: "master_x@138.197.83.241",
    });
    expect(again).toBe(first);
    const listed = await alice.as.query(api.connections.list, {});
    expect(listed).toHaveLength(1);
    expect(listed[0].name).toBe("Chris ( Cloudways )");
  });

  test("one workspace per kind is connected at a time", async () => {
    const t = fresh();
    const alice = await createUser(t, { isAnonymous: true });
    const chris = await alice.as.mutation(api.connections.add, {
      kind: "cloud",
      name: "Chris",
      detail: "master_a@138.197.83.241",
    });
    const antonio = await alice.as.mutation(api.connections.add, {
      kind: "cloud",
      name: "Antonio",
      detail: "master_b@157.245.113.67",
    });
    const repo = await alice.as.mutation(api.connections.add, {
      kind: "repo",
      name: "forge-nexxus",
      detail: "xgamer791/forge-nexxus",
    });

    await alice.as.mutation(api.connections.setConnected, { id: chris, connected: true });
    await alice.as.mutation(api.connections.setConnected, { id: repo, connected: true });
    const connected = async () =>
      Object.fromEntries(
        (await alice.as.query(api.connections.list, {})).map((c) => [c._id, c.connected]),
      );
    // A repo and a cloud workspace can be connected at the same time.
    expect(await connected()).toEqual({ [chris]: true, [antonio]: false, [repo]: true });

    await alice.as.mutation(api.connections.setConnected, { id: antonio, connected: true });
    expect(await connected()).toEqual({ [chris]: false, [antonio]: true, [repo]: true });

    await alice.as.mutation(api.connections.setConnected, { id: antonio, connected: false });
    expect(await connected()).toEqual({ [chris]: false, [antonio]: false, [repo]: true });
  });

  test("connecting bumps usedAt so Recents can order by it", async () => {
    const t = fresh();
    const alice = await createUser(t, { isAnonymous: true });
    const id = await alice.as.mutation(api.connections.add, {
      kind: "cloud",
      name: "Box",
      detail: "root@10.0.0.1",
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(id, { usedAt: 1 });
    });
    await alice.as.mutation(api.connections.setConnected, { id, connected: true });
    expect((await alice.as.query(api.connections.list, {}))[0].usedAt).toBeGreaterThan(1);
  });

  test("another account cannot see or change a workspace", async () => {
    const t = fresh();
    const alice = await createUser(t, { isAnonymous: true });
    const bob = await createUser(t, { isAnonymous: true });
    const id = await alice.as.mutation(api.connections.add, {
      kind: "cloud",
      name: "Box",
      detail: "root@10.0.0.1",
    });

    expect(await bob.as.query(api.connections.list, {})).toEqual([]);
    await expect(
      bob.as.mutation(api.connections.rename, { id, name: "stolen" }),
    ).rejects.toThrow("Connection not found");
    await expect(
      bob.as.mutation(api.connections.setConnected, { id, connected: true }),
    ).rejects.toThrow("Connection not found");
    await expect(bob.as.mutation(api.connections.remove, { id })).rejects.toThrow(
      "Connection not found",
    );

    await alice.as.mutation(api.connections.rename, { id, name: "  Renamed  " });
    expect((await alice.as.query(api.connections.list, {}))[0].name).toBe("Renamed");
    await alice.as.mutation(api.connections.remove, { id });
    expect(await alice.as.query(api.connections.list, {})).toEqual([]);
  });
});

describe("settings", () => {
  test("null until something is saved", async () => {
    const t = fresh();
    expect(await t.query(api.settings.get, {})).toBeNull();
    const alice = await createUser(t, { isAnonymous: true });
    expect(await alice.as.query(api.settings.get, {})).toBeNull();
    await expect(t.mutation(api.settings.update, { theme: "light" })).rejects.toThrow(
      "Not signed in",
    );
  });

  test("update creates the row, then patches only what it is given", async () => {
    const t = fresh();
    const alice = await createUser(t, { isAnonymous: true });
    await alice.as.mutation(api.settings.update, { theme: "light", codeWrap: true });
    expect(await alice.as.query(api.settings.get, {})).toEqual({ theme: "light", codeWrap: true });

    await alice.as.mutation(api.settings.update, { density: 30 });
    expect(await alice.as.query(api.settings.get, {})).toEqual({
      theme: "light",
      codeWrap: true,
      density: 30,
    });
    expect(await t.run((ctx) => ctx.db.query("settings").collect())).toHaveLength(1);
  });

  test("density is clamped to the slider's range", async () => {
    const t = fresh();
    const alice = await createUser(t, { isAnonymous: true });
    await alice.as.mutation(api.settings.update, { density: 250 });
    expect((await alice.as.query(api.settings.get, {}))?.density).toBe(100);
    await alice.as.mutation(api.settings.update, { density: -5 });
    expect((await alice.as.query(api.settings.get, {}))?.density).toBe(0);
  });

  test("settings are private to the account that saved them", async () => {
    const t = fresh();
    const alice = await createUser(t, { isAnonymous: true });
    const bob = await createUser(t, { isAnonymous: true });
    await alice.as.mutation(api.settings.update, { theme: "light" });
    expect(await bob.as.query(api.settings.get, {})).toBeNull();
  });
});

describe("guest adoption", () => {
  test("workspaces and settings follow a guest into the account", async () => {
    const t = fresh();
    const { guestId, memberId, moved, duplicate } = await t.run(async (ctx) => {
      const guestId = await ctx.db.insert("users", { isAnonymous: true });
      const memberId = await ctx.db.insert("users", { email: "member@example.com" });
      const moved = await ctx.db.insert("connections", {
        userId: guestId,
        kind: "cloud",
        name: "Guest box",
        detail: "root@10.0.0.1",
        connected: false,
        usedAt: 1,
      });
      const duplicate = await ctx.db.insert("connections", {
        userId: guestId,
        kind: "repo",
        name: "Forge",
        detail: "xgamer791/forge-nexxus",
        connected: false,
        usedAt: 2,
      });
      await ctx.db.insert("connections", {
        userId: memberId,
        kind: "repo",
        name: "forge-nexxus",
        detail: "xgamer791/forge-nexxus",
        connected: true,
        usedAt: 3,
      });
      await ctx.db.insert("settings", { userId: guestId, theme: "light", density: 20 });
      return { guestId, memberId, moved, duplicate };
    });

    await t.mutation(internal.auth.adoptGuest, { guestId, userId: memberId });

    expect((await t.run((ctx) => ctx.db.get(moved)))?.userId).toBe(memberId);
    // The account already had that repo, so the guest's copy is dropped.
    expect(await t.run((ctx) => ctx.db.get(duplicate))).toBeNull();
    const settings = await t.run((ctx) => ctx.db.query("settings").collect());
    expect(settings).toHaveLength(1);
    expect(settings[0]).toMatchObject({ userId: memberId, theme: "light", density: 20 });
  });

  test("an account keeps the settings it already saved", async () => {
    const t = fresh();
    const { guestId, memberId } = await t.run(async (ctx) => {
      const guestId = await ctx.db.insert("users", { isAnonymous: true });
      const memberId = await ctx.db.insert("users", { email: "member@example.com" });
      await ctx.db.insert("settings", { userId: guestId, theme: "light" });
      await ctx.db.insert("settings", { userId: memberId, theme: "dark" });
      return { guestId, memberId };
    });

    await t.mutation(internal.auth.adoptGuest, { guestId, userId: memberId });

    const settings = await t.run((ctx) => ctx.db.query("settings").collect());
    expect(settings).toHaveLength(1);
    expect(settings[0]).toMatchObject({ userId: memberId, theme: "dark" });
  });
});
