/// <reference types="vite/client" />
import { readFileSync } from "node:fs";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { DESIGN_GOD } from "./designgod";
import { FED } from "./fed";
import { FORGE_MD } from "./forgeMd";
import { QUESTIONS } from "./onboardingQuestions";
import { REQUEST_COSTS, planFor } from "./plans";
import schema from "./schema";

// The whole building agent, start to finish: the questions, the scheduled
// build, the model, the pictures, the save, the address. Nothing is seeded
// past what a member does; the scheduler runs for real.
const modules = import.meta.glob("./**/*.*s");
const fresh = () => convexTest(schema, modules);
type T = ReturnType<typeof fresh>;

async function createUser(t: T, fields: { isAnonymous?: boolean; email?: string }) {
  const { userId, sessionId } = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", fields);
    const sessionId = await ctx.db.insert("authSessions", { userId, expirationTime: Date.now() + 60_000 });
    return { userId, sessionId };
  });
  return { userId, as: t.withIdentity({ subject: `${userId}|${sessionId}` }) };
}

async function createBuilder(t: T, email: string) {
  const member = await createUser(t, { email });
  await t.mutation(internal.billing.grantPlan, { userId: member.userId, plan: "starter" });
  return member;
}

const free = planFor("free");
const starter = planFor("starter");
const OPENING = (free.monthlyCredits ?? 0) + free.signupCredits + starter.monthlyCredits!;
const KEY = "sk-test-secret-key";
const IMAGE_KEY = "img-test-secret-key";
const ANSWERS = [
  "Harbor Roasters",
  "Small-batch coffee roasted on the pier",
  "Neighbours and visitors in Port Ellen",
  "Contact you",
  "",
  "Collect inquiries",
  "Warm and welcoming",
  "",
  "",
  "",
  "Pier Roast 250g — £11\nDecaf Harbour 250g — £12\nSubscription, a bag a fortnight — £20 a month",
];

const page = (title: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><style>body{margin:0}</style></head>` +
  `<body><header><h1>${title}</h1></header><main><img src="forge-image:1" data-forge-image="Morning light on the roastery counter" ` +
  `data-forge-aspect="16:9" alt="The roastery counter" width="1600" height="900"></main></body></html>`;
const PNG = btoa("not really a png, but bytes are bytes");

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
// A reply as a provider streams it: the events as given, then the connection closes.
const streamed = (...events: string[]) =>
  new Response(new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(new TextEncoder().encode(event));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
const delta = (fields: Record<string, unknown>, finish: string | null = null) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: fields, finish_reason: finish }] })}\n\n`;

type Call = { url: string; body: any };

// One fetch for both providers. The strategist and the builder are told apart
// by what they were asked; `build` is how the page answers, once per build.
function stubProviders(build: (call: number) => Response) {
  const calls: Call[] = [];
  let builds = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push({ url, body });
      if (/generateContent/.test(url)) {
        return json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: PNG } }] } }] });
      }
      const system = body.messages.filter((m: any) => m.role === "system").map((m: any) => m.content).join("\n");
      if (/private website strategist/.test(system)) {
        return json({ choices: [{ message: { content: "Lead with the roastery. Warm palette, one clear call." } }] });
      }
      builds += 1;
      return build(builds);
    }),
  );
  return { calls, builds: () => builds, chatCalls: () => calls.filter((call) => /chat\/completions/.test(call.url)) };
}

const built = (title: string) =>
  json({ choices: [{ message: { content: `Built a warm page for ${title}.\n\n\`\`\`html\n${page(title)}\n\`\`\`` } }] });

async function answerEverything(member: Awaited<ReturnType<typeof createBuilder>>) {
  const id = await member.as.mutation(api.onboarding.start, {});
  for (let index = 0; index < QUESTIONS.length; index += 1) {
    await member.as.mutation(api.onboarding.save, { id, index, answer: ANSWERS[index], advance: true });
  }
  return id;
}

// Everything the scheduler holds runs here, the way it would on Convex. The
// watchdogs sit minutes out on the real clock, so they stay pending; they are
// fired by hand below to prove they change nothing once a build has landed.
const drain = (t: T) => t.finishAllScheduledFunctions(() => {});

async function scheduled(t: T) {
  return await t.run(async (ctx) => {
    const jobs = await ctx.db.system.query("_scheduled_functions").collect();
    return jobs.map((job) => ({ name: job.name, state: job.state.kind, args: job.args[0] }));
  });
}

async function holds(t: T) {
  return await t.run(async (ctx) => (await ctx.db.query("creditHolds").collect()).map((hold) => [hold.requestKind, hold.status]));
}

async function versions(t: T) {
  return await t.run((ctx) => ctx.db.query("siteVersions").collect());
}

beforeEach(() => {
  process.env.AI_BASE_URL = "https://ai.example/v1/";
  process.env.AI_API_KEY = KEY;
  process.env.AI_MODEL = "forge-test";
  process.env.AI_IMAGE_API_KEY = IMAGE_KEY;
  process.env.CONVEX_SITE_URL = "https://forge-test.convex.site";
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.AI_BASE_URL;
  delete process.env.AI_API_KEY;
  delete process.env.AI_MODEL;
  delete process.env.AI_BUILD_MODEL;
  delete process.env.AI_BUILD_BASE_URL;
  delete process.env.AI_BUILD_API_KEY;
  delete process.env.AI_REASONING_EFFORT;
  delete process.env.AI_MAX_TOKENS;
  delete process.env.AI_IMAGE_API_KEY;
  delete process.env.CONVEX_SITE_URL;
});

