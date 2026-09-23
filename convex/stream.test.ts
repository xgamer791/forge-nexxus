/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { insertDesignPackage } from "./designWorkerMock";
import type { Id } from "./_generated/dataModel";
import { recordLastSign } from "./diagnostics";
import { callProvider } from "./generate";
import { planFor } from "./plans";
import schema from "./schema";
import { LOOP_WINDOW, readStream, StreamStopped, THINKING_STEP, WRITING_STEP, type Milestone } from "./stream";

// A stall is what the stream shows -- the connection dropping, the provider
// erroring part way, the model repeating itself -- and never a length of time.
// These drive the reader with streams shaped the way a provider sends them,
// then drive whole builds through the same streams.
const modules = import.meta.glob("./**/*.*s");
const fresh = () => convexTest(schema, modules);
type T = ReturnType<typeof fresh>;

const KEY = "sk-test-secret-key";
const PAGE =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Bakery</title><style>body{margin:0}</style></head><body><main><h1>Bakery on Main</h1></main></body></html>';
const encoder = new TextEncoder();
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Step = string | { wait: number } | { fail: string };
// A stream that sends each step in turn -- text, a pause, or a broken
// connection -- and then closes, unless a step broke it first.
function body(steps: Step[]) {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const step of steps) {
        if (typeof step === "string") controller.enqueue(encoder.encode(step));
        else if ("wait" in step) await wait(step.wait);
        else { controller.error(new TypeError(step.fail)); return; }
      }
      controller.close();
    },
  });
}
const streamed = (...steps: Step[]) =>
  new Response(body(steps), { status: 200, headers: { "content-type": "text/event-stream" } });
