/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob(["./**/*.*s", "!./remote.ts"]);
const fresh = () => convexTest(schema, modules);

async function createUser(t: ReturnType<typeof fresh>) {
  const { userId, sessionId } = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { isAnonymous: true });
    const sessionId = await ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 60_000,
    });
    return { userId, sessionId };
  });
  return { userId, as: t.withIdentity({ subject: `${userId}|${sessionId}` }) };
}

async function addServer(t: ReturnType<typeof fresh>, userId: Id<"users">) {
  return await t.run((ctx) =>
    ctx.db.insert("workspaces", {
      userId,
      name: "Chris Main Server",
      protocol: "ssh" as const,
      host: "138.197.83.241",
      port: 22,
      username: "master_cqjyrfdpcf",
      authKind: "password" as const,
      secret: "iv.tag.ciphertext",
      connected: true,
      createdAt: 1,
    }),
  );
}

describe("apps", () => {
  test("nothing is listed before a scan", async () => {
    const t = fresh();
    expect(await t.query(api.apps.list, {})).toEqual([]);
    const alice = await createUser(t);
    expect(await alice.as.query(api.apps.list, {})).toEqual([]);
  });

  test("a scan stores what the server reported, sorted by name", async () => {
    const t = fresh();
    const alice = await createUser(t);
    const server = await addServer(t, alice.userId);
    await t.mutation(internal.apps.replaceForWorkspace, {
      userId: alice.userId,
      workspaceId: server,
      found: [
        { name: "zeta", path: "/home/master_cqjyrfdpcf/applications/zeta/public_html" },
        { name: "alpha", path: "/home/master_cqjyrfdpcf/applications/alpha/public_html" },
      ],
    });
    const listed = await alice.as.query(api.apps.list, {});
    expect(listed.map((app) => app.name)).toEqual(["alpha", "zeta"]);
    expect(listed.every((app) => app.active === false)).toBe(true);
    expect(listed[0].scannedAt).toBeGreaterThan(0);
  });

  test("a rescan drops apps the server no longer reports and keeps the active one", async () => {
    const t = fresh();
    const alice = await createUser(t);
    const server = await addServer(t, alice.userId);
    const keptPath = "/home/master_cqjyrfdpcf/applications/keep/public_html";
    await t.mutation(internal.apps.replaceForWorkspace, {
      userId: alice.userId,
      workspaceId: server,
      found: [
        { name: "keep", path: keptPath },
        { name: "gone", path: "/home/master_cqjyrfdpcf/applications/gone/public_html" },
      ],
    });
    const keeper = (await alice.as.query(api.apps.list, {})).find((app) => app.name === "keep")!;
    await alice.as.mutation(api.apps.activate, { id: keeper._id });

    // The server is renamed and one app has been deleted since the last scan.
    await t.mutation(internal.apps.replaceForWorkspace, {
      userId: alice.userId,
      workspaceId: server,
      found: [{ name: "keep-renamed", path: keptPath }],
    });
    const after = await alice.as.query(api.apps.list, {});
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ _id: keeper._id, name: "keep-renamed", active: true });
  });

  test("one workspace is active: an app stands down the others and any repo", async () => {
    const t = fresh();
    const alice = await createUser(t);
    const server = await addServer(t, alice.userId);
    const repo = await alice.as.mutation(api.connections.add, {
      kind: "repo",
      name: "forge-nexxus",
      detail: "xgamer791/forge-nexxus",
    });
    await alice.as.mutation(api.connections.setConnected, { id: repo, connected: true });
    await t.mutation(internal.apps.replaceForWorkspace, {
      userId: alice.userId,
      workspaceId: server,
      found: [
        { name: "one", path: "/srv/one" },
        { name: "two", path: "/srv/two" },
      ],
    });
    const [one, two] = await alice.as.query(api.apps.list, {});

    await alice.as.mutation(api.apps.activate, { id: one._id });
    const activeNames = async () =>
      (await alice.as.query(api.apps.list, {})).filter((app) => app.active).map((app) => app.name);
    expect(await activeNames()).toEqual(["one"]);
    // Choosing an app stands the repo down.
    expect((await alice.as.query(api.connections.list, {}))[0].connected).toBe(false);

    await alice.as.mutation(api.apps.activate, { id: two._id });
    expect(await activeNames()).toEqual(["two"]);

    // And choosing the repo again stands the app down.
    await alice.as.mutation(api.connections.setConnected, { id: repo, connected: true });
    expect(await activeNames()).toEqual([]);
    expect((await alice.as.query(api.connections.list, {}))[0].connected).toBe(true);
  });

  test("clearActive leaves nothing active", async () => {
    const t = fresh();
    const alice = await createUser(t);
    const server = await addServer(t, alice.userId);
    await t.mutation(internal.apps.replaceForWorkspace, {
      userId: alice.userId,
      workspaceId: server,
      found: [{ name: "one", path: "/srv/one" }],
    });
    const [app] = await alice.as.query(api.apps.list, {});
    await alice.as.mutation(api.apps.activate, { id: app._id });
    await alice.as.mutation(api.apps.clearActive, {});
    expect((await alice.as.query(api.apps.list, {}))[0].active).toBe(false);
  });

  test("another account cannot see or activate an app", async () => {
    const t = fresh();
    const alice = await createUser(t);
    const bob = await createUser(t);
    const server = await addServer(t, alice.userId);
    await t.mutation(internal.apps.replaceForWorkspace, {
      userId: alice.userId,
      workspaceId: server,
      found: [{ name: "one", path: "/srv/one" }],
    });
    const [app] = await alice.as.query(api.apps.list, {});
    expect(await bob.as.query(api.apps.list, {})).toEqual([]);
    await expect(bob.as.mutation(api.apps.activate, { id: app._id })).rejects.toThrow(
      "App not found",
    );
  });
});