describe("a brand new build, start to finish", () => {
  test("the answers become a published site, the credits settle, and nothing is left running", async () => {
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    const providers = stubProviders(() => built("Harbor Roasters"));

    const id = await answerEverything(member);
    await member.as.mutation(api.onboarding.submit, { id });
    // A second press while the build is queued must not queue a second build.
    await member.as.mutation(api.onboarding.submit, { id });
    const queued = await scheduled(t);
    expect(queued.filter((job) => job.name === "onboarding:build")).toHaveLength(1);
    expect(queued.filter((job) => job.name === "onboarding:expire")).toHaveLength(1);

    await drain(t);

    // Exactly one build ran, and it asked the model once.
    expect(providers.builds()).toBe(1);
    const brief = (await t.run((ctx) => ctx.db.get(id)))!;
    expect(brief).toMatchObject({ status: "complete", attempt: 1, dismissed: false });
    expect(brief.error).toBeUndefined();
    expect(brief.events.map((event) => event.label)).toEqual([
      "Answers submitted",
      "Build brief saved and read",
      "Agent started building your website",
      "Page written",
      "Pictures made for your site",
      "Website received from the agent",
      "Website saved and ready",
    ]);

    // The build was made from the saved brief, not a client prompt.
    const buildCall = providers.chatCalls().find((call) => call.body.messages.some((m: any) => /website-build-brief\.md/.test(m.content)))!;
    expect(buildCall).toBeDefined();
    expect(buildCall.body.model).toBe("forge-test");
    const briefText = buildCall.body.messages.at(-1).content;
    expect(briefText).toContain("Harbor Roasters");
    expect(briefText).toContain("Small-batch coffee roasted on the pier");
    // The catalogue is what a products section is built from, so it has to
    // survive the trip from the last question into the brief file.
    expect(briefText).toContain("What do you sell, and what does it cost?");
    expect(briefText).toContain("Pier Roast 250g — £11");

    // One version, with the picture made and stored in place of the request.
    const [version] = await versions(t);
    expect(await versions(t)).toHaveLength(1);
    expect(version.html).not.toContain("forge-image:");
    expect(version.html).toContain('<h1>Harbor Roasters</h1>');
    const images = await t.run((ctx) => ctx.db.query("siteImages").collect());
    expect(images).toHaveLength(1);
    expect(version.html).toContain(await t.run((ctx) => ctx.storage.getUrl(images[0].storageId)));

    // The site is saved and published at its Forge address. The thread keeps the
    // summary and does not repeat the address above the prompt.
    const site = (await t.run((ctx) => ctx.db.get(brief.siteId!)))!;
    expect(site).toMatchObject({ name: "Harbor Roasters", status: "published", currentVersionId: version._id, publishedVersionId: version._id });
    expect(site.slug).toBeTruthy();
    const messages = await t.run((ctx) => ctx.db.query("messages").collect());
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: "assistant", versionId: version._id });
    expect(messages[0].status).toBeUndefined();
    expect(messages[0].body).toBe("Built a warm page for Harbor Roasters.");

    // Superseded answer snapshots never reserve credits. The newest strategy,
    // the build and the picture are the only work that runs after this drain.
    expect((await holds(t)).every(([, status]) => status === "settled")).toBe(true);
    expect((await holds(t)).filter(([kind]) => kind === "chat")).toHaveLength(1);
    expect(await member.as.query(api.billing.summary, {})).toMatchObject({
      reserved: 0,
      credits: OPENING - REQUEST_COSTS.generate - REQUEST_COSTS.image - REQUEST_COSTS.chat,
    });

    // The run is closed, and the log reads as a finished build.
    const runs = await t.run((ctx) => ctx.db.query("buildRuns").collect());
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ source: "onboarding", status: "complete", attempt: 1, keySet: true, providerHost: "ai.example", imageWanted: 1, imageMade: 1 });
    expect(runs[0].endedAt).toBeDefined();
    const events = await t.run((ctx) => ctx.db.query("buildEvents").collect());
    expect(events.map((event) => event.phase)).toEqual(
      expect.arrayContaining(["queued", "held", "provider_request", "provider_response", "images", "images_done", "saving", "complete"]),
    );

    // The member lands on the finished screen, with Rebuild on offer.
    expect(await member.as.query(api.onboarding.state, {})).toMatchObject({
      required: false,
      hasWebsite: true,
      canRebuild: true,
      draft: expect.objectContaining({ id, status: "complete" }),
    });

    // Only the watchdog is still on the clock, and it is a no-op now.
    const left = await scheduled(t);
    expect(left.filter((job) => job.state !== "success").map((job) => job.name)).toEqual(["onboarding:expire"]);
    await t.mutation(internal.onboarding.expire, { id, attempt: 1 });
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({ status: "complete" });
    expect((await holds(t)).every(([, status]) => status === "settled")).toBe(true);
    expect(await versions(t)).toHaveLength(1);
  });

  test("a reply that keeps dropping fails the build once, says why, and the next press builds", async () => {
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    let dropping = true;
    // The provider starts thinking, then the connection goes before the reply
    // is finished -- the stream stopping, which is what a stall is here.
    const providers = stubProviders(() =>
      dropping ? streamed(": keep-alive\n\n", delta({ reasoning_content: "Planning the roastery page." })) : built("Harbor Roasters"));

    const id = await answerEverything(member);
    await member.as.mutation(api.onboarding.submit, { id });
    await drain(t);

    // One fresh go after the first drop, and then the build says why.
    expect(providers.builds()).toBe(2);
    const failed = (await t.run((ctx) => ctx.db.get(id)))!;
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("The connection to the model dropped before it started writing your website");
    expect(failed.error).toContain("Your answers are saved");
    expect(failed.error).not.toMatch(/too long|seconds|minutes/);
    expect(failed.holdId).toBeUndefined();
    expect((await holds(t)).filter(([kind]) => kind === "generate")).toEqual([["generate", "released"]]);
    expect(await versions(t)).toEqual([]);
    const [run] = await t.run((ctx) => ctx.db.query("buildRuns").collect());
    expect(run).toMatchObject({ status: "failed", errorClass: "stream_dropped", attempt: 1 });
    // The debugger kept where each reply had got to when it stopped.
    const events = await t.run((ctx) => ctx.db.query("buildEvents").withIndex("by_run_at", (q) => q.eq("runId", run._id)).collect());
    const stops = events.filter((event) => event.phase === "provider_stop");
    expect(stops).toHaveLength(2);
    for (const stop of stops) {
      expect(stop.detail).toMatchObject({ stream: true, stopReason: "dropped", streamPhase: "thinking", keepAlives: 1, reasoningChars: "Planning the roastery page.".length });
    }
    expect(events.filter((event) => event.phase === "provider_retry")).toHaveLength(1);
    expect(await member.as.query(api.onboarding.state, {})).toMatchObject({
      hasWebsite: false,
      draft: expect.objectContaining({ id, status: "failed" }),
    });

    // Nothing re-queues on its own: the failed attempt leaves no build behind.
    expect((await scheduled(t)).filter((job) => job.name === "onboarding:build" && job.state !== "success")).toEqual([]);

    // Try building again is one more attempt, not a loop.
    dropping = false;
    await member.as.mutation(api.onboarding.submit, { id });
    await drain(t);
    expect(providers.builds()).toBe(3);
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({ status: "complete", attempt: 2 });
    expect(await versions(t)).toHaveLength(1);
    const runs = await t.run((ctx) => ctx.db.query("buildRuns").collect());
    expect(runs.map((row) => [row.attempt, row.status])).toEqual([[1, "failed"], [2, "complete"]]);
    expect(await member.as.query(api.billing.summary, {})).toMatchObject({ reserved: 0 });
  });

  test("a deployment can send builds to a stronger model than chat", async () => {
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    const providers = stubProviders(() => built("Harbor Roasters"));
    process.env.AI_BUILD_MODEL = "forge-test-large";

    const id = await answerEverything(member);
    await member.as.mutation(api.onboarding.submit, { id });
    await drain(t);

    // Planning and writing the site share the build model. Chat stays on the
    // cheaper one, which these passes never call.
    const calls = providers.chatCalls();
    const build = calls.find((call) => call.body.messages.some((m: any) => /website-build-brief\.md/.test(m.content)))!;
    expect(build.body.model).toBe("forge-test-large");
    // A build's own ceiling: room for a site in pages and for the thinking a
    // reasoning model bills inside the same budget.
    expect(build.body.max_tokens).toBe(96000);
    const strategy = calls.find((call) => /private website strategist/.test(JSON.stringify(call.body.messages)))!;
    expect(strategy.body.model).toBe("forge-test-large");
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({ status: "complete" });

    // Unset, a build runs on exactly the model chat does.
    delete process.env.AI_BUILD_MODEL;
    const plain = await createBuilder(t, "p@example.com");
    const second = await answerEverything(plain);
    await plain.as.mutation(api.onboarding.submit, { id: second });
    await drain(t);
    expect(providers.chatCalls().at(-1)!.body.model).toBe("forge-test");
  });

  test("the deployment's own settings put text on DeepSeek v4.1 Flash and pictures on Nano Banana 2 Lite", async () => {
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    const providers = stubProviders(() => built("Harbor Roasters"));
    // The chat route, with planning and the build left unset so they inherit it.
    process.env.AI_BASE_URL = "https://api.deepseek.com/v1";
    process.env.AI_MODEL = "deepseek-flash";
    process.env.AI_IMAGE_MODEL = "gemini-3.1-flash-lite-image";
    delete process.env.AI_BUILD_MODEL;
    process.env.AI_REASONING_EFFORT = "high";

    const id = await answerEverything(member);
    await member.as.mutation(api.onboarding.submit, { id });
    await drain(t);

    // The words: every chat and build turn on DeepSeek's OpenAI-compatible path,
    // each asking to think at the level AI_REASONING_EFFORT names — one value,
    // every turn, because a level the operator sets is not a default to split.
    // Temperature is not sent at all: this model documents it as inert while
    // thinking is on, and thinking is on by default.
    const chat = providers.chatCalls();
    expect(chat.length).toBeGreaterThan(0);
    for (const call of chat) {
      expect(call.url).toBe("https://api.deepseek.com/v1/chat/completions");
      expect(call.body.model).toBe("deepseek-flash");
      expect(call.body.reasoning_effort).toBe("high");
      expect(call.body.thinking).toEqual({ type: "enabled" });
      expect(call.body.temperature).toBeUndefined();
    }

    // The pictures: their own native route, their own model, never the chat one.
    const images = providers.calls.filter((call) => /generateContent/.test(call.url));
    expect(images.length).toBeGreaterThan(0);
    for (const call of images) {
      expect(call.url).toBe(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-image:generateContent",
      );
      expect(call.body.model).toBeUndefined();
    }

    // And what the agent is told to say about itself matches both. The build
    // contract carries that line; the strategy passes before it do not.
    const identity = chat
      .flatMap((call) => call.body.messages.filter((m: any) => m.role === "system").map((m: any) => m.content))
      .find((c: string) => /IDENTITY/.test(c))!;
    expect(identity).toBeDefined();
    expect(identity).toContain("this turn runs on DeepSeek v4.1 Flash");
    expect(identity).toContain("made by Gemini Nano Banana 2 Lite");

    // The build landed.
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({ status: "complete" });
    expect(await versions(t)).toHaveLength(1);
    expect((await versions(t))[0].html).not.toContain("forge-image:");
  });

  test("pointing chat at Gemini still sends high effort and keeps pictures on Lite", async () => {
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    const providers = stubProviders(() => built("Harbor Roasters"));
    process.env.AI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
    process.env.AI_MODEL = "gemini-3.8-flash";
    process.env.AI_IMAGE_MODEL = "gemini-3.1-flash-lite-image";
    delete process.env.AI_BUILD_MODEL;
    delete process.env.AI_REASONING_EFFORT;

    const id = await answerEverything(member);
    await member.as.mutation(api.onboarding.submit, { id });
    await drain(t);

    const chat = providers.chatCalls();
    expect(chat.length).toBeGreaterThan(0);
    for (const call of chat) {
      expect(call.url).toBe("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
      expect(call.body.model).toBe("gemini-3.8-flash");
      expect(call.body.reasoning_effort).toBe("high");
    }

    const images = providers.calls.filter((call) => /generateContent/.test(call.url));
    expect(images.length).toBeGreaterThan(0);
    for (const call of images) {
      expect(call.url).toBe(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-image:generateContent",
      );
    }

    const identity = chat
      .flatMap((call) => call.body.messages.filter((m: any) => m.role === "system").map((m: any) => m.content))
      .find((c: string) => /IDENTITY/.test(c))!;
    expect(identity).toContain("this turn runs on gemini-3.8-flash");
    expect(identity).toContain("made by Gemini Nano Banana 2 Lite");
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({ status: "complete" });
  });

  test("a provider that refuses the model is not retried, and the refusal is readable without the key", async () => {
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    const providers = stubProviders(() =>
      new Response(JSON.stringify({ error: { message: `Model Not Exist (key ${KEY})`, type: "invalid_request_error" } }), { status: 400 }),
    );

    const id = await answerEverything(member);
    await member.as.mutation(api.onboarding.submit, { id });
    await drain(t);

    expect(providers.builds()).toBe(1);
    const failed = (await t.run((ctx) => ctx.db.get(id)))!;
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("answered 400");
    expect(failed.error).toContain("Model Not Exist");
    expect(failed.error).toContain("[key]");
    expect(failed.error).not.toContain(KEY);
    const [run] = await t.run((ctx) => ctx.db.query("buildRuns").collect());
    expect(run).toMatchObject({ status: "failed", errorClass: "provider_http" });
    expect((await holds(t)).filter(([kind]) => kind === "generate")).toEqual([["generate", "released"]]);
  });
});

