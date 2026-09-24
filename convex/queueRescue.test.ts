/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { crewCall, partReply } from "./crewFixture";
import { QUESTION_SET, QUESTIONS } from "./onboardingQuestions";
import schema from "./schema";

// A queued build whose step the platform lost -- a deploy or a restart can
// drop a scheduled action -- is started again by the rescue, and a second copy
// of a step never runs beside the first or ends the attempt.
//
// Scheduled functions sit on setTimeout. With the timers faked they never run
// on their own, which is what a dropped job looks like; the clock stays real.
const modules = import.meta.glob("./**/*.*s");
function makeTest() {
  return convexTest(schema, modules);
}
type T = ReturnType<typeof makeTest>;

const ANSWERS = [
  "Harbor Roasters",
  "Small-batch coffee roasted on the pier",
  "Send you a message",
  "Pier Roast 250g — £11",
  "Neighbours and visitors in Port Ellen",
  "",
  "",
  "Warm and welcoming",
  "",
  "",
];
const PNG = btoa("not really a png, but bytes are bytes");
const json = (payload: unknown) => new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.AI_BASE_URL;
  delete process.env.AI_API_KEY;
  delete process.env.AI_MODEL;
  delete process.env.AI_IMAGE_API_KEY;
});

// The crew's builders, counted: a one-page site is one crew of four.
function stubProviders() {
  process.env.AI_BASE_URL = "https://api.deepseek.com/v1";
  process.env.AI_API_KEY = "sk-test-secret-key";
  process.env.AI_MODEL = "deepseek-flash";
  process.env.AI_IMAGE_API_KEY = "img-test-secret-key";
  const count = { builds: 0 };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (/generateContent/.test(url)) {
      return json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: PNG } }] } }] });
    }
    const body = JSON.parse(String(init.body));
    const system = body.messages.filter((m: any) => m.role === "system").map((m: any) => m.content).join("\n");
    if (/private website strategist/.test(system)) return json({ choices: [{ message: { content: "Lead with the roastery." } }] });
    if (/maintain Forge's memory/.test(system)) return json({ choices: [{ message: { content: '{"add":[],"forget":[],"replace":{}}' } }] });
    const call = crewCall(body);
    if (!call) throw new Error("A call no crew member made");
    count.builds += 1;
    return json({ choices: [{ message: { content: partReply(call) } }] });
  }));
  return count;
}

// A member with a paid plan and every question answered, submitted: the
// attempt is queued and its build and watchdog are scheduled.
async function queued(t: T) {
  const { userId, sessionId } = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email: "m@example.com" });
    const sessionId = await ctx.db.insert("authSessions", { userId, expirationTime: Date.now() + 60_000 });
    return { userId, sessionId };
  });
  await t.mutation(internal.billing.grantPlan, { userId, plan: "starter" });
  const member = t.withIdentity({ subject: `${userId}|${sessionId}` });
  const id = await member.mutation(api.onboarding.start, {});
  for (let index = 0; index < QUESTIONS.length; index += 1) {
    await member.mutation(api.onboarding.save, { id, index, answer: ANSWERS[index] ?? "", advance: true, questionSet: QUESTION_SET });
  }
  await member.mutation(api.onboarding.submit, { id });
  return { id, userId };
}

async function jobs(t: T, state?: string) {
  return await t.run(async (ctx) => {
    const all = await ctx.db.system.query("_scheduled_functions").collect();
    return all.filter((job) => !state || job.state.kind === state).map((job) => job.name);
  });
}

// What a deploy does to a scheduled job: it never runs.
async function dropScheduled(t: T) {
  await t.run(async (ctx) => {
    for (const job of await ctx.db.system.query("_scheduled_functions").collect()) {
      if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
    }
  });
}

// The attempt as it looks after `seconds` without a sign of life.
async function quietFor(t: T, id: Id<"siteOnboarding">, seconds: number) {
  await t.run(async (ctx) => {
    const row = (await ctx.db.get(id))!;
    const at = Date.now() - seconds * 1000;
    await ctx.db.patch(id, { updatedAt: at, ...(row.queueStep ? { queueStep: { ...row.queueStep, beatAt: at } } : {}) });
  });
}

const row = (t: T, id: Id<"siteOnboarding">) => t.run(async (ctx) => (await ctx.db.get(id))!);