const delta = (fields: Record<string, unknown>, finish: string | null = null) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: fields, finish_reason: finish }] })}\n\n`;
const think = (text: string) => delta({ reasoning_content: text });
const say = (text: string) => delta({ content: text });
const finish = (reason = "stop") => delta({ content: "" }, reason);
const DONE = "data: [DONE]\n\n";
// Thinking that moves on: no stretch of it says the same thing twice.
const varied = (length: number) => {
  let text = "";
  for (let i = 0; text.length < length; i += 1) text += `Step ${i}: weigh option ${(i * 7) % 13} against ${(i * 11) % 17}, then note ${i * i}. `;
  return text.slice(0, length);
};
const KEEP_ALIVE = ": keep-alive\n\n";
const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

const read = (steps: Step[], cutShort: () => "out_of_time" | null = () => null, milestones?: Milestone[]) =>
  readStream(body(steps), {
    started: Date.now(),
    cutShort,
    scrub: (text) => text.split(KEY).join("[key]"),
    onMilestone: (milestone) => { milestones?.push(milestone); },
  });
async function stopOf(promise: Promise<unknown>) {
  try { await promise; } catch (error) { if (error instanceof StreamStopped) return error; throw error; }
  throw new Error("the reply did not stop");
}

describe("reading a streamed reply", () => {
  test("a reply that thinks, writes and finishes is read whole, and a keep-alive is counted, not taken for a token", async () => {
    const { content, stats } = await read([KEEP_ALIVE, KEEP_ALIVE, think("Plan the bakery page."), say("Built it.\n\n```html\n"), say(PAGE), say("\n```"), finish(), DONE]);
    expect(content).toBe(`Built it.\n\n\`\`\`html\n${PAGE}\n\`\`\``);
    expect(stats).toMatchObject({ phase: "finished", keepAlives: 2, reasoningChars: "Plan the bakery page.".length, contentChars: content.length, finishReason: "stop", sawDone: true });
    expect(stats.firstTokenMs).toBeGreaterThanOrEqual(0);
    expect(stats.firstContentMs).toBeGreaterThanOrEqual(stats.firstTokenMs!);
  });

  test("a pause is not a stall: a slow reply that keeps moving finishes, however long it takes", async () => {
    const { content, stats } = await read([think("Thinking."), { wait: 250 }, think(" Still thinking."), { wait: 250 }, say("Done."), { wait: 250 }, finish(), DONE]);
    expect(content).toBe("Done.");
    expect(stats.phase).toBe("finished");
  });

  test("the connection closing before the reply finished is a drop, with the page as far as it got", async () => {
    const stop = await stopOf(read([think("Plan."), say("Built it.\n\n```html\n<!doctype html><html><body>")]));
    expect(stop.reason).toBe("dropped");
    expect(stop.stats.phase).toBe("writing");
    expect(stop.content).toBe("Built it.\n\n```html\n<!doctype html><html><body>");
  });

  test("a connection that breaks part way is a drop, and what it said is kept without the key", async () => {
    const stop = await stopOf(read([think("Plan the page."), { wait: 20 }, { fail: `socket hang up near ${KEY}` }]));
    expect(stop.reason).toBe("dropped");
    expect(stop.stats.phase).toBe("thinking");
    expect(stop.stats.providerError).toContain("socket hang up");
    expect(stop.stats.providerError).not.toContain(KEY);
  });

  test("an error the provider puts in the stream stops the reply, and the key never comes back with it", async () => {
    const stop = await stopOf(read([think("Plan."), `data: ${JSON.stringify({ error: { message: `Server overloaded for ${KEY}` } })}\n\n`, say("never read")]));
    expect(stop.reason).toBe("provider_error");
    expect(stop.stats.providerError).toBe("Server overloaded for [key]");
    expect(stop.content).toBe("");
  });

  test("a model that keeps thinking the same passage is stopped as going round in circles", async () => {
    const passage = "Let me reconsider the palette for the bakery once more, starting from the flour and the oven light. ".repeat(7).slice(0, LOOP_WINDOW);
    const stop = await stopOf(read([think("First, the brief. "), think(passage), think(passage), think(passage), think(passage), think(passage), say("never read")]));
    expect(stop.reason).toBe("looping");
    expect(stop.stats.loopRepeats).toBeGreaterThanOrEqual(4);
    expect(stop.stats.phase).toBe("thinking");
  });

  test("a long think that does not repeat itself is not taken for a loop", async () => {
    const { stats } = await read([think(varied(60000)), say("Done."), finish(), DONE]);
    expect(stats.phase).toBe("finished");
    expect(stats.loopRepeats).toBeUndefined();
  });

  test("a passage that comes back once in a long while, like a reworked draft, is not a loop", async () => {
    const draft = "body{margin:0;font:17px/1.5 Satoshi,sans-serif;background:#f4efe6;color:#1d1b18}".repeat(10).slice(0, LOOP_WINDOW);
    const steps = Array.from({ length: 5 }, (_, i) => [think(draft), think(varied(6000).replace(/Step/g, `Round ${i} step`))]).flat();
    const { stats } = await read([...steps, say("Done."), finish(), DONE]);
    expect(stats.phase).toBe("finished");
  });

  test("events split across reads, and lines that end in CRLF, are read whole", async () => {
    const event = say("Split across reads.").replace(/\n/g, "\r\n");
    const { content } = await read([event.slice(0, 17), event.slice(17, 40), event.slice(40), finish().replace(/\n/g, "\r\n"), DONE]);
    expect(content).toBe("Split across reads.");
  });

  test("what the log is told follows what the reply has produced, not the clock", async () => {
    const milestones: Milestone[] = [];
    await read([think(varied(THINKING_STEP + 5)), say(varied(WRITING_STEP + 5)), finish(), DONE], () => null, milestones);
    expect(milestones.map((m) => [m.kind, m.first])).toEqual([["thinking", true], ["thinking", false], ["writing", true], ["writing", false]]);
  });

  test("a reply the build's own clock cut short is out of time, with where it had got to", async () => {
    let cut = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(think("Still planning.")));
        setTimeout(() => { cut = true; controller.error(Object.assign(new Error("The operation was aborted"), { name: "AbortError" })); }, 30);
      },
    });
    const stop = await stopOf(readStream(stream, { started: Date.now(), cutShort: () => (cut ? "out_of_time" : null), scrub: (text) => text }));
    expect(stop.reason).toBe("out_of_time");
    expect(stop.stats.phase).toBe("thinking");
  });
});

// ——— Whole builds, through the same streams ———————————————————————————————

async function createBuilder(t: T) {
  const { userId, sessionId } = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email: "m@example.com" });
    const sessionId = await ctx.db.insert("authSessions", { userId, expirationTime: Date.now() + 60_000 });
    return { userId, sessionId };
  });
  await t.mutation(internal.billing.grantPlan, { userId, plan: "starter" });
  return { userId, as: t.withIdentity({ subject: `${userId}|${sessionId}` }) };
}

async function seedBuiltSite(t: T, userId: Id<"users">) {
  return await t.run(async (ctx) => {
    const conversationId = await ctx.db.insert("conversations", { userId, title: "Bakery", updatedAt: Date.now() });
    const siteId = await ctx.db.insert("sites", { userId, conversationId, name: "Bakery", status: "draft", createdAt: Date.now(), updatedAt: Date.now() });
    const versionId = await ctx.db.insert("siteVersions", { userId, siteId, html: PAGE, summary: "First", requestKind: "generate", createdAt: Date.now() });
    await ctx.db.patch(siteId, { currentVersionId: versionId });
    await insertDesignPackage(ctx, userId, siteId);
    return { siteId, conversationId };
  });
}