describe("a rebuild, start to finish", () => {
  test("the old site is scrapped first and a fresh one is built and published at the same address", async () => {
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    const providers = stubProviders((call) => built(call === 1 ? "Harbor Roasters" : "Harbor Roasters, rebuilt"));

    const id = await answerEverything(member);
    await member.as.mutation(api.onboarding.submit, { id });
    await drain(t);
    const first = (await t.run((ctx) => ctx.db.get(id)))!;
    expect(first.status).toBe("complete");
    const siteId = first.siteId!;
    const before = (await t.run((ctx) => ctx.db.get(siteId)))!;
    const [oldVersion] = await versions(t);
    const [oldImage] = await t.run((ctx) => ctx.db.query("siteImages").collect());
    const oldBriefStorageId = first.briefStorageId!;
    const balance = (await member.as.query(api.billing.summary, {}))!.credits;

    const briefId = await member.as.mutation(api.onboarding.rebuild, {});
    expect(briefId).toBe(id);

    // Scrapped before anything is built: the page, its pictures, the thread,
    // and the address's contents are gone; the address itself stays.
    const scrapped = (await t.run((ctx) => ctx.db.get(siteId)))!;
    expect(scrapped).toMatchObject({ status: "draft", slug: before.slug, name: "Harbor Roasters" });
    expect(scrapped.currentVersionId).toBeUndefined();
    expect(scrapped.publishedVersionId).toBeUndefined();
    expect(scrapped.publishedAt).toBeUndefined();
    expect(scrapped.buildEpoch).toBe((before.buildEpoch ?? 0) + 1);
    expect(await versions(t)).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("siteImages").collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.storage.getUrl(oldImage.storageId))).toBeNull();
    expect(await t.run((ctx) => ctx.storage.getUrl(oldBriefStorageId))).toBeNull();
    expect(await t.run((ctx) => ctx.db.query("messages").collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({ status: "queued", attempt: 2, siteId });
    expect(await member.as.query(api.onboarding.state, {})).toMatchObject({
      hasWebsite: false,
      canRebuild: false,
      draft: expect.objectContaining({ id, status: "queued" }),
    });
    expect((await scheduled(t)).filter((job) => job.name === "onboarding:build" && job.state !== "success")).toHaveLength(1);

    await drain(t);

    // A fresh build, not an edit: the model never saw the old page.
    expect(providers.builds()).toBe(2);
    const rebuildCall = providers.chatCalls().at(-1)!;
    const rebuiltContext = rebuildCall.body.messages.map((m: any) => m.content).join("\n");
    expect(rebuiltContext).not.toContain("Harbor Roasters</h1>");
    expect(rebuiltContext).not.toContain(oldImage.storageId);
    expect(rebuiltContext).not.toContain(oldBriefStorageId);
    expect(rebuiltContext).toContain("clean-slate REBUILD, not an edit");
    expect(rebuiltContext).toContain("Fresh-build identifier:");
    expect(rebuildCall.body.messages.some((m: any) => m.role === "assistant")).toBe(false);
    expect(rebuildCall.body).not.toHaveProperty("previous_response_id");
    expect(rebuildCall.body).not.toHaveProperty("cachedContent");
    const after = (await t.run((ctx) => ctx.db.get(id)))!;
    expect(after).toMatchObject({ status: "complete", attempt: 2, siteId });
    expect(after.answers).toEqual(first.answers);
    expect(after.step).toBe(first.step);
    for (const hash of after.discardedDesignHashes ?? []) expect(rebuiltContext).not.toContain(hash);
    expect(after.events.map((event) => event.label)).toEqual([
      "Rebuilding from your answers",
      "Build brief saved and read",
      "Agent started building your website",
      "Page written",
      "Pictures made for your site",
      "Website received from the agent",
      "Website saved and ready",
    ]);
    const [version] = await versions(t);
    expect(await versions(t)).toHaveLength(1);
    expect(version._id).not.toBe(oldVersion._id);
    expect(version.html).toContain("<h1>Harbor Roasters, rebuilt</h1>");
    expect(version.html).not.toContain("forge-image:");
    const rebuilt = (await t.run((ctx) => ctx.db.get(siteId)))!;
    expect(rebuilt).toMatchObject({ status: "published", slug: before.slug, currentVersionId: version._id, publishedVersionId: version._id });
    const messages = await t.run((ctx) => ctx.db.query("messages").collect());
    expect(messages).toHaveLength(1);
    expect(messages[0].body).toBe("Built a warm page for Harbor Roasters, rebuilt.");
    expect(await t.run((ctx) => ctx.db.query("siteImages").collect())).toHaveLength(1);
    expect((await holds(t)).every(([, status]) => status === "settled")).toBe(true);
    expect(await member.as.query(api.billing.summary, {})).toMatchObject({
      reserved: 0,
      credits: balance - REQUEST_COSTS.generate - REQUEST_COSTS.image,
    });
    const runs = await t.run((ctx) => ctx.db.query("buildRuns").collect());
    expect(runs.map((row) => [row.source, row.attempt, row.status])).toEqual([
      ["onboarding", 1, "complete"],
      ["rebuild", 2, "complete"],
    ]);
    expect(await member.as.query(api.onboarding.state, {})).toMatchObject({
      required: false,
      hasWebsite: true,
      canRebuild: true,
      draft: expect.objectContaining({ id, status: "complete" }),
    });

    // Both watchdogs are still on the clock; neither can touch a finished build.
    await t.mutation(internal.onboarding.expire, { id, attempt: 1 });
    await t.mutation(internal.onboarding.expire, { id, attempt: 2 });
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({ status: "complete", attempt: 2 });
    expect(await versions(t)).toHaveLength(1);
    expect((await scheduled(t)).filter((job) => job.name === "onboarding:build" && job.state !== "success")).toEqual([]);
  });

  test("a thread build the platform stopped is failed by its watchdog, and a finished one is left alone", async () => {
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    stubProviders(() => built("Harbor Roasters"));
    const id = await answerEverything(member);
    await member.as.mutation(api.onboarding.submit, { id });
    await drain(t);
    const siteId = (await t.run((ctx) => ctx.db.get(id)))!.siteId!;
    const site = (await t.run((ctx) => ctx.db.get(siteId)))!;

    // A turn that died mid-flight: begun, never finished, never failed.
    const dead = await t.mutation(internal.generate.begin, { userId: member.userId, conversationId: site.conversationId, prompt: "Make it bolder" });
    expect((await scheduled(t)).filter((job) => job.name === "generate:expire" && job.state !== "success")).toHaveLength(1);
    const before = (await member.as.query(api.billing.summary, {}))!;
    expect(before.reserved).toBe(REQUEST_COSTS.edit);
    await t.mutation(internal.generate.expire, { assistantId: dead.assistantId, holdId: dead.holdId });
    expect(await t.run((ctx) => ctx.db.get(dead.assistantId))).toMatchObject({ status: "failed", body: "The build stopped responding. Try again." });
    expect(await member.as.query(api.billing.summary, {})).toMatchObject({ reserved: 0, credits: before.credits });
    expect((await holds(t)).filter(([kind]) => kind === "edit")).toEqual([["edit", "released"]]);

    // A turn that finished keeps its reply and its spend when the watchdog fires.
    await member.as.action(api.generate.run, { conversationId: site.conversationId, prompt: "Add opening hours" });
    // An answered turn reflects on itself afterwards; let it, so nothing is left ticking.
    await drain(t);
    const done = (await t.run((ctx) => ctx.db.query("messages").withIndex("by_conversation", (q) => q.eq("conversationId", site.conversationId)).order("desc").collect()))
      .find((message) => message.role === "assistant" && message.versionId && !message.status)!;
    const settled = (await t.run((ctx) => ctx.db.query("creditHolds").collect())).filter((hold) => hold.requestKind === "edit" && hold.status === "settled");
    expect(settled).toHaveLength(1);
    const after = (await member.as.query(api.billing.summary, {}))!;
    await t.mutation(internal.generate.expire, { assistantId: done._id, holdId: settled[0]._id });
    const kept = (await t.run((ctx) => ctx.db.get(done._id)))!;
    expect(kept).toMatchObject({ body: done.body, versionId: done.versionId });
    expect(kept.status).toBeUndefined();
    expect(await member.as.query(api.billing.summary, {})).toMatchObject({ reserved: 0, credits: after.credits });
    expect(await versions(t)).toHaveLength(2);
  });

  test("a reasoning-only reply is asked again for an answer, and stops there", async () => {
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    // writePage retries a reply that fell short of a page. This is not that:
    // the budget went on thinking, so the page never started. That gets one
    // go inside a ceiling worth answering in, and no more -- a third would
    // spend another minute to be told the same thing.
    const providers = stubProviders(() =>
      json({ choices: [{ finish_reason: "length", message: { content: "", reasoning_content: "Thinking about the roastery…" } }] }),
    );
    const id = await answerEverything(member);
    await member.as.mutation(api.onboarding.submit, { id });
    await drain(t);

    const builds = providers.chatCalls().filter((call) =>
      call.body.messages.some((m: any) => /website-build-brief\.md/.test(m.content)),
    );
    expect(builds).toHaveLength(2);
    expect(builds[1].body.messages.some((m: any) => /still thinking/.test(m.content))).toBe(true);
    const row = (await t.run((ctx) => ctx.db.get(id)))!;
    expect(row.status).toBe("failed");
    expect(row.error).toContain("only its reasoning");
    // Nothing was built and nothing was charged for it.
    expect(await versions(t)).toHaveLength(0);
    expect((await member.as.query(api.billing.summary, {}))!.reserved).toBe(0);
  });

  test("a build too big for the deployment's ceiling is given room, and the site lands", async () => {
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    // The failure this is about: a reasoning model bills its thinking inside
    // the same ceiling as its answer, so a ceiling that only fits the page
    // comes back as thinking and no page at all. Forge widens it and asks
    // again rather than handing the member a failed build to retry by hand.
    process.env.AI_MAX_TOKENS = "6000";
    const providers = stubProviders((call) =>
      call === 1
        ? json({ choices: [{ finish_reason: "length", message: { content: "", reasoning_content: "Thinking about the roastery…" } }] })
        : built("Harbor Roasters"),
    );
    const id = await answerEverything(member);
    await member.as.mutation(api.onboarding.submit, { id });
    await drain(t);

    const builds = providers.chatCalls().filter((call) =>
      call.body.messages.some((m: any) => /website-build-brief\.md/.test(m.content)),
    );
    expect(builds.map((call) => call.body.max_tokens)).toEqual([6000, 64000]);
    const row = (await t.run((ctx) => ctx.db.get(id)))!;
    expect(row.status).toBe("complete");
    expect(row.error).toBeUndefined();
    expect(await versions(t)).toHaveLength(1);
    // One build, charged once: the first go never produced anything to keep.
    expect((await holds(t)).filter(([kind]) => kind === "generate")).toEqual([["generate", "settled"]]);
  });

  test("a page still arriving from before the rebuild cannot land on the fresh site", async () => {
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    stubProviders(() => built("Harbor Roasters"));
    const id = await answerEverything(member);
    await member.as.mutation(api.onboarding.submit, { id });
    await drain(t);
    const siteId = (await t.run((ctx) => ctx.db.get(id)))!.siteId!;
    const site = (await t.run((ctx) => ctx.db.get(siteId)))!;

    // An edit from the thread is in flight when the member presses Rebuild.
    const inFlight = await t.mutation(internal.generate.begin, { userId: member.userId, conversationId: site.conversationId, prompt: "Make it bolder" });
    await member.as.mutation(api.onboarding.rebuild, {});

    const landed = await t.mutation(internal.generate.finish, {
      assistantId: inFlight.assistantId,
      siteId,
      holdId: inFlight.holdId,
      requestKind: inFlight.requestKind,
      html: page("Bolder"),
      summary: "Made it bolder.",
      epoch: inFlight.epoch,
    });
    expect(landed).toBe("cancelled");
    expect(await versions(t)).toEqual([]);
    expect((await holds(t)).filter(([kind]) => kind === "edit")).toEqual([["edit", "released"]]);
    expect((await t.run((ctx) => ctx.db.get(siteId)))!.currentVersionId).toBeUndefined();
  });

  test("an identical design is retried without sending the discarded page to the model", async () => {
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    const providers = stubProviders(call => built(call < 3 ? "Harbor Roasters" : "A fresh Harbor"));
    const id = await answerEverything(member);
    await member.as.mutation(api.onboarding.submit, { id });
    await drain(t);
    await member.as.mutation(api.onboarding.rebuild, {});
    await drain(t);
    expect(providers.builds()).toBe(3);
    expect(await t.run(ctx => ctx.db.get(id))).toMatchObject({ status: "complete", answers: ANSWERS });
    expect(await versions(t)).toHaveLength(1);
    expect((await versions(t))[0].html).toContain("A fresh Harbor");
    const request = providers.chatCalls().at(-1)!.body.messages;
    expect(JSON.stringify(request)).toContain("matched a discarded design");
    expect(JSON.stringify(request)).not.toContain("Harbor Roasters</h1>");
    expect(request.some((m: any) => m.role === "assistant")).toBe(false);
    // Only the first build and the accepted rebuild made images.
    expect(providers.calls.filter(call => /generateContent/.test(call.url))).toHaveLength(2);
  });

  test("a provider repeating the old page twice fails without restoring it or spending build credits", async () => {
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    const providers = stubProviders(() => built("Harbor Roasters"));
    const id = await answerEverything(member);
    await member.as.mutation(api.onboarding.submit, { id });
    await drain(t);
    const before = (await member.as.query(api.billing.summary, {}))!;
    await member.as.mutation(api.onboarding.rebuild, {});
    await drain(t);
    expect(providers.builds()).toBe(3);
    const failed = (await t.run(ctx => ctx.db.get(id)))!;
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("repeated the discarded design");
    expect(failed.answers).toEqual(ANSWERS);
    expect(await versions(t)).toEqual([]);
    expect(await t.run(ctx => ctx.db.query("siteImages").collect())).toEqual([]);
    expect(await member.as.query(api.billing.summary, {})).toMatchObject({ credits: before.credits, reserved: 0 });
  });
});

