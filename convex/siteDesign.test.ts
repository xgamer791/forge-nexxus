/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import {
  answerDesignResearch, DESIGN_FOUNDATION, DESIGN_PROMPT, DESIGN_REFERENCE_URL, resetDesignRoutes, resetDesignWorkerScript,
  setDesignRoutes, setDesignWorkerScript, storeDesignPackage,
} from "./designWorkerMock";
import { assertDesignRules, isSkillUI } from "./siteDesign";
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
      referenceUrl: "https://example.com/", prompt: "Original design structure", inspectedPages: 6, routes: ["/"],
    };
    expect(await t.mutation(internal.siteDesign.save, { ...args, epoch: 1 })).toBe(false);
    expect(await t.mutation(internal.siteDesign.save, args)).toBe(true);
    const saved = await t.query(internal.siteDesign.forSite, { siteId });
    expect(saved).toMatchObject({
      storageId, prompt: "Original design structure", inspectedPages: 6, buildEpoch: 2, format: "skillui-ultra-v1", routes: ["/"],
    });
    expect(isSkillUI(saved)).toBe(true);
    expect(isSkillUI({ format: "forge-measured-v1" })).toBe(false);
    expect(isSkillUI({ format: undefined })).toBe(false);
    await t.run(async ctx => { await ctx.db.patch(siteId, { buildEpoch: 3 }); });
    expect(await t.mutation(internal.siteDesign.save, args)).toBe(false);
  });

  test("keeps five pages at most, the home page first, and refuses a package without one", async () => {
    const t = convexTest(schema, modules);
    const { siteId, onboardingId, storageId } = await t.run(async ctx => {
      const userId = await ctx.db.insert("users", { email: "cap@example.com" });
      const conversationId = await ctx.db.insert("conversations", { userId, title: "Cap", updatedAt: Date.now() });
      const siteId = await ctx.db.insert("sites", { userId, conversationId, name: "Cap", status: "draft", createdAt: Date.now(), updatedAt: Date.now() });
      const onboardingId = await ctx.db.insert("siteOnboarding", {
        userId, siteId, answers: ["Cap", "Tacos"], step: 10, revision: 1,
        assets: [], status: "queued", attempt: 1, dismissed: false, events: [], createdAt: Date.now(), updatedAt: Date.now(),
      });
      return { siteId, onboardingId, storageId: await ctx.storage.store(new Blob(["PK"])) };
    });
    const args = {
      siteId, onboardingId, attempt: 1, epoch: 0, storageId, referenceUrl: "https://example.com/", prompt: "Extract",
      inspectedPages: 7, foundation: ":root{--color-ink:#111}",
    };
    expect(await t.mutation(internal.siteDesign.save, { ...args, routes: ["/menu", "/about"] })).toBe(false);
    expect(await t.mutation(internal.siteDesign.save, {
      ...args, routes: ["/food-menu", "/", "/drink-menu", "/specials", "/events", "/party", "/cater"],
    })).toBe(true);
    expect(await t.query(internal.siteDesign.forSite, { siteId })).toMatchObject({
      routes: ["/", "/food-menu", "/drink-menu", "/specials", "/events"],
      foundation: ":root{--color-ink:#111}",
    });
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

describe("SkillUI Ultra design research", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetDesignWorkerScript();
    resetDesignRoutes();
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
      referenceUrl: DESIGN_REFERENCE_URL, prompt: DESIGN_PROMPT, inspectedPages: 1, buildEpoch: 0,
      format: "skillui-ultra-v1", foundation: DESIGN_FOUNDATION, routes: ["/"],
    });
    const events = await t.run((ctx) => ctx.db.query("buildEvents").collect());
    expect(events.map((event) => event.phase)).toEqual(expect.arrayContaining([
      "research", "research_searching", "research_candidate", "research_discovering", "research_skillui", "research_uploading", "research_done",
    ]));
    expect(events.find((event) => event.phase === "research_skillui")).toMatchObject({
      label: "Reading the reference's design with SkillUI Ultra, 1 screen",
      detail: { mode: "ultra", screens: 1 },
    });
    const jobs = await t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).map((job) => job.name));
    expect(jobs).toContain("onboarding:build");
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({ status: "queued" });
  });

  test("the pages the worker discovers are capped at five before anything is built from them", async () => {
    const t = convexTest(schema, modulesForResearch);
    setDesignRoutes(["/", "/food-menu", "/drink-menu", "/specials", "/events", "/party", "/cater"]);
    stubWorker(t, []);
    const { id, siteId } = await queuedResearch(t);
    await t.action(internal.onboarding.research, { id, attempt: 1 });
    expect((await t.query(internal.siteDesign.forSite, { siteId }))?.routes).toEqual(["/", "/food-menu", "/drink-menu", "/specials", "/events"]);
    const events = await t.run((ctx) => ctx.db.query("buildEvents").collect());
    expect(events.find((event) => event.phase === "research_discovering")?.label).toBe("Chose 5 pages from the reference");
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
