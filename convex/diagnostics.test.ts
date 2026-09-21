/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { QUESTIONS } from "./onboardingQuestions";
import { REQUEST_COSTS, planFor } from "./plans";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");
const fresh = () => convexTest(schema, modules);

const KEY = "sk-test-secret-key";
const PAGE =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Bakery</title><style>body{margin:0}</style></head><body><main><h1>Bakery on Main</h1></main></body></html>';
const starter = planFor("starter");
const free = planFor("free");
const OPENING = (free.monthlyCredits ?? 0) + free.signupCredits + starter.monthlyCredits!;

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

async function createBuilder(t: ReturnType<typeof fresh>, email: string) {
  const member = await createUser(t, { email });
  await t.mutation(internal.billing.grantPlan, { userId: member.userId, plan: "starter" });
  return member;
}

async function seedBuiltSite(t: ReturnType<typeof fresh>, userId: Id<"users">) {
  return await t.run(async (ctx) => {
    const conversationId = await ctx.db.insert("conversations", {
      userId,
      title: "Bakery",
      updatedAt: Date.now(),
    });
    const siteId = await ctx.db.insert("sites", {
      userId,
      conversationId,
      name: "Bakery",
      status: "draft",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const versionId = await ctx.db.insert("siteVersions", {
      userId,
      siteId,
      html: PAGE,
      summary: "First",
      requestKind: "generate",
      createdAt: Date.now(),
    });
    await ctx.db.patch(siteId, { currentVersionId: versionId });
    return { siteId, conversationId };
  });
}

function stubProvider(respond: (body: unknown, call: number) => Response) {
  const calls: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)));
      return respond(JSON.parse(String(init.body)), calls.length);
    }),
  );
  return calls;
}

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
const reply = (summary: string, html = PAGE) =>
  json({ choices: [{ message: { content: `${summary}\n\n\`\`\`html\n${html}\n\`\`\`` } }] });

beforeEach(() => {
  process.env.AI_BASE_URL = "https://ai.example/v1/";
  process.env.AI_API_KEY = KEY;
  process.env.AI_MODEL = "forge-test";
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.AI_BASE_URL;
  delete process.env.AI_API_KEY;
  delete process.env.AI_MODEL;
});

describe("building-agent diagnostics", () => {
  test("a finished edit leaves a complete trace the member can read", async () => {
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    const { conversationId, siteId } = await seedBuiltSite(t, member.userId);
    stubProvider(() => reply("Added hours."));

    await member.as.action(api.generate.run, { conversationId, prompt: "Add opening hours" });
    // The answered turn reflects on itself afterwards; let it finish here rather than in the next test.
    await t.finishAllScheduledFunctions(() => {});

    const mine = await member.as.query(api.diagnostics.mine, {});
    expect(mine?.latest).toMatchObject({
      source: "generate",
      requestKind: "edit",
      status: "complete",
      siteId,
      conversationId,
      providerHost: "ai.example",
      providerModel: "forge-test",
      keySet: true,
      promptChars: "Add opening hours".length,
    });
    expect(mine?.latest?.creditsHeld).toBe(REQUEST_COSTS.edit);
    expect(mine?.latest?.htmlChars).toBe(PAGE.length);
    expect(mine?.events.map((event) => event.phase)).toEqual(
      expect.arrayContaining(["started", "held", "provider_request", "provider_response", "saving", "complete"]),
    );
    expect(mine?.events.some((event) => event.label === "Calling the model")).toBe(true);
    expect(JSON.stringify(mine)).not.toContain(KEY);
    expect(JSON.stringify(mine)).not.toContain("Add opening hours");

    const guest = await createUser(t, { isAnonymous: true });
    expect(await guest.as.query(api.diagnostics.mine, {})).toEqual({
      latest: null,
      active: null,
      events: [],
      recent: [],
    });
    expect(await t.query(api.diagnostics.mine, {})).toBeNull();
  });

  test("a provider failure records the status and never spends the hold", async () => {
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    const { conversationId } = await seedBuiltSite(t, member.userId);
    stubProvider(() => new Response(`upstream said no to ${KEY}`, { status: 502 }));

    await expect(
      member.as.action(api.generate.run, { conversationId, prompt: "Change the hero" }),
    ).rejects.toThrow("answered 502");

    const mine = await member.as.query(api.diagnostics.mine, {});
    expect(mine?.latest).toMatchObject({
      status: "failed",
      errorClass: "provider_http",
    });
    expect(mine?.latest?.error).toContain("answered 502");
    expect(mine?.latest?.error).not.toContain(KEY);
    expect(mine?.events.some((event) => event.detail?.httpStatus === 502)).toBe(true);
    expect(await member.as.query(api.billing.summary, {})).toMatchObject({
      credits: OPENING,
      reserved: 0,
    });
  });

  test("a first paid build refused for missing questions is visible as a failed run", async () => {
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    const { conversationId } = await member.as.mutation(api.sites.create, { name: "Bakery" });
    const calls = stubProvider(() => reply("never"));

    await expect(
      member.as.action(api.generate.run, { conversationId, prompt: "A bakery site" }),
    ).rejects.toThrow("questions");
    expect(calls).toHaveLength(0);

    const mine = await member.as.query(api.diagnostics.mine, {});
    expect(mine?.latest).toMatchObject({
      source: "generate",
      status: "failed",
      errorClass: "questions",
    });
    expect(mine?.events.some((event) => event.phase === "provider_request")).toBe(false);
  });

  test("a shrinking max_tokens cap cannot loop the provider call", async () => {
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    const { conversationId } = await seedBuiltSite(t, member.userId);
    let cap = 8000;
    const calls = stubProvider(() => {
      const status = new Response(`max_tokens must be in [1, ${cap}]`, { status: 400 });
      cap = Math.floor(cap / 2);
      return status;
    });

    await expect(
      member.as.action(api.generate.run, { conversationId, prompt: "Rewrite the page" }),
    ).rejects.toThrow("kept refusing");
    expect(calls.length).toBeLessThanOrEqual(5);
    expect(calls.length).toBeGreaterThan(1);

    const mine = await member.as.query(api.diagnostics.mine, {});
    expect(mine?.latest).toMatchObject({ status: "failed", errorClass: "provider_loop" });
    expect(mine?.events.filter((event) => event.phase === "provider_cap").length).toBeGreaterThan(0);
  });

  test("rebuild queues a diagnostic run before the agent starts", async () => {
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    const { conversationId, siteId } = await seedBuiltSite(t, member.userId);
    await t.run(async (ctx) => {
      await ctx.db.insert("siteOnboarding", {
        userId: member.userId,
        siteId,
        answers: QUESTIONS.map((_, i) => (i === 0 ? "Bakery" : i === 1 ? "Bread" : "")),
        step: 9,
        revision: 1,
        assets: [],
        status: "complete",
        attempt: 1,
        dismissed: true,
        events: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    await member.as.mutation(api.onboarding.rebuild, {});
    const mine = await member.as.query(api.diagnostics.mine, {});
    expect(mine?.active ?? mine?.latest).toMatchObject({
      source: "rebuild",
      status: "queued",
      siteId,
      conversationId,
      requestKind: "generate",
    });
    expect(mine?.events[0]).toMatchObject({ phase: "queued", label: "Build queued" });

    const inspected = await t.query(internal.diagnostics.inspectRecent, {});
    expect(inspected[0]).toMatchObject({
      email: "m@example.com",
      run: { source: "rebuild", status: "queued" },
    });
  });
});