// Whether the standing rules and the design skill actually leave the server.
// scripts/prompts.test.ts proves the embedded strings match their markdown
// files; this proves those strings are in the request body of every turn that
// writes or discusses a site, whole rather than summarised or truncated.
describe("what actually reaches the model", () => {
  const systemsOf = (call: any) =>
    call.body.messages.filter((m: any) => m.role === "system").map((m: any) => m.content);

  test("the build turn carries the three prompt files verbatim, in precedence order", async () => {
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    const providers = stubProviders(() => built("Harbor Roasters"));

    const id = await answerEverything(member);
    await member.as.mutation(api.onboarding.submit, { id });
    await drain(t);
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({ status: "complete" });

    const build = providers
      .chatCalls()
      .find((call) => call.body.messages.some((m: any) => /website-build-brief\.md/.test(m.content)))!;
    const systems = systemsOf(build);

    // Whole-string equality, so a truncated or paraphrased copy fails here.
    expect(systems[0]).toBe(FORGE_MD);
    expect(systems[1]).toBe(DESIGN_GOD);
    expect(systems[2]).toBe(FED);
    expect(systems.filter((s: string) => s === FORGE_MD).length).toBe(1);
    expect(systems.filter((s: string) => s === DESIGN_GOD).length).toBe(1);
    expect(systems.filter((s: string) => s === FED).length).toBe(1);

    // House rules, custom design, skill, then the contract.
    expect(systems[3]).toContain("You are Forge, the website-building agent");
    expect(systems.at(-1)).toContain("This is an onboarding BUILD");

    expect(systems[0]).toContain("What the site must cover");
    expect(systems[1]).toContain("One typeface for the entire build");
    expect(systems[2]).toContain("plan, review against the brief, build, critique");
  });

  test("the strategy passes behind the questions carry them too", async () => {
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    const providers = stubProviders(() => built("Harbor Roasters"));
    await answerEverything(member);
    await drain(t);

    const strategy = providers
      .chatCalls()
      .find((call) => /private website strategist/.test(JSON.stringify(call.body.messages)))!;
    expect(strategy).toBeDefined();
    const systems = systemsOf(strategy);
    expect(systems[0]).toBe(FORGE_MD);
    expect(systems[1]).toBe(DESIGN_GOD);
    expect(systems[2]).toBe(FED);
    expect(systems.filter((s: string) => s === FORGE_MD).length).toBe(1);
  });

  test("a thread turn after the build carries them as well", async () => {
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    const providers = stubProviders(() => built("Harbor Roasters"));
    const id = await answerEverything(member);
    await member.as.mutation(api.onboarding.submit, { id });
    await drain(t);
    const siteId = (await t.run((ctx) => ctx.db.get(id)))!.siteId!;
    const site = (await t.run((ctx) => ctx.db.get(siteId)))!;

    await member.as.action(api.generate.run, { conversationId: site.conversationId, prompt: "Make the hero bolder" });

    const systems = systemsOf(providers.chatCalls().at(-1)!);
    expect(systems[0]).toBe(FORGE_MD);
    expect(systems[1]).toBe(DESIGN_GOD);
    expect(systems[2]).toBe(FED);
    expect(systems.filter((s: string) => s === FORGE_MD).length).toBe(1);
    // On a site with a saved brief, generate.begin splices that brief in after
    // the three prompt files.
    expect(systems[3]).toContain("Saved project context");
    expect(systems.some((c: string) => c.includes("You are Forge, the website-building agent"))).toBe(true);
    // The turn reflects on itself after answering: drain it here rather than into the next test.
    await drain(t);
  });
});

