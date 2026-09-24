/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { crewCall, partReply } from "./crewMock";
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

// No choice of what visitors can do, so the site is the home page alone.
const ANSWERS = [
  "Harbor Roasters",
  "Small-batch coffee roasted on the pier, for neighbours and visitors in Port Ellen",
  "",
  "Pier Roast 250g — £11",
  "",
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

// The crew's builders, counted: a one-page site is one crew of four builders.
function stubProviders(t: T) {
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
// attempt is queued and its research and watchdog are scheduled.
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
  test("a dropped research is started again, once, and the build lands", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const t = makeTest();
    const count = stubProviders(t);
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
    expect(await jobs(t, "pending")).toEqual(["onboarding:research"]);
    expect((await row(t, id)).queueStep).toMatchObject({ attempt: 1, step: "research", restarts: 1 });
    // The attempt has just been heard from, so the next sweep leaves it.
    await t.mutation(internal.onboarding.rescue, {});
    expect(await jobs(t, "pending")).toEqual(["onboarding:research"]);
    await dropScheduled(t);
    vi.useRealTimers();

    // The restarted research, run as the scheduler would.
    await t.action(internal.onboarding.research, { id, attempt: 1 });
    await t.finishAllScheduledFunctions(() => {});
    const done = await row(t, id);
    expect(done.status).toBe("complete");
    expect(count).toEqual({ builds: 4 });
    const events = await t.run(async (ctx) => (await ctx.db.query("buildEvents").collect()).map((event) => event.phase));
    expect(events).toContain("rescued");
  });

  test("a build dropped after its research is started again as the build", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const t = makeTest();
    stubProviders(t);
    const { id } = await queued(t);
    await dropScheduled(t);
    await t.action(internal.onboarding.research, { id, attempt: 1 });
    expect(await jobs(t, "pending")).toEqual(["onboarding:build"]);
    await dropScheduled(t);

    await quietFor(t, id, 120);
    await t.mutation(internal.onboarding.rescue, {});
    expect(await jobs(t, "pending")).toEqual(["onboarding:build"]);
    expect((await row(t, id)).queueStep).toMatchObject({ step: "build", restarts: 1 });
  });

  test("an attempt that keeps losing its step stops, with nothing charged", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const t = makeTest();
    stubProviders(t);
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
  test("two researches for one attempt: one does the work and hands over once", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const t = makeTest();
    const count = stubProviders(t);
    const { id } = await queued(t);
    await dropScheduled(t);
    await Promise.all([
      t.action(internal.onboarding.research, { id, attempt: 1 }),
      t.action(internal.onboarding.research, { id, attempt: 1 }),
    ]);
    expect(await jobs(t, "pending")).toEqual(["onboarding:build"]);
    const after = await row(t, id);
    expect(after.status).toBe("queued");
    expect(after.queueStep).toMatchObject({ step: "build" });
    // A manual run once the attempt has moved on changes nothing.
    await t.action(internal.onboarding.research, { id, attempt: 1 });
    expect(await jobs(t, "pending")).toEqual(["onboarding:build"]);
    expect(count.builds).toBe(0);
  });

  test("a research that runs while another holds the step does nothing", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const t = makeTest();
    const count = stubProviders(t);
    const { id } = await queued(t);
    await dropScheduled(t);
    const held = await t.mutation(internal.onboarding.claimStep, { id, attempt: 1, step: "research" });
    expect(held).toEqual(expect.any(String));
    await t.action(internal.onboarding.research, { id, attempt: 1 });
    expect(count.builds).toBe(0);
    expect((await row(t, id)).queueStep?.lease).toBe(held);
    expect(await jobs(t, "pending")).toEqual([]);
  });

  test("a research that fails after losing its hold never ends the build", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const t = makeTest();
    stubProviders(t);
    const { id } = await queued(t);
    await dropScheduled(t);
    const research = (await t.mutation(internal.onboarding.claimStep, { id, attempt: 1, step: "research" }))!;
    expect(await t.mutation(internal.onboarding.researched, { id, attempt: 1, lease: research })).toBe(true);
    // A second copy of the research, and a second build, find the attempt taken.
    expect(await t.mutation(internal.onboarding.claimStep, { id, attempt: 1, step: "research" })).toBeNull();
    const build = (await t.mutation(internal.onboarding.claimStep, { id, attempt: 1, step: "build" }))!;
    expect(await t.mutation(internal.onboarding.claimStep, { id, attempt: 1, step: "build" })).toBeNull();
    expect(await t.mutation(internal.onboarding.checkpoint, { id, attempt: 1, lease: "someone-else" })).toBe(false);
    expect(await t.mutation(internal.onboarding.checkpoint, { id, attempt: 1, lease: build })).toBe(true);
    expect((await row(t, id)).status).toBe("building");

    // The stray research fails, the way tonight's did, while the build runs.
    const reason = "The sample business came back unreadable";
    expect(await t.mutation(internal.onboarding.stepFailed, { id, attempt: 1, step: "research", lease: research, reason })).toBe(false);
    expect(await t.mutation(internal.onboarding.stepFailed, { id, attempt: 1, step: "research", lease: build, reason })).toBe(false);
    await t.action(internal.onboarding.research, { id, attempt: 1 });
    const building = await row(t, id);
    expect(building.status).toBe("building");
    expect(building.error).toBeUndefined();

    // Only the build's own failure ends the attempt.
    expect(await t.mutation(internal.onboarding.stepFailed, { id, attempt: 1, step: "build", lease: build, reason: "The agent did not return a website" })).toBe(true);
    expect((await row(t, id)).status).toBe("failed");
  });

  test("a research that lost its hold hands nothing on to the build", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const t = makeTest();
    stubProviders(t);
    const { id } = await queued(t);
    await dropScheduled(t);
    const held = (await t.mutation(internal.onboarding.claimStep, { id, attempt: 1, step: "research" }))!;
    expect(await t.mutation(internal.onboarding.researched, { id, attempt: 1, lease: "lost-hold" })).toBe(false);
    expect(await jobs(t, "pending")).toEqual([]);
    expect(await t.mutation(internal.onboarding.researched, { id, attempt: 1, lease: held })).toBe(true);
    expect(await jobs(t, "pending")).toEqual(["onboarding:build"]);
  });
});
