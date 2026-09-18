/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob(["./**/*.*s", "!./remote.ts"]);
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

async function addWorkspace(
  t: ReturnType<typeof fresh>,
  userId: Id<"users">,
  fields: Partial<{ name: string; host: string; connected: boolean; createdAt: number }> = {},
) {
  return await t.run((ctx) =>
    ctx.db.insert("workspaces", {
      userId,
      name: fields.name ?? "Web server",
      protocol: "ssh" as const,
      host: fields.host ?? "10.0.0.1",
      port: 22,
      username: "root",
      authKind: "password" as const,
      secret: "iv.tag.ciphertext",
      connected: fields.connected ?? false,
      createdAt: fields.createdAt ?? 1,
    }),
  );
}

describe("workspaces", () => {
  test("nothing is listed until the account adds a server", async () => {
    const t = fresh();
    expect(await t.query(api.workspaces.list, {})).toEqual([]);
    const alice = await createUser(t, { isAnonymous: true });
    expect(await alice.as.query(api.workspaces.list, {})).toEqual([]);
  });

  test("the stored credential never reaches a client", async () => {
    const t = fresh();
    const alice = await createUser(t, { isAnonymous: true });
    await addWorkspace(t, alice.userId);
    const [listed] = await alice.as.query(api.workspaces.list, {});
    expect(listed).not.toHaveProperty("secret");
    expect(listed).not.toHaveProperty("userId");
    expect(JSON.stringify(listed)).not.toContain("ciphertext");
    expect(listed).toMatchObject({ name: "Web server", host: "10.0.0.1", port: 22 });
  });

  test("workspaces list in the order they were added", async () => {
    const t = fresh();
    const alice = await createUser(t, { isAnonymous: true });
    await addWorkspace(t, alice.userId, { name: "Second", createdAt: 2 });
    await addWorkspace(t, alice.userId, { name: "First", createdAt: 1 });
    expect((await alice.as.query(api.workspaces.list, {})).map((w) => w.name)).toEqual([
      "First",
      "Second",
    ]);
  });

  test("another account can neither see nor change a workspace", async () => {
    const t = fresh();
    const alice = await createUser(t, { isAnonymous: true });
    const bob = await createUser(t, { isAnonymous: true });
    const id = await addWorkspace(t, alice.userId);

    expect(await bob.as.query(api.workspaces.list, {})).toEqual([]);
    await expect(bob.as.mutation(api.workspaces.rename, { id, name: "stolen" })).rejects.toThrow(
      "Workspace not found",
    );
    await expect(bob.as.mutation(api.workspaces.remove, { id })).rejects.toThrow(
      "Workspace not found",
    );
    await expect(bob.as.mutation(api.workspaces.disconnect, { id })).rejects.toThrow(
      "Workspace not found",
    );
    await expect(
      bob.as.mutation(api.workspaces.setEnvironment, { id, environment: "dev" }),
    ).rejects.toThrow("Workspace not found");
  });

  test("rename trims, refuses blanks, and tagging round-trips", async () => {
    const t = fresh();
    const alice = await createUser(t, { isAnonymous: true });
    const id = await addWorkspace(t, alice.userId);
    await alice.as.mutation(api.workspaces.rename, { id, name: "  Chris ( Cloudways )  " });
    expect((await alice.as.query(api.workspaces.list, {}))[0].name).toBe("Chris ( Cloudways )");
    await expect(alice.as.mutation(api.workspaces.rename, { id, name: " " })).rejects.toThrow(
      "A workspace needs a name",
    );
    await alice.as.mutation(api.workspaces.setEnvironment, { id, environment: "production" });
    expect((await alice.as.query(api.workspaces.list, {}))[0].environment).toBe("production");
    await alice.as.mutation(api.workspaces.setEnvironment, { id, environment: undefined });
    expect((await alice.as.query(api.workspaces.list, {}))[0].environment).toBeUndefined();
  });

  test("one workspace is connected at a time, and a failure records why", async () => {
    const t = fresh();
    const alice = await createUser(t, { isAnonymous: true });
    const first = await addWorkspace(t, alice.userId, { name: "First", createdAt: 1 });
    const second = await addWorkspace(t, alice.userId, { name: "Second", createdAt: 2 });

    await t.mutation(internal.workspaces.markConnected, {
      id: first,
      userId: alice.userId,
      connected: true,
    });
    const connected = async () =>
      Object.fromEntries(
        (await alice.as.query(api.workspaces.list, {})).map((w) => [w.name, w.connected]),
      );
    expect(await connected()).toEqual({ First: true, Second: false });
    expect((await alice.as.query(api.workspaces.list, {}))[0].lastConnectedAt).toBeGreaterThan(0);

    await t.mutation(internal.workspaces.markConnected, {
      id: second,
      userId: alice.userId,
      connected: true,
    });
    expect(await connected()).toEqual({ First: false, Second: true });

    await t.mutation(internal.workspaces.markConnected, {
      id: second,
      userId: alice.userId,
      connected: false,
      error: "All configured authentication methods failed",
    });
    const [, failed] = await alice.as.query(api.workspaces.list, {});
    expect(failed.connected).toBe(false);
    expect(failed.lastError).toContain("authentication methods failed");
  });

  test("disconnecting only clears the local state", async () => {
    const t = fresh();
    const alice = await createUser(t, { isAnonymous: true });
    const id = await addWorkspace(t, alice.userId, { connected: true });
    await alice.as.mutation(api.workspaces.disconnect, { id });
    expect((await alice.as.query(api.workspaces.list, {}))[0].connected).toBe(false);
    // The credential survives a disconnect so reconnecting does not re-ask for it.
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({ secret: "iv.tag.ciphertext" });
  });

  test("a guest's servers follow them into the account they sign in to", async () => {
    const t = fresh();
    const { guestId, memberId } = await t.run(async (ctx) => {
      const guestId = await ctx.db.insert("users", { isAnonymous: true });
      const memberId = await ctx.db.insert("users", { email: "member@example.com" });
      return { guestId, memberId };
    });
    const id = await addWorkspace(t, guestId, { name: "Guest box" });

    await t.mutation(internal.auth.adoptGuest, { guestId, userId: memberId });

    expect((await t.run((ctx) => ctx.db.get(id)))?.userId).toBe(memberId);
    expect(await t.run((ctx) => ctx.db.get(guestId))).toBeNull();
  });

  test("removing a workspace deletes its stored credential with it", async () => {
    const t = fresh();
    const alice = await createUser(t, { isAnonymous: true });
    const id = await addWorkspace(t, alice.userId);
    await alice.as.mutation(api.workspaces.remove, { id });
    expect(await alice.as.query(api.workspaces.list, {})).toEqual([]);
    expect(await t.run((ctx) => ctx.db.get(id))).toBeNull();
  });
});