// The saved strategy is handed to the model as "Working design and build
// strategy" on every build. Written once under the old rules, it named a page
// structure — so a rebuild was given the scrapped page's own plan and built it
// again, whatever the contract said. That is why loosening the contract
// changed nothing on the page.
describe("a rebuild starts the plan over, not just the page", () => {
  test("the scrapped page's strategy is not handed back to the next build", async () => {
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    const providers = stubProviders(call => built(call === 1 ? "Harbor Roasters" : "A new Harbor"));
    const id = await answerEverything(member);
    await drain(t);

    // Whatever the strategist settled on while the questions were answered.
    const first = (await t.run((ctx) => ctx.db.get(id)))!;
    expect(first.strategy).toBeTruthy();
    await t.run(async (ctx) => {
      await ctx.db.patch(id, { strategy: "Header, nav, hero, three feature cards, closing CTA, footer." });
    });

    await member.as.mutation(api.onboarding.submit, { id });
    await drain(t);
    const firstBrief = providers
      .chatCalls()
      .find((call) => call.body.messages.some((m: any) => /website-build-brief\.md/.test(m.content)))!
      .body.messages.at(-1).content;
    expect(firstBrief).toContain("three feature cards");

    await member.as.mutation(api.onboarding.rebuild, {});
    // Cleared the moment the rebuild is queued, before the agent reads it.
    expect((await t.run((ctx) => ctx.db.get(id)))!.strategy).toBeUndefined();
    await drain(t);

    const rebuiltBrief = providers
      .chatCalls()
      .at(-1)!
      .body.messages.at(-1).content;
    expect(rebuiltBrief).not.toContain("three feature cards");
    expect(rebuiltBrief).toContain("Develop the strategy from the answers above");
    // The answers themselves survive — only the plan for the old page goes.
    expect(rebuiltBrief).toContain("Harbor Roasters");
    expect(rebuiltBrief).toContain("Pier Roast 250g");
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({ status: "complete" });
  });

  test("the strategist no longer draws a skeleton for the build to follow", () => {
    const onboarding = readFileSync(new URL("./onboarding.ts", import.meta.url), "utf8");
    expect(onboarding).toContain("Say nothing about page structure, section order or layout");
    expect(onboarding).not.toMatch(/conversion goal, page structure, copy priorities/);
  });
});

