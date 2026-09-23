/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import { answerDesignResearch, DESIGN_PROMPT, DESIGN_REFERENCE_URL, resetDesignWorkerScript, setDesignWorkerScript, storeDesignPackage } from "./designWorkerMock";
import { assertDesignRules } from "./siteDesign";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

describe("saved design reference", () => {
  test("accepts only a package for the active site and build epoch", async () => {
    const t = convexTest(schema, modules);
    const { siteId, onboardingId, storageId } = await t.run(async ctx => {
      const userId = await ctx.db.insert("users", { email: "design@example.com" });
      const conversationId = await ctx.db.insert("conversations", { userId, title: "Test", updatedAt: Date.now() });
      const siteId = await ctx.db.insert("sites", {
        userId, conversationId, name: "Test", status: "draft", buildEpoch: 2,
        createdAt: Date.now(), updatedAt: Date.now(),
      });
      const onboardingId = await ctx.db.insert("siteOnboarding", {
        userId, siteId, answers: ["Test", "Bakery"], step: 10, revision: 1,
        assets: [], status: "queued", attempt: 1, dismissed: false, events: [],
        createdAt: Date.now(), updatedAt: Date.now(),
      });
      const storageId = await ctx.storage.store(new Blob(["reference package"]));
      return { siteId, onboardingId, storageId };
    });
    const args = {
      siteId, onboardingId, attempt: 1, epoch: 2, storageId,
      referenceUrl: "https://example.com/", prompt: "Original design structure", inspectedPages: 6,
    };
    expect(await t.mutation(internal.siteDesign.save, { ...args, epoch: 1 })).toBe(false);
    expect(await t.mutation(internal.siteDesign.save, args)).toBe(true);
    expect(await t.query(internal.siteDesign.forSite, { siteId })).toMatchObject({
      storageId, prompt: "Original design structure", inspectedPages: 6, buildEpoch: 2,
    });
    await t.run(async ctx => { await ctx.db.patch(siteId, { buildEpoch: 3 }); });
    expect(await t.mutation(internal.siteDesign.save, args)).toBe(false);
  });

  test("rejects reference assets and non-Fontshare font URLs in built pages", () => {
    assertDesignRules({ html: '<a href="/about">About</a><img src="forge-image:1">' }, "https://reference.example.com");
    expect(() => assertDesignRules({ html: '<img src="https://reference.example.com/a.jpg">' },
      "https://reference.example.com")).toThrow(/reference/);
    expect(() => assertDesignRules({ html: '<link href="https://fonts.googleapis.com/css2">' },
      "https://reference.example.com")).toThrow(/Fontshare/);
  });
});

const modulesForResearch = import.meta.glob("./**/*.*s");

function stubWorker(t: ReturnType<typeof convexTest>, calls: string[]) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(url);
    const research = await answerDesignResearch(url, init, () => storeDesignPackage(t));
    if (!research) throw new Error(`Unexpected fetch ${url}`);
    return research;
  }));
}

async function queuedResearch(t: ReturnType<typeof convexTest>) {
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email: "research@example.com" });
    const conversationId = await ctx.db.insert("conversations", { userId, title: "Test", updatedAt: Date.now() });
    const siteId = await ctx.db.insert("sites", {
      userId, conversationId, name: "Harbor", status: "draft",
      createdAt: Date.now(), updatedAt: Date.now(),
    });
    const id = await ctx.db.insert("siteOnboarding", {
      userId, siteId, answers: ["Harbor", "Coffee roasted on the pier", "", "", "", "", "Warm", "", ""],
      step: 10, revision: 1, assets: [], status: "queued", attempt: 1, dismissed: false, events: [],
      createdAt: Date.now(), updatedAt: Date.now(),
    });
    await ctx.db.insert("buildRuns", {
      userId, source: "onboarding", status: "queued", siteId, onboardingId: id, attempt: 1,
      requestKind: "generate", startedAt: Date.now(), updatedAt: Date.now(),
    });
    return { id, siteId };
  });
  return ids;
}

describe("measured design research", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetDesignWorkerScript();
    process.env.DESIGN_WORKER_URL = "https://design-worker.test";
    process.env.DESIGN_WORKER_TOKEN = "test-design-worker-token";
  });

  test("a worker stream is saved as the site's package and the build is queued", async () => {
    const t = convexTest(schema, modulesForResearch);
    const calls: string[] = [];
    stubWorker(t, calls);
    const { id, siteId } = await queuedResearch(t);
    await t.action(internal.onboarding.research, { id, attempt: 1 });
    expect(calls).toEqual(["https://design-worker.test/research"]);
    expect(await t.query(internal.siteDesign.forSite, { siteId })).toMatchObject({
      referenceUrl: DESIGN_REFERENCE_URL, prompt: DESIGN_PROMPT, inspectedPages: 2, buildEpoch: 0,
    });
    const events = await t.run((ctx) => ctx.db.query("buildEvents").collect());
    expect(events.map((event) => event.phase)).toEqual(expect.arrayContaining([
      "research", "research_searching", "research_inspecting", "research_measuring", "research_done",
    ]));
    const jobs = await t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).map((job) => job.name));
    expect(jobs).toContain("onboarding:build");
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({ status: "queued" });
  });

  test("a missing worker fails closed and never calls fetch", async () => {
    const t = convexTest(schema, modulesForResearch);
    delete process.env.DESIGN_WORKER_URL;
    delete process.env.DESIGN_WORKER_TOKEN;
    const fetched = vi.fn();
    vi.stubGlobal("fetch", fetched);
    const { id, siteId } = await queuedResearch(t);
    await t.action(internal.onboarding.research, { id, attempt: 1 });
    expect(fetched).not.toHaveBeenCalled();
    expect(await t.query(internal.siteDesign.forSite, { siteId })).toBeNull();
    const row = (await t.run((ctx) => ctx.db.get(id)))!;
    expect(row.status).toBe("failed");
    expect(row.error).toContain("Design research is not configured");
  });

  test("an unauthorized worker fails the research and saves nothing", async () => {
    const t = convexTest(schema, modulesForResearch);
    setDesignWorkerScript("unauthorized");
    stubWorker(t, []);
    const { id, siteId } = await queuedResearch(t);
    await t.action(internal.onboarding.research, { id, attempt: 1 });
    expect(await t.query(internal.siteDesign.forSite, { siteId })).toBeNull();
    expect((await t.run((ctx) => ctx.db.get(id)))!.error).toContain("answered 401");
  });

  test("a worker error is the member's failure, not a build", async () => {
    const t = convexTest(schema, modulesForResearch);
    setDesignWorkerScript("error");
    stubWorker(t, []);
    const { id } = await queuedResearch(t);
    await t.action(internal.onboarding.research, { id, attempt: 1 });
    expect((await t.run((ctx) => ctx.db.get(id)))!.error).toContain("No reference site could be inspected");
    const jobs = await t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).map((job) => job.name));
    expect(jobs).not.toContain("onboarding:build");
  });
});
