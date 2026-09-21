/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
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

    // The site is saved, published at its Forge address, and the thread says so.
    const site = (await t.run((ctx) => ctx.db.get(brief.siteId!)))!;
    expect(site).toMatchObject({ name: "Harbor Roasters", status: "published", currentVersionId: version._id, publishedVersionId: version._id });
    expect(site.slug).toBeTruthy();
    const messages = await t.run((ctx) => ctx.db.query("messages").collect());
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: "assistant", versionId: version._id });
    expect(messages[0].status).toBeUndefined();
    expect(messages[0].body).toBe(`Built a warm page for Harbor Roasters. It's published at forge-test.convex.site/sites/${site.slug}.`);

    // Every hold settled: the build, the picture, and each strategy pass.
    expect((await holds(t)).every(([, status]) => status === "settled")).toBe(true);
    expect(await member.as.query(api.billing.summary, {})).toMatchObject({
      reserved: 0,
      credits: OPENING - REQUEST_COSTS.generate - REQUEST_COSTS.image - QUESTIONS.length * REQUEST_COSTS.chat,
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

  test("a model that never answers fails the build once, says why, and the next press builds", async () => {
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    let hung = true;
    const providers = stubProviders(() => {
      if (hung) throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
      return built("Harbor Roasters");
    });

    const id = await answerEverything(member);
    await member.as.mutation(api.onboarding.submit, { id });
    await drain(t);

    // One attempt, one call: a call that ran out its clock is not repeated.
    expect(providers.builds()).toBe(1);
    const failed = (await t.run((ctx) => ctx.db.get(id)))!;
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("took too long");
    expect(failed.error).toContain("Your answers are saved");
    expect(failed.holdId).toBeUndefined();
    expect((await holds(t)).filter(([kind]) => kind === "generate")).toEqual([["generate", "released"]]);
    expect(await versions(t)).toEqual([]);
    const [run] = await t.run((ctx) => ctx.db.query("buildRuns").collect());
    expect(run).toMatchObject({ status: "failed", errorClass: "timeout", attempt: 1 });
    expect(await member.as.query(api.onboarding.state, {})).toMatchObject({
      hasWebsite: false,
      draft: expect.objectContaining({ id, status: "failed" }),
    });

    // Nothing re-queues on its own: the failed attempt leaves no build behind.
    expect((await scheduled(t)).filter((job) => job.name === "onboarding:build" && job.state !== "success")).toEqual([]);

    // Try building again is one more attempt, not a loop.
    hung = false;
    await member.as.mutation(api.onboarding.submit, { id });
    await drain(t);
    expect(providers.builds()).toBe(2);
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

    // Writing the site goes to the build model; the strategy passes behind the
    // questions are conversation and stay on the cheaper one.
    const calls = providers.chatCalls();
    const build = calls.find((call) => call.body.messages.some((m: any) => /website-build-brief\.md/.test(m.content)))!;
    expect(build.body.model).toBe("forge-test-large");
    expect(build.body.max_tokens).toBe(24000);
    const strategy = calls.find((call) => /private website strategist/.test(JSON.stringify(call.body.messages)))!;
    expect(strategy.body.model).toBe("forge-test");
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({ status: "complete" });

    // Unset, a build runs on exactly the model chat does.
    delete process.env.AI_BUILD_MODEL;
    const plain = await createBuilder(t, "p@example.com");
    const second = await answerEverything(plain);
    await plain.as.mutation(api.onboarding.submit, { id: second });
    await drain(t);
    expect(providers.chatCalls().at(-1)!.body.model).toBe("forge-test");
  });

  test("the deployment's own settings put text on Gemini 3.8 Flash and pictures on Nano Banana 2 Lite", async () => {
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    const providers = stubProviders(() => built("Harbor Roasters"));
    // Exactly what CLAUDE.md records for polished-ram-883. AI_BUILD_MODEL is
    // unset there, so a build inherits the chat model rather than differing.
    process.env.AI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
    process.env.AI_MODEL = "gemini-3.8-flash";
    process.env.AI_IMAGE_MODEL = "gemini-3.1-flash-lite-image";
    delete process.env.AI_BUILD_MODEL;

    const id = await answerEverything(member);
    await member.as.mutation(api.onboarding.submit, { id });
    await drain(t);

    // The words: every chat and build turn on the OpenAI-compatible path.
    const chat = providers.chatCalls();
    expect(chat.length).toBeGreaterThan(0);
    for (const call of chat) {
      expect(call.url).toBe("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
      expect(call.body.model).toBe("gemini-3.8-flash");
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
    expect(identity).toContain("this turn runs on Gemini 3.8 Flash");
    expect(identity).toContain("made by Gemini Nano Banana 2 Lite");

    // The build landed.
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({ status: "complete" });
    expect(await versions(t)).toHaveLength(1);
    expect((await versions(t))[0].html).not.toContain("forge-image:");
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
    expect(rebuildCall.body.messages.map((m: any) => m.content).join("\n")).not.toContain("Harbor Roasters</h1>");
    const after = (await t.run((ctx) => ctx.db.get(id)))!;
    expect(after).toMatchObject({ status: "complete", attempt: 2, siteId });
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
    expect(messages[0].body).toBe(`Built a warm page for Harbor Roasters, rebuilt. It's published at forge-test.convex.site/sites/${before.slug}.`);
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
});