// fed-only block: the default while the owner tests the agent on its own.
describe("with agent direction off, the agent is sent FED and the answers alone", () => {
  beforeEach(() => { delete process.env.AGENT_DIRECTION; });
  afterEach(() => { process.env.AGENT_DIRECTION = "on"; });

  test("an onboarding build carries FED, then the answers, and nothing Forge wrote", async () => {
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    const providers = stubProviders(() => built("Harbor Roasters"));
    const id = await answerEverything(member);
    await member.as.mutation(api.onboarding.submit, { id });
    await drain(t);
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({ status: "complete" });

    // The strategist never ran, so the only text call is the build.
    const calls = providers.chatCalls();
    expect(calls).toHaveLength(1);
    const messages = calls[0].body.messages;
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: "system", content: FED });
    expect(messages[1].role).toBe("user");
    const answers = messages[1].content;
    expect(answers).toContain("What do you sell, and what does it cost?");
    expect(answers).toContain("Pier Roast 250g — £11");
    for (const held of ["Builder instructions", "beautiful", "design defaults", "strategy", "Choose a suitable default", "SVG artwork", "website-build-brief.md"]) {
      expect(answers).not.toContain(held);
    }
    for (const held of [FORGE_MD, DESIGN_GOD]) {
      expect(JSON.stringify(messages)).not.toContain(JSON.stringify(held).slice(1, 80));
    }
  });

  test("a thread turn carries FED, the answers, the thread and the request", async () => {
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    const providers = stubProviders(() => built("Harbor Roasters"));
    const id = await answerEverything(member);
    await member.as.mutation(api.onboarding.submit, { id });
    await drain(t);
    const site = (await t.run(async (ctx) => ctx.db.get((await ctx.db.get(id))!.siteId!)))!;

    await member.as.action(api.generate.run, { conversationId: site.conversationId, prompt: "Make the hero bolder" });

    const messages = providers.chatCalls().at(-1)!.body.messages;
    const systems = messages.filter((m: any) => m.role === "system").map((m: any) => m.content);
    expect(systems).toHaveLength(2);
    expect(systems[0]).toBe(FED);
    expect(systems[1].startsWith("# Onboarding answers")).toBe(true);
    expect(messages.at(-1)).toEqual({ role: "user", content: "Make the hero bolder" });
    expect(JSON.stringify(messages)).not.toContain("You are Forge, the website-building agent");
    expect(JSON.stringify(messages)).not.toContain("currently looks like this");
  });
});