describe("a queued build the platform lost", () => {
  test("a dropped build is started again, once, and the site lands", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const t = makeTest();
    const count = stubProviders();
    const { id } = await queued(t);
    await dropScheduled(t);
    vi.useRealTimers();
    expect(count.builds).toBe(0);

    // Nothing to rescue while the attempt is fresh.
    await t.mutation(internal.onboarding.rescue, {});
    expect(await jobs(t, "pending")).toEqual([]);

    await quietFor(t, id, 120);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await t.mutation(internal.onboarding.rescue, {});
    expect(await jobs(t, "pending")).toEqual(["onboarding:build"]);
    expect((await row(t, id)).queueStep).toMatchObject({ attempt: 1, step: "build", restarts: 1 });
    // The attempt has just been heard from, so the next sweep leaves it.
    await t.mutation(internal.onboarding.rescue, {});
    expect(await jobs(t, "pending")).toEqual(["onboarding:build"]);
    await dropScheduled(t);
    vi.useRealTimers();

    // The restarted build, run as the scheduler would.
    await t.action(internal.onboarding.build, { id, attempt: 1 });
    await t.finishAllScheduledFunctions(() => {});
    const done = await row(t, id);
    expect(done.status).toBe("complete");
    expect(count.builds).toBe(4);
    const events = await t.run(async (ctx) => (await ctx.db.query("buildEvents").collect()).map((event) => event.phase));
    expect(events).toContain("rescued");
    expect(events.some((phase) => phase.startsWith("research"))).toBe(false);
  });

  test("an attempt that keeps losing its step stops, with nothing charged", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const t = makeTest();
    stubProviders();
    const { id, userId } = await queued(t);
    await dropScheduled(t);
    for (let restart = 1; restart <= 3; restart += 1) {
      await quietFor(t, id, 120);
      await t.mutation(internal.onboarding.rescue, {});
      await dropScheduled(t);
    }
    expect((await row(t, id)).status).toBe("queued");
    await quietFor(t, id, 120);
    await t.mutation(internal.onboarding.rescue, {});
    const stopped = await row(t, id);
    expect(stopped.status).toBe("failed");
    expect(stopped.error).toBe("The build didn’t start, so no credits were used. Try building again. Your answers are saved.");
    const holds = await t.run(async (ctx) => await ctx.db.query("creditHolds").withIndex("by_user", (q) => q.eq("userId", userId)).collect());
    expect(holds).toEqual([]);
    expect(await jobs(t, "pending")).toEqual([]);
  });
});

describe("one copy of a step at a time", () => {
  test("two builds for one attempt: one does the work and the other stops", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const t = makeTest();
    const count = stubProviders();
    const { id } = await queued(t);
    await dropScheduled(t);
    await Promise.all([
      t.action(internal.onboarding.build, { id, attempt: 1 }),
      t.action(internal.onboarding.build, { id, attempt: 1 }),
    ]);
    expect(count.builds).toBe(0);
    expect(await jobs(t, "pending")).toEqual(["buildDraft:write"]);
    const after = await row(t, id);
    expect(after.status).toBe("building");
    expect(after.queueStep).toMatchObject({ step: "build" });
    // A manual run once the attempt has moved on changes nothing.
    await t.action(internal.onboarding.build, { id, attempt: 1 });
    expect(count.builds).toBe(0);
    expect(await jobs(t, "pending")).toEqual(["buildDraft:write"]);
  });

  test("a build that runs while another holds the step does nothing", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const t = makeTest();
    const count = stubProviders();
    const { id } = await queued(t);
    await dropScheduled(t);
    const held = await t.mutation(internal.onboarding.claimStep, { id, attempt: 1, step: "build" });
    expect(held).toEqual(expect.any(String));
    expect(await t.mutation(internal.onboarding.claimStep, { id, attempt: 1, step: "research" })).toBeNull();
    await t.action(internal.onboarding.build, { id, attempt: 1 });
    expect(count.builds).toBe(0);
    expect((await row(t, id)).queueStep?.lease).toBe(held);
    expect(await jobs(t, "pending")).toEqual([]);
  });

  test("a build that fails after losing its hold never ends the attempt", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const t = makeTest();
    stubProviders();
    const { id } = await queued(t);
    await dropScheduled(t);
    const build = (await t.mutation(internal.onboarding.claimStep, { id, attempt: 1, step: "build" }))!;
    expect(await t.mutation(internal.onboarding.claimStep, { id, attempt: 1, step: "build" })).toBeNull();
    expect(await t.mutation(internal.onboarding.checkpoint, { id, attempt: 1, lease: "someone-else" })).toBe(false);
    expect(await t.mutation(internal.onboarding.checkpoint, { id, attempt: 1, lease: build })).toBe(true);
    expect((await row(t, id)).status).toBe("building");

    // A copy that no longer holds the step cannot end the attempt.
    const reason = "The agent did not return a website";
    expect(await t.mutation(internal.onboarding.stepFailed, { id, attempt: 1, step: "build", lease: "lost-hold", reason })).toBe(false);
    await t.action(internal.onboarding.build, { id, attempt: 1 });
    const building = await row(t, id);
    expect(building.status).toBe("building");
    expect(building.error).toBeUndefined();

    // Only the build's own failure ends the attempt.
    expect(await t.mutation(internal.onboarding.stepFailed, { id, attempt: 1, step: "build", lease: build, reason })).toBe(true);
    expect((await row(t, id)).status).toBe("failed");
  });
});