// Build calls are answered by `build`, in order; anything else -- the memory
// note that follows an answered turn -- gets a plain reply.
function stubBuilds(build: (call: number) => Response) {
  const calls: any[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      if (!request.messages.some((m: any) => /standing rules for the website agent/.test(m.content))) {
        return json({ choices: [{ message: { content: '{"add":[],"forget":[],"replace":[]}' } }] });
      }
      calls.push(request);
      return build(calls.length);
    }),
  );
  return calls;
}

async function runEvents(t: T) {
  return await t.run(async (ctx) => {
    const [run] = await ctx.db.query("buildRuns").collect();
    const events = await ctx.db.query("buildEvents").withIndex("by_run_at", (q) => q.eq("runId", run._id)).collect();
    return { run, events };
  });
}

const edited = `Changed the hours.\n\n\`\`\`html\n${PAGE}\n\`\`\``;

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
  delete process.env.AI_STREAM;
});

describe("a build reads its reply as a stream", () => {
  test("the request asks for a stream, and AI_STREAM=0 sends a plain one and reads it whole", async () => {
    const t = fresh();
    const member = await createBuilder(t);
    const { conversationId } = await seedBuiltSite(t, member.userId);
    const calls = stubBuilds(() => streamed(think("Plan."), say(edited), finish(), DONE));
    await member.as.action(api.generate.run, { conversationId, prompt: "Change the hours" });
    expect(calls[0].stream).toBe(true);
    // Token counts are asked for only where the provider is known to send them.
    expect(calls[0].stream_options).toBeUndefined();

    process.env.AI_STREAM = "0";
    const plain = stubBuilds(() => json({ choices: [{ message: { content: edited } }] }));
    await member.as.action(api.generate.run, { conversationId, prompt: "Change the hours again" });
    expect(plain[0].stream).toBeUndefined();
    const versions = await t.run((ctx) => ctx.db.query("siteVersions").collect());
    expect(versions).toHaveLength(3);
  });

  test("a reply that drops while thinking is asked again, and the second one lands", async () => {
    const t = fresh();
    const member = await createBuilder(t);
    const { conversationId } = await seedBuiltSite(t, member.userId);
    const calls = stubBuilds((call) =>
      call === 1 ? streamed(KEEP_ALIVE, think("Plan the hours.")) : streamed(think("Plan."), say(edited), finish(), DONE));

    await member.as.action(api.generate.run, { conversationId, prompt: "Change the hours" });
    expect(calls).toHaveLength(2);
    const { run, events } = await runEvents(t);
    expect(run.status).toBe("complete");
    const stop = events.find((event) => event.phase === "provider_stop");
    expect(stop?.detail).toMatchObject({ stream: true, stopReason: "dropped", streamPhase: "thinking", keepAlives: 1, errorClass: "stream_dropped" });
    expect(events.some((event) => event.phase === "provider_retry")).toBe(true);
    expect(events.find((event) => event.phase === "provider_response")?.detail).toMatchObject({ stream: true, streamPhase: "finished", finishReason: "stop" });
  });

  test("a page that drops part way is carried on from where it stopped, not started again", async () => {
    const t = fresh();
    const member = await createBuilder(t);
    const { conversationId, siteId } = await seedBuiltSite(t, member.userId);
    const cut = PAGE.indexOf("<main>");
    const calls = stubBuilds((call) =>
      call === 1
        ? streamed(think("Plan."), say(`Changed the hours.\n\n\`\`\`html\n${PAGE.slice(0, cut)}`))
        : streamed(say(`${PAGE.slice(cut)}\n\`\`\``), finish(), DONE));

    await member.as.action(api.generate.run, { conversationId, prompt: "Change the hours" });
    expect(calls).toHaveLength(2);
    // The second call is the continuation: it carries the page as far as it got.
    const second = calls[1].messages;
    expect(second.at(-2)).toMatchObject({ role: "assistant", content: `Changed the hours.\n\n\`\`\`html\n${PAGE.slice(0, cut)}` });
    expect(second.at(-1).content).toContain("Continue from the exact character where it stopped");
    const saved = await t.run(async (ctx) => {
      const site = await ctx.db.get(siteId);
      return site?.currentVersionId ? await ctx.db.get(site.currentVersionId) : null;
    });
    expect(saved?.html).toBe(PAGE);
    const { events } = await runEvents(t);
    expect(events.some((event) => event.phase === "provider_resume")).toBe(true);
  });

  test("a model that keeps repeating itself fails the build, says so, and gives the credits back", async () => {
    const t = fresh();
    const member = await createBuilder(t);
    const { conversationId } = await seedBuiltSite(t, member.userId);
    const passage = "Weigh the palette again from the flour, the oven light and the window onto the street outside. ".repeat(8).slice(0, LOOP_WINDOW);
    const calls = stubBuilds(() => streamed(think("Brief. "), ...Array.from({ length: 5 }, () => think(passage)), say("never read")));

    await expect(member.as.action(api.generate.run, { conversationId, prompt: "Change the hours" })).rejects.toThrow("repeating itself");
    expect(calls).toHaveLength(2);
    // The second go was told what went wrong with the first.
    expect(JSON.stringify(calls[1].messages)).toContain("went round in circles");
    const { run, events } = await runEvents(t);
    expect(run).toMatchObject({ status: "failed", errorClass: "looping" });
    expect(run.error).toContain("repeating itself");
    expect(events.filter((event) => event.phase === "provider_stop").map((event) => event.detail?.stopReason)).toEqual(["looping", "looping"]);
    const holds = await t.run((ctx) => ctx.db.query("creditHolds").collect());
    expect(holds.map((hold) => hold.status)).toEqual(["released"]);
  });

  test("a reply still going when the platform's clock runs out is out of time, not a stall, and says where it was", async () => {
    const notes: any[] = [];
    const trace = { note: async (note: any) => { notes.push(note); } };
    // A provider that only ever keeps the connection alive: queued, never started.
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const tick = setInterval(() => controller.enqueue(encoder.encode(KEEP_ALIVE)), 20);
          init.signal?.addEventListener("abort", () => {
            clearInterval(tick);
            controller.error(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
          });
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }));
    await expect(callProvider([{ role: "user", content: "Build it." }], undefined, 1200, trace, "build"))
      .rejects.toThrow("The model hadn't started on your website when the build ran out of time");
    const stop = notes.find((note) => note.phase === "provider_stop");
    expect(stop.detail).toMatchObject({ stopReason: "out_of_time", streamPhase: "waiting", errorClass: "out_of_time" });
    expect(stop.detail.keepAlives).toBeGreaterThan(5);
    expect(notes.some((note) => note.phase === "provider_retry")).toBe(false);
  });

  test("the stall log lists each stop with where the reply had got to, and never an email", async () => {
    const t = fresh();
    const member = await createBuilder(t);
    const { conversationId } = await seedBuiltSite(t, member.userId);
    stubBuilds((call) => (call === 1 ? streamed(think("Plan.")) : streamed(say(edited), finish(), DONE)));
    await member.as.action(api.generate.run, { conversationId, prompt: "Change the hours" });

    const rows = await t.query(internal.diagnostics.inspectStalls, {});
    expect(rows.map((row) => row.phase)).toEqual(expect.arrayContaining(["provider_stop", "provider_retry"]));
    expect(rows.find((row) => row.phase === "provider_stop")?.detail).toMatchObject({ stopReason: "dropped", streamPhase: "thinking" });
    expect(JSON.stringify(rows)).not.toContain("m@example.com");
  });

  test("a build that died without a word is left with its last sign of life", async () => {
    const t = fresh();
    const { userId } = await createBuilder(t);
    const runId = await t.run(async (ctx) => {
      const runId = await ctx.db.insert("buildRuns", { userId, source: "generate", status: "calling", startedAt: Date.now() - 5000, updatedAt: Date.now() - 5000 });
      await ctx.db.insert("buildEvents", {
        userId, runId, at: Date.now() - 4000, phase: "provider_progress", level: "info",
        label: "Thinking: 40,000 characters so far", detail: { stream: true, streamPhase: "thinking", reasoningChars: 40000 },
      });
      return runId;
    });
    await t.run((ctx) => recordLastSign(ctx, runId));
    const events = await t.run((ctx) => ctx.db.query("buildEvents").withIndex("by_run_at", (q) => q.eq("runId", runId)).collect());
    const sign = events.find((event) => event.phase === "watchdog");
    expect(sign?.label).toBe("The build stopped without a word. Last heard: Thinking: 40,000 characters so far");
    expect(sign?.detail).toMatchObject({ errorClass: "silent_stop", streamPhase: "thinking", reasoningChars: 40000 });
    expect(sign?.detail?.sinceEventMs).toBeGreaterThanOrEqual(4000);
  });
});

// Keep the plan helper referenced: builders are granted a real plan above.
void planFor;
