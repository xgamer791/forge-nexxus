/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { joinCarry, MOST_RESUMES, nextPage, readTurn, STEP_TRIES } from "./buildDraft";
import { answerDesignResearch, DESIGN_PROMPT, designPrompt, resetDesignRoutes, setDesignRoutes, storeDesignPackage } from "./designWorkerMock";
import { readDraftReply } from "./generate";
import { CARRY_ON, draftTurn, MOST_RESTARTS } from "./onboarding";
import { QUESTIONS } from "./onboardingQuestions";
import { pagePlan } from "./pages";
import { REQUEST_COSTS } from "./plans";
import schema from "./schema";
import { routeSpec } from "./siteDesign";

// A measured site in pages, written a page at a time: each step is an action
// of its own, every page is saved the moment it closes, a page the clock stops
// is carried on from where it stopped, and the next step is queued the moment
// one ends. These drive the real chain -- the scheduler, the model's replies,
// the auditor gate and the save -- against a five-page reference, the most a
// rebuild or a new build is allowed to write.
const modules = import.meta.glob("./**/*.*s");
function makeTest() {
  return convexTest(schema, modules);
}
type T = ReturnType<typeof makeTest>;
let active: T;
const fresh = () => (active = makeTest());

const ROUTES = ["/", "/food-menu", "/drink-menu", "/specials", "/events"];
const REFERENCE = "https://harbor-reference.example/";
const KEY = "sk-test-secret-key";
const PNG = btoa("not really a png, but bytes are bytes");
const ANSWERS = [
  "Taquería El Farolito",
  "Tacos, burritos and aguas frescas, made to order",
  "Families and lunch crowds in Plano",
  "Visit you",
  "",
  "Show the menu",
  "Warm and welcoming",
  "",
  "",
  "",
  "Tacos al pastor — $3.50\nHorchata — $4",
];

const PICTURE =
  '<img src="forge-image:1" data-forge-image="Tacos al pastor on the comal, warm evening light" ' +
  'data-forge-aspect="16:9" alt="Tacos al pastor" width="1600" height="900">';
const NAV = ROUTES.map((path) => `<a href="${path}">${path === "/" ? "Home" : path.slice(1)}</a>`).join(" ");
const SHELL =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Taquería El Farolito</title>' +
  '<meta name="description" content="Tacos in Plano"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  `<style>body{margin:0}</style></head><body><nav>${NAV}</nav><!--forge-page--><footer>Taquería El Farolito</footer></body></html>`;
// Which build a page came from, so a rebuild is a different design.
let edition = "first";
const markup = (path: string) =>
  `<section class="page"><h1>${path === "/" ? "Taquería El Farolito" : path.slice(1)}</h1>${PICTURE}<p>The ${edition} ${path} page.</p></section>`;
const first = () =>
  `Built the frame and the home page.\n\n\`\`\`html shell\n${SHELL}\n\`\`\`\n\n\`\`\`html path="/" title="Taquería El Farolito"\n${markup("/")}\n\`\`\``;
const page = (path: string) => `Built ${path}.\n\n\`\`\`html path="${path}" title="${path.slice(1)}"\n${markup(path)}\n\`\`\``;

const encoder = new TextEncoder();
const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
const said = (content: string) => json({ choices: [{ message: { content } }] });
const delta = (fields: Record<string, unknown>, finish: string | null = null) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: fields, finish_reason: finish }] })}\n\n`;
const streamed = (...events: string[]) =>
  new Response(new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(event));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
// A reply that sends what it has and then only keeps the line open, until the
// step's own clock stops it.
const stalled = (init: RequestInit, ...events: string[]) =>
  new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(event));
      const tick = setInterval(() => controller.enqueue(encoder.encode(": keep-alive\n\n")), 20);
      init.signal?.addEventListener("abort", () => {
        clearInterval(tick);
        controller.error(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
      });
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });

// What a build call was asking for: the first turn, one page, a page carried
// on, or -- on a one-page reference -- the whole site in one reply.
type Asked = { kind: "first" | "page" | "carry" | "one"; path: string; messages: any[] };
const ASK = /^Write page \d+ of \d+ now: (\S+), and nothing else\./;
function asked(body: any): Asked {
  const messages = body.messages;
  const last = messages.at(-1).content as string;
  if (last === CARRY_ON) return { kind: "carry", path: messages.at(-3).content.match(ASK)?.[1] ?? "/", messages };
  const path = last.match(ASK)?.[1];
  if (path) return { kind: "page", path, messages };
  const firstTurn = messages.some((m: any) => m.role === "system" && /This turn writes the shell and the home page/.test(m.content));
  return { kind: firstTurn ? "first" : "one", path: "/", messages };
}

function stubProviders(answer: (turn: Asked, init: RequestInit) => Response) {
  const turns: Asked[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const worker = await answerDesignResearch(url, init, () => storeDesignPackage(active));
      if (worker) return worker;
      const body = JSON.parse(String(init.body));
      if (/generateContent/.test(url)) {
        return json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: PNG } }] } }] });
      }
      const system = body.messages.filter((m: any) => m.role === "system").map((m: any) => m.content).join("\n");
      if (/private website strategist/.test(system)) return said("Lead with the al pastor.");
      if (/maintain Forge's memory/.test(system)) return said('{"add":[],"forget":[],"replace":{}}');
      const turn = asked(body);
      turns.push(turn);
      return answer(turn, init);
    }),
  );
  return turns;
}
// The ordinary model: every turn answered whole and at once.
const answers = (turn: Asked) => said(turn.kind === "page" ? page(turn.path) : first());

async function createBuilder(t: T) {
  const { userId, sessionId } = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email: "m@example.com" });
    const sessionId = await ctx.db.insert("authSessions", { userId, expirationTime: Date.now() + 86_400_000 });
    return { userId, sessionId };
  });
  await t.mutation(internal.billing.grantPlan, { userId, plan: "starter" });
  return { userId, as: t.withIdentity({ subject: `${userId}|${sessionId}` }) };
}
type Member = Awaited<ReturnType<typeof createBuilder>>;

async function answerEverything(member: Member) {
  const id = await member.as.mutation(api.onboarding.start, {});
  for (let index = 0; index < QUESTIONS.length; index += 1) {
    await member.as.mutation(api.onboarding.save, { id, index, answer: ANSWERS[index] ?? "", advance: true });
  }
  return id;
}

// Scheduled functions sit on setTimeout: faked, they wait to be run by hand,
// which is how these tests take a chain one step at a time.
const hold = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
const drain = (t: T) => t.finishAllScheduledFunctions(() => {});

async function pending(t: T) {
  return await t.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").collect()).filter((job) => job.state.kind === "pending").map((job) => job.name));
}
async function dropScheduled(t: T) {
  await t.run(async (ctx) => {
    for (const job of await ctx.db.system.query("_scheduled_functions").collect()) {
      if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
    }
  });
}
const load = (t: T, id: Id<"buildDrafts">) => t.run(async (ctx) => (await ctx.db.get(id))!);
const brief = (t: T, id: Id<"siteOnboarding">) => t.run(async (ctx) => (await ctx.db.get(id))!);
const versions = (t: T) => t.run((ctx) => ctx.db.query("siteVersions").collect());
const holds = (t: T) => t.run(async (ctx) => (await ctx.db.query("creditHolds").collect()).map((row) => [row.requestKind, row.status]));
const events = (t: T) => t.run((ctx) => ctx.db.query("buildEvents").collect());

// Answer, submit, and run the research and the build by hand: the draft
// exists, and its first step is queued but has not run. Needs `hold()`.
async function toDraft(t: T, member: Member) {
  const id = await answerEverything(member);
  await member.as.mutation(api.onboarding.submit, { id });
  await t.action(internal.onboarding.research, { id, attempt: 1 });
  await t.action(internal.onboarding.build, { id, attempt: 1 });
  const draft = await t.run(async (ctx) => (await ctx.db.query("buildDrafts").collect()).find((row) => row.onboardingId === id)!);
  await dropScheduled(t);
  return { id, draft };
}

beforeEach(() => {
  process.env.AI_BASE_URL = "https://ai.example/v1/";
  process.env.AI_API_KEY = KEY;
  process.env.AI_MODEL = "forge-test";
  process.env.AI_IMAGE_API_KEY = "img-test-secret-key";
  process.env.CONVEX_SITE_URL = "https://forge-test.convex.site";
  setDesignRoutes(ROUTES);
  edition = "first";
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetDesignRoutes();
  for (const name of ["AI_BASE_URL", "AI_API_KEY", "AI_MODEL", "AI_IMAGE_API_KEY", "CONVEX_SITE_URL"]) delete process.env[name];
});

describe("the pieces a step is made of", () => {
  test("the measured routes become the pages to write, home first", () => {
    expect(pagePlan(["/food-menu", "/", "/Food-Menu/", "/drink-menu.html", "/../x"])).toEqual(["/", "/food-menu", "/drink-menu"]);
    expect(pagePlan(["/", "/a", "/b", "/c", "/d", "/e", "/f"])).toEqual(["/", "/a", "/b", "/c", "/d"]);
    expect(pagePlan(["/"])).toEqual(["/"]);
    expect(pagePlan(undefined)).toEqual(["/"]);
  });

  test("a later turn reads only its own route's measurements", () => {
    const spec = designPrompt(ROUTES);
    const events = routeSpec(spec, ["/events"]);
    expect(events.startsWith(DESIGN_PROMPT)).toBe(true);
    expect(events).toContain(`ROUTES: build exactly these pages and no others: ${ROUTES.join(", ")}.`);
    expect(events).toContain("ROUTE /events\n- desktop 1440px: the /events page is 3200px tall.");
    expect(events).not.toContain("ROUTE /food-menu");
    expect(events).not.toContain("ROUTE /\n");
    // A spec in another shape, or without the route, goes whole.
    expect(routeSpec(spec, ["/nowhere"])).toBe(spec);
    expect(routeSpec(DESIGN_PROMPT, ["/"])).toBe(DESIGN_PROMPT);
  });

  test("a reply is read block by block, and the block it stopped inside is named", () => {
    const text = `${first()}\n\n\`\`\`html path="/food-menu" title="Food menu"\n<section>half a menu`;
    const reply = readDraftReply(text);
    expect(reply.summary).toBe("Built the frame and the home page.");
    expect(reply.shell).toEqual({ body: SHELL, closed: true });
    expect(reply.pages.map((block) => [block.path, block.closed])).toEqual([["/", true], ["/food-menu", false]]);
    expect(reply.open).toMatchObject({ shell: false, path: "/food-menu" });
    expect(text.slice(reply.open!.at)).toBe('```html path="/food-menu" title="Food menu"\n<section>half a menu');
  });

  test("a turn keeps whole blocks, and the page it was stopped inside to carry on", () => {
    const empty = { routes: ROUTES, pages: [], shell: undefined };
    const read = (text: string, draft: Parameters<typeof readTurn>[1]["draft"], target: string, cut: boolean) =>
      readTurn(text, { draft, target, cut, referenceUrl: REFERENCE, imagery: false });
    const cutText = `${first()}\n\n\`\`\`html path="/food-menu" title="Food menu"\n<section>half`;
    const turn = read(cutText, empty, "/", true);
    expect(turn.shell).toBe(SHELL);
    expect(turn.summary).toBe("Built the frame and the home page.");
    expect(turn.pages.map((kept) => kept.path)).toEqual(["/"]);
    expect(turn.partial).toEqual({ path: "/food-menu", text: '```html path="/food-menu" title="Food menu"\n<section>half' });
    // Stopped inside the shell, the whole first reply is what goes on.
    const early = "Built it.\n\n```html shell\n<!doctype html><html><head>";
    expect(read(early, empty, "/", true)).toEqual({ pages: [], partial: { path: "/", text: early } });
    // A reply that ended on its own without its last fence finished that block.
    const framed = { routes: ROUTES, pages: [], shell: SHELL };
    expect(read(page("/food-menu").slice(0, -3), framed, "/food-menu", false).pages.map((kept) => kept.path)).toEqual(["/food-menu"]);
    // A page that breaks the design rules is not kept, and says why.
    const google = page("/food-menu").replace("<section", '<link href="https://fonts.googleapis.com/css2?family=Inter" rel="stylesheet"><section');
    expect(read(google, framed, "/food-menu", false)).toMatchObject({ pages: [], problem: expect.stringContaining("Fontshare") });
    // A page the reference does not have is not a page of this site.
    expect(read(page("/about"), framed, "/food-menu", false)).toMatchObject({ pages: [], problem: expect.stringContaining("no page at /food-menu") });
  });

  test("carrying a page on joins it where it stopped, and never doubles it", () => {
    const carried = '```html path="/events" title="Events"\n<section class="events"><h1>Events at El Farolito</h1><p>Every Friday night';
    const rest = ": live mariachi.</p></section>\n```";
    expect(joinCarry(carried, rest)).toBe(carried + rest);
    // A continuation that opens its fence again loses that line.
    expect(joinCarry(carried, `\`\`\`html path="/events" title="Events"\n${rest}`)).toBe(carried + rest);
    // One that starts the block over replaces what was there.
    const over = '<section class="events"><h1>Events at El Farolito</h1><p>Every Friday night: live mariachi.</p></section>\n```';
    expect(joinCarry(carried, over)).toBe(`\`\`\`html path="/events" title="Events"\n${over}`);
  });

  test("the next page is one part-written, then home with the shell, then the rest in measured order", () => {
    const home = { path: "/", title: "Home", body: markup("/") };
    expect(nextPage({ routes: ROUTES, pages: [], shell: undefined })).toBe("/");
    expect(nextPage({ routes: ROUTES, pages: [home], shell: SHELL })).toBe("/food-menu");
    expect(nextPage({ routes: ROUTES, pages: [home], shell: SHELL, partial: { path: "/events", text: "x", resumes: 1 } })).toBe("/events");
    expect(nextPage({ routes: ["/", "/party"], pages: [home, { path: "/party", title: "Party", body: "x" }], shell: SHELL })).toBeNull();
  });
});

describe("what each turn is asked", () => {
  const BASE = [
    { role: "system" as const, content: "HOUSE RULES" },
    { role: "user" as const, content: "Build the website from the saved onboarding brief." },
  ];
  const spec = designPrompt(ROUTES);
  const home = { path: "/", title: "Taquería El Farolito", body: markup("/") };
  const menu = { path: "/food-menu", title: "Food menu", body: markup("/food-menu") };
  const turn = (input: Partial<Parameters<typeof draftTurn>[0]>) =>
    draftTurn({ base: BASE, spec, routes: ROUTES, siteName: "Taquería El Farolito", brief: "BRIEF", target: "/", ...input });

  test("the first turn writes the shell and the home page, from the whole spec", () => {
    const messages = turn({ siteName: 'Taquería "El Farolito"' });
    expect(messages.slice(0, 2)).toEqual(BASE);
    expect(messages[2]).toEqual({ role: "system", content: spec });
    expect(messages[3].content).toContain("written a page at a time");
    expect(messages[3].content).toContain(ROUTES.join(", "));
    expect(messages[4].content).toContain("This turn writes the shell and the home page, and nothing else");
    expect(messages[4].content).toContain(`path="/" title="Taquería 'El Farolito'"`);
    expect(messages.at(-1)).toEqual({ role: "user", content: "File: website-build-brief.md\n\nBRIEF" });
    expect(messages.some((message) => message.role === "assistant")).toBe(false);
  });

  test("a later turn is handed the site so far as it was written, and asked for one page", () => {
    const messages = turn({ target: "/drink-menu", written: { summary: "Built the frame and the home page.", shell: SHELL, pages: [home, menu] } });
    expect(messages[2].content).toContain("ROUTE /drink-menu");
    expect(messages[2].content).not.toContain("ROUTE /food-menu");
    expect(messages.some((message) => /This turn writes the shell/.test(message.content))).toBe(false);
    const [file, written, ask] = messages.slice(-3);
    expect(file).toEqual({ role: "user", content: "File: website-build-brief.md\n\nBRIEF" });
    expect(written).toEqual({
      role: "assistant",
      content:
        `Built the frame and the home page.\n\n\`\`\`html shell\n${SHELL}\n\`\`\`\n\n` +
        `\`\`\`html path="/" title="Taquería El Farolito"\n${markup("/")}\n\`\`\`\n\n` +
        `\`\`\`html path="/food-menu" title="Food menu"\n${markup("/food-menu")}\n\`\`\``,
    });
    expect(ask.role).toBe("user");
    expect(ask.content).toMatch(/^Write page 3 of 5 now: \/drink-menu, and nothing else\./);
    expect(ask.content).toContain("do not return, repeat or change them");
    expect(ask.content).toContain('```html path="/drink-menu" title="Drink Menu"');
    // What was wrong with the last reply goes with the ask.
    const again = turn({ target: "/drink-menu", written: { shell: SHELL, pages: [home] }, problem: "the page came back empty. Write the whole page." });
    expect(again.at(-1)!.content).toContain("Your last reply for this page could not be used: the page came back empty.");
  });

  test("a page carried on goes back as the model's own words, with the ask to continue", () => {
    const carry = '```html path="/drink-menu" title="Drinks"\n<section>Horchata, jamaica';
    const messages = turn({ target: "/drink-menu", written: { shell: SHELL, pages: [home, menu] }, carry });
    expect(messages.at(-3)!.content).toMatch(/^Write page 3 of 5 now: \/drink-menu/);
    expect(messages.slice(-2)).toEqual([{ role: "assistant", content: carry }, { role: "user", content: CARRY_ON }]);
    // The first turn carried on answers the brief itself.
    const opening = "Built it.\n\n```html shell\n<!doctype html>";
    const firstAgain = turn({ carry: opening });
    expect(firstAgain.at(-3)!.content).toContain("website-build-brief.md");
    expect(firstAgain.slice(-2)).toEqual([{ role: "assistant", content: opening }, { role: "user", content: CARRY_ON }]);
  });

  test("a site too big to show whole keeps the shell and the home page, and names the rest", () => {
    const big = (path: string) => ({ path, title: path, body: "x".repeat(120000) });
    const written = turn({ target: "/cater", written: { shell: SHELL, pages: [home, big("/food-menu"), big("/drink-menu")] } }).at(-2)!.content;
    expect(written).toContain('path="/"');
    expect(written).toContain('path="/food-menu"');
    expect(written).not.toContain('path="/drink-menu"');
    expect(written).toContain("Also written and saved, not shown here: /drink-menu.");
  });
});

describe("checkpoints", () => {
  test("a draft is fingerprinted to its measure, saves pages as they close, and a stale copy saves nothing", async () => {
    hold();
    const t = fresh();
    const member = await createBuilder(t);
    stubProviders(answers);
    const { id, draft } = await toDraft(t, member);
    const design = (await t.run((ctx) => ctx.db.query("siteDesignPackages").first()))!;
    expect(draft).toMatchObject({
      status: "writing", attempt: 1, routes: ROUTES, pages: [], step: 0, tries: 0, rebuild: false, model: "forge-test",
      designId: design._id, designStorageId: design.storageId, onboardingId: id,
    });
    expect(draft.shell).toBeUndefined();
    expect(await brief(t, id)).toMatchObject({ status: "building" });
    expect(await holds(t)).toEqual([["generate", "held"]]);

    const claimed = (await t.mutation(internal.buildDraft.claim, { id: draft._id }))!;
    // One copy at a time: a second finds it held.
    expect(await t.mutation(internal.buildDraft.claim, { id: draft._id })).toBeNull();
    const home = { path: "/", title: "Taquería El Farolito", body: markup("/") };
    expect(await t.mutation(internal.buildDraft.keep, { id: draft._id, lease: "not-mine", shell: SHELL, pages: [home] })).toBeNull();
    const kept = (await t.mutation(internal.buildDraft.keep, { id: draft._id, lease: claimed.lease, shell: SHELL, summary: "Built it.", pages: [home] }))!;
    expect(kept).toMatchObject({ shell: SHELL, summary: "Built it.", pages: [home], tries: 0 });
    // A page the reference does not have is never kept.
    await t.mutation(internal.buildDraft.keep, { id: draft._id, lease: claimed.lease, pages: [{ path: "/about", title: "About", body: "<p>x</p>" }] });

    // Loaded again from the table, as the next step finds it.
    const saved = await load(t, draft._id);
    expect(saved).toMatchObject({ shell: SHELL, pages: [home], lease: claimed.lease, step: 1 });
    expect(nextPage(saved)).toBe("/food-menu");
    const inspected = (await t.query(internal.buildDraft.inspect, {}))[0];
    expect(inspected).toMatchObject({ status: "writing", written: ["/"], remaining: ROUTES.slice(1), partial: null, step: 1 });
    expect(JSON.stringify(inspected)).not.toContain("<section");
  });

  test("with its clock short a step stops at the page boundary and queues the next; with time it writes on and hands the site over", async () => {
    hold();
    const t = fresh();
    const member = await createBuilder(t);
    const turns = stubProviders(answers);
    const { id, draft } = await toDraft(t, member);

    await t.action(internal.buildDraft.write, { id: draft._id, budgetMs: 1000 });
    // One turn -- the shell and the home page -- then the boundary.
    expect(turns.map((turn) => turn.kind)).toEqual(["first"]);
    let row = await load(t, draft._id);
    expect(row).toMatchObject({ shell: SHELL, step: 1, tries: 0 });
    expect(row.pages.map((kept) => kept.path)).toEqual(["/"]);
    expect(row.lease).toBeUndefined();
    // The next step is already queued. Nobody has to press anything.
    expect((await pending(t)).filter((name) => name === "buildDraft:write")).toHaveLength(1);
    await dropScheduled(t);

    await t.action(internal.buildDraft.write, { id: draft._id, budgetMs: 1000 });
    expect(turns.map((turn) => turn.path)).toEqual(["/", "/food-menu"]);
    expect((await load(t, draft._id)).pages.map((kept) => kept.path)).toEqual(["/", "/food-menu"]);
    expect((await pending(t)).filter((name) => name === "buildDraft:write")).toHaveLength(1);
    await dropScheduled(t);
    expect(await t.run((ctx) => ctx.db.query("designGates").collect())).toEqual([]);

    // A whole clock: every page left, then the layout check.
    await t.action(internal.buildDraft.write, { id: draft._id });
    expect(turns.map((turn) => turn.path)).toEqual(ROUTES);
    row = await load(t, draft._id);
    expect(row).toMatchObject({ status: "done", pages: [], step: 3 });
    expect(row.shell).toBeUndefined();
    const gates = await t.run((ctx) => ctx.db.query("designGates").collect());
    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({ status: "checking", source: "onboarding", round: 1, shell: SHELL, onboardingId: id, attempt: 1 });
    expect(gates[0].pages!.map((kept) => kept.path)).toEqual(ROUTES);
    expect(await pending(t)).toContain("designGate:check");
  });
});

describe("a five-page rebuild, start to finish", () => {
  test("its first draft is written across several actions with nobody pressing anything, then checked and saved once", async () => {
    // Every page takes most of a step's clock, so each step writes one page
    // and hands on. The scheduler runs every step itself.
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
    const t = fresh();
    const member = await createBuilder(t);
    const turns = stubProviders((turn) => {
      vi.setSystemTime(Date.now() + 250_000);
      return answers(turn);
    });
    const id = await answerEverything(member);
    await member.as.mutation(api.onboarding.submit, { id });
    await drain(t);
    expect(await brief(t, id)).toMatchObject({ status: "complete", attempt: 1 });
    const balance = (await member.as.query(api.billing.summary, {}))!.credits;

    edition = "second";
    const built = turns.length;
    await member.as.mutation(api.onboarding.rebuild, {});
    await drain(t);

    // Seven steps, each an action the scheduler started on its own.
    const drafts = await t.run((ctx) => ctx.db.query("buildDrafts").collect());
    const rebuilt = drafts.find((row) => row.attempt === 2)!;
    expect(rebuilt).toMatchObject({ status: "done", rebuild: true, step: 5, tries: 0, routes: ROUTES });
    const steps = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter((job) => job.name === "buildDraft:write" && job.args[0].id === rebuilt._id));
    expect(steps.map((job) => job.state.kind)).toEqual(Array(5).fill("success"));
    const asked = turns.slice(built);
    expect(asked.map((turn) => [turn.kind, turn.path])).toEqual(ROUTES.map((path) => [path === "/" ? "first" : "page", path]));
    // Each page was asked for with its own measurements and the site before it.
    for (const [index, turn] of asked.entries()) {
      if (turn.kind !== "page") continue;
      const spec = turn.messages.find((m: any) => m.role === "system" && m.content.startsWith(DESIGN_PROMPT)).content;
      expect(spec).toContain(`ROUTE ${turn.path}\n`);
      for (const other of ROUTES.filter((path) => path !== turn.path)) expect(spec).not.toContain(`ROUTE ${other}\n`);
      const written = turn.messages.at(-2);
      expect(written.role).toBe("assistant");
      for (const before of ROUTES.slice(0, index)) expect(written.content).toContain(`\`\`\`html path="${before}"`);
      expect(written.content).not.toContain(`\`\`\`html path="${turn.path}"`);
    }
    // A rebuild owes new pictures: its home page was asked for them.
    expect(asked[0].messages.some((m: any) => /Include at least one new subject-relevant photograph/.test(m.content))).toBe(true);

    // The layout check ran once, on the whole draft, and passed it.
    const gates = await t.run((ctx) => ctx.db.query("designGates").collect());
    const gate = gates.find((row) => row.attempt === 2)!;
    expect(gate).toMatchObject({ status: "passed", round: 1 });
    expect(gate.results).toHaveLength(1);
    const phases = await t.run(async (ctx) =>
      (await ctx.db.query("buildEvents").withIndex("by_run_at", (q) => q.eq("runId", rebuilt.runId)).collect()).map((event) => event.phase));
    expect(phases.filter((phase) => phase === "draft_page_done")).toHaveLength(6);
    expect(phases.lastIndexOf("draft_page_done")).toBeLessThan(phases.indexOf("draft_done"));
    expect(phases.indexOf("draft_done")).toBeLessThan(phases.indexOf("layout_check"));

    // Saved once, every page in measured order, pictures made, published.
    const [version] = await versions(t);
    expect(await versions(t)).toHaveLength(1);
    expect(version.shell).toBe(SHELL);
    expect(version.pages!.map((kept) => kept.path)).toEqual(ROUTES);
    for (const kept of version.pages!) {
      expect(kept.body).toContain(`The second ${kept.path} page.`);
      expect(kept.body).not.toContain("forge-image:");
    }
    expect(version.summary).toBe("Built the frame and the home page.");
    expect(await brief(t, id)).toMatchObject({ status: "complete", attempt: 2 });
    const site = (await t.run((ctx) => ctx.db.query("sites").first()))!;
    expect(site).toMatchObject({ status: "published", currentVersionId: version._id });
    // One build's credits, held once across every step and settled once.
    expect((await holds(t)).filter(([kind]) => kind === "generate")).toEqual([["generate", "settled"], ["generate", "settled"]]);
    expect(await member.as.query(api.billing.summary, {})).toMatchObject({
      reserved: 0,
      credits: balance - REQUEST_COSTS.generate - REQUEST_COSTS.image,
    });
    // The member's log reads page by page.
    const labels = (await events(t)).map((event) => event.label);
    expect(labels).toEqual(expect.arrayContaining([
      "Writing your 5 pages one at a time",
      "Writing page 1 of 5: home, with the header, menu and footer",
      "Wrote the header, menu and footer",
      "Wrote page 1 of 5: home",
      "Writing page 2 of 5: /food-menu",
      "Wrote page 5 of 5: /events",
      "Wrote all 5 pages",
    ]));
    // "Page written" moves the progress drawing on to the pictures, so no
    // page of a draft says it.
    expect(labels).not.toContain("Page written");
  });

  test("a page the step's clock stopped part way is carried on from that character, not started again", async () => {
    setDesignRoutes(["/", "/food-menu"]);
    hold();
    const t = fresh();
    const member = await createBuilder(t);
    const menu = markup("/food-menu");
    const cut = menu.indexOf("<p>");
    const opening = `Built the menu.\n\n\`\`\`html path="/food-menu" title="Food menu"\n${menu.slice(0, cut)}`;
    const turns = stubProviders((turn, init) => {
      if (turn.kind === "first") return said(first());
      if (turn.kind === "page") return stalled(init, delta({ reasoning_content: "Plan the menu." }), delta({ content: opening }));
      return said(`${menu.slice(cut)}\n\`\`\``);
    });
    const { id, draft } = await toDraft(t, member);
    await t.action(internal.buildDraft.write, { id: draft._id, budgetMs: 1000 });
    await dropScheduled(t);
    vi.useRealTimers();

    // The step's clock runs out while the page is being written.
    await t.action(internal.buildDraft.write, { id: draft._id, budgetMs: 1500 });
    await drain(t);

    expect(turns.map((turn) => [turn.kind, turn.path])).toEqual([["first", "/"], ["page", "/food-menu"], ["carry", "/food-menu"]]);
    const carry = turns[2].messages;
    const kept = `\`\`\`html path="/food-menu" title="Food menu"\n${menu.slice(0, cut)}`;
    expect(carry.at(-3).content).toMatch(/^Write page 2 of 2 now: \/food-menu/);
    expect(carry.slice(-2)).toEqual([{ role: "assistant", content: kept }, { role: "user", content: CARRY_ON }]);

    // What the first reply wrote, then the rest: one page, whole.
    const [version] = await versions(t);
    const saved = version.pages!.find((kept) => kept.path === "/food-menu")!.body;
    const plain = (html: string) => html.replace(/<img\b[^>]*>/g, "<img>");
    expect(plain(saved)).toBe(plain(menu));
    expect(await brief(t, id)).toMatchObject({ status: "complete" });

    const log = await events(t);
    expect(log.find((event) => event.phase === "draft_partial")).toMatchObject({
      label: "Saved page 2 of 2 as far as it got: /food-menu",
      detail: expect.objectContaining({ stopReason: "out_of_time", streamPhase: "writing", replyChars: kept.length, path: "/food-menu" }),
    });
    expect(log.map((event) => event.label)).toContain("Carrying on page 2 of 2 from where it stopped: /food-menu");
    // A kept page is a checkpoint, never a stop.
    expect(log.filter((event) => event.phase === "provider_stop")).toEqual([]);
  });

  test("a step whose clock runs out while the model is still thinking is tried again, and the build lands", async () => {
    setDesignRoutes(["/", "/food-menu"]);
    hold();
    const t = fresh();
    const member = await createBuilder(t);
    let thinking = true;
    const turns = stubProviders((turn, init) => {
      if (turn.kind === "page" && thinking) {
        thinking = false;
        return stalled(init, delta({ reasoning_content: "Weigh the menu layout against the measured sections." }));
      }
      return answers(turn);
    });
    const { id, draft } = await toDraft(t, member);
    await t.action(internal.buildDraft.write, { id: draft._id, budgetMs: 1000 });
    await dropScheduled(t);
    vi.useRealTimers();

    await t.action(internal.buildDraft.write, { id: draft._id, budgetMs: 1200 });
    await drain(t);

    expect(turns.filter((turn) => turn.kind === "page").map((turn) => turn.path)).toEqual(["/food-menu", "/food-menu"]);
    expect(await load(t, draft._id)).toMatchObject({ status: "done", tries: 0, lastStop: expect.objectContaining({ reason: "out_of_time", phase: "thinking" }) });
    expect(await brief(t, id)).toMatchObject({ status: "complete" });
    expect((await versions(t))[0].pages!.map((kept) => kept.path)).toEqual(["/", "/food-menu"]);
    const labels = (await events(t)).map((event) => event.label);
    expect(labels).toContain("The build ran out of time while the model was thinking");
    expect(labels).toContain("Writing page 2 of 2 again: /food-menu");
  });
});

describe("when a draft cannot go on", () => {
  test("a page that keeps failing stops the build after a few steps, says why, and gives the credits back", async () => {
    setDesignRoutes(["/", "/food-menu"]);
    const t = fresh();
    const member = await createBuilder(t);
    // The model starts thinking about the menu and the connection goes, every time.
    const turns = stubProviders((turn) => (turn.kind === "page" ? streamed(delta({ reasoning_content: "Planning the menu." })) : said(first())));
    const id = await answerEverything(member);
    await member.as.mutation(api.onboarding.submit, { id });
    await drain(t);

    // Each step asks twice -- a dropped reply gets one fresh go -- and there are three steps.
    expect(turns.filter((turn) => turn.kind === "page")).toHaveLength(STEP_TRIES * 2);
    const row = await brief(t, id);
    expect(row.status).toBe("failed");
    expect(row.error).toBe("The connection to the model dropped before it started writing your website. Try again. Your answers are saved.");
    expect(await versions(t)).toEqual([]);
    expect((await holds(t)).filter(([kind]) => kind === "generate")).toEqual([["generate", "released"]]);
    const [draft] = await t.run((ctx) => ctx.db.query("buildDrafts").collect());
    expect(draft).toMatchObject({ status: "failed", tries: STEP_TRIES, pages: [], lastStop: expect.objectContaining({ reason: "dropped", phase: "thinking" }) });
    expect(draft.shell).toBeUndefined();
    const [run] = await t.run((ctx) => ctx.db.query("buildRuns").collect());
    expect(run).toMatchObject({ status: "failed", errorClass: "stream_dropped" });
    expect((await events(t)).map((event) => event.label)).toContain("Stopped at page 2 of 2: /food-menu");
    expect((await pending(t)).filter((name) => name === "buildDraft:write")).toEqual([]);
  });

  test("once its tries are spent, a draft whose clock ran out while thinking says so, in the words any build uses", async () => {
    hold();
    const t = fresh();
    const member = await createBuilder(t);
    stubProviders(answers);
    const { id, draft } = await toDraft(t, member);
    const { lease } = (await t.mutation(internal.buildDraft.claim, { id: draft._id }))!;
    await t.run((ctx) => ctx.db.patch(draft._id, { tries: STEP_TRIES - 1 }));
    const outcome = await t.mutation(internal.buildDraft.stepped, {
      id: draft._id,
      lease,
      outcome: "nothing",
      reason: "The model was still thinking your website through when the build ran out of time. Try again.",
      stop: { reason: "out_of_time", phase: "thinking", reasoningChars: 90000 },
    });
    expect(outcome).toBe("failed");
    const row = await brief(t, id);
    expect(row).toMatchObject({
      status: "failed",
      error: "The model was still thinking your website through when the build ran out of time. Try again. Your answers are saved.",
    });
    expect(row.holdId).toBeUndefined();
    expect(await holds(t)).toEqual([["generate", "released"]]);
    expect(await load(t, draft._id)).toMatchObject({ status: "failed", lastStop: expect.objectContaining({ reason: "out_of_time", phase: "thinking" }) });
    const [run] = await t.run((ctx) => ctx.db.query("buildRuns").collect());
    expect(run).toMatchObject({ status: "failed", errorClass: "out_of_time" });
  });

  test("a reply that cannot be used is named in the log, and the next step is told what to put right", async () => {
    setDesignRoutes(["/", "/food-menu"]);
    const t = fresh();
    const member = await createBuilder(t);
    let empty = true;
    const turns = stubProviders((turn) => {
      if (turn.kind === "page" && empty) {
        empty = false;
        return said('Built the menu.\n\n```html path="/food-menu" title="Food menu"\n\n```');
      }
      return answers(turn);
    });
    const id = await answerEverything(member);
    await member.as.mutation(api.onboarding.submit, { id });
    await drain(t);
    const pages = turns.filter((turn) => turn.kind === "page");
    expect(pages).toHaveLength(2);
    expect(pages[1].messages.at(-1).content).toContain("Your last reply for this page could not be used: the page came back empty. Write the whole page.");
    const labels = (await events(t)).map((event) => event.label);
    expect(labels).toContain("Page 2 of 2 could not be used: the page came back empty.");
    expect(labels).toContain("Writing page 2 of 2 again: /food-menu");
    expect(await brief(t, id)).toMatchObject({ status: "complete" });
  });

  test("a page that keeps stopping part way, or a draft that takes too many steps, stops rather than going round", async () => {
    hold();
    const t = fresh();
    const member = await createBuilder(t);
    stubProviders(answers);
    const { id, draft } = await toDraft(t, member);
    await t.run((ctx) => ctx.db.patch(draft._id, {
      shell: SHELL,
      pages: [{ path: "/", title: "Home", body: markup("/") }],
      partial: { path: "/food-menu", text: '```html path="/food-menu"\n<section>', resumes: MOST_RESUMES },
    }));
    const { lease } = (await t.mutation(internal.buildDraft.claim, { id: draft._id }))!;
    const outcome = await t.mutation(internal.buildDraft.stepped, {
      id: draft._id, lease, outcome: "partial", partial: { path: "/food-menu", text: '```html path="/food-menu"\n<section><h1>More' },
    });
    expect(outcome).toBe("failed");
    expect(await brief(t, id)).toMatchObject({ status: "failed", error: "Your website couldn’t be completed. Your answers are saved. Try building again." });
    expect((await events(t)).map((event) => event.label)).toContain("Stopped at page 2 of 5: it kept stopping part way");

    // A second member's draft that has already taken its most steps.
    const other = await createBuilder(t);
    const second = await toDraft(t, other);
    await t.run((ctx) => ctx.db.patch(second.draft._id, { step: ROUTES.length * 4 + 2 }));
    await t.action(internal.buildDraft.write, { id: second.draft._id });
    expect(await brief(t, second.id)).toMatchObject({ status: "failed" });
    expect((await events(t)).map((event) => event.label)).toContain("Stopped before every page was written");
  });

  test("a provider that refuses the request stops the build at once rather than asking again", async () => {
    setDesignRoutes(["/", "/food-menu"]);
    const t = fresh();
    const member = await createBuilder(t);
    const turns = stubProviders((turn) =>
      turn.kind === "page" ? new Response(JSON.stringify({ error: { message: "Model Not Exist" } }), { status: 400 }) : said(first()));
    const id = await answerEverything(member);
    await member.as.mutation(api.onboarding.submit, { id });
    await drain(t);
    expect(turns.filter((turn) => turn.kind === "page")).toHaveLength(1);
    expect((await brief(t, id)).error).toContain("answered 400: Model Not Exist");
    expect(await t.run(async (ctx) => (await ctx.db.query("buildDrafts").first())!.tries)).toBe(1);
  });

  test("a step the platform lost is started again from the last saved page, and a draft that keeps going quiet stops", async () => {
    hold();
    const t = fresh();
    const member = await createBuilder(t);
    const turns = stubProviders(answers);
    const { id, draft } = await toDraft(t, member);
    await t.action(internal.buildDraft.write, { id: draft._id, budgetMs: 1000 });
    // The step it queued is lost: nothing runs it, and nothing beats.
    await dropScheduled(t);
    const quiet = (seconds: number) => t.run((ctx) => ctx.db.patch(draft._id, { beatAt: Date.now() - seconds * 1000 }));

    await t.mutation(internal.buildDraft.rescue, {});
    expect(await pending(t)).toEqual([]);
    await quiet(120);
    await t.mutation(internal.buildDraft.rescue, {});
    expect(await pending(t)).toEqual(["buildDraft:write"]);
    expect(await load(t, draft._id)).toMatchObject({ restarts: 1 });
    expect((await events(t)).map((event) => event.label)).toContain("Started page 2 of 5 again: nothing had been heard from it for 120s");
    await dropScheduled(t);

    // Restarted, it carries on from the saved page rather than from nothing.
    await t.action(internal.buildDraft.write, { id: draft._id, budgetMs: 1000 });
    expect(turns.map((turn) => turn.path)).toEqual(["/", "/food-menu"]);
    expect(await load(t, draft._id)).toMatchObject({ restarts: 0 });
    await dropScheduled(t);

    for (let restart = 1; restart <= MOST_RESTARTS; restart += 1) {
      await quiet(120);
      await t.mutation(internal.buildDraft.rescue, {});
      await dropScheduled(t);
    }
    expect(await brief(t, id)).toMatchObject({ status: "building" });
    await quiet(120);
    await t.mutation(internal.buildDraft.rescue, {});
    const stopped = await brief(t, id);
    expect(stopped).toMatchObject({ status: "failed", error: "The build stopped responding. Your answers are saved. Try building again." });
    expect(await holds(t)).toEqual([["generate", "released"]]);
    expect(await load(t, draft._id)).toMatchObject({ status: "failed", pages: [] });
  });

  test("the attempt's watchdog waits while its draft is beating, and speaks once it is quiet", async () => {
    hold();
    const t = fresh();
    const member = await createBuilder(t);
    stubProviders(answers);
    const { id, draft } = await toDraft(t, member);
    const long = Date.now() - 600_000;
    await t.run((ctx) => ctx.db.patch(id, { updatedAt: long }));
    await t.mutation(internal.onboarding.expire, { id, attempt: 1 });
    expect(await brief(t, id)).toMatchObject({ status: "building" });
    expect(await pending(t)).toEqual(["onboarding:expire"]);

    await t.run((ctx) => ctx.db.patch(draft._id, { beatAt: long }));
    await t.mutation(internal.onboarding.expire, { id, attempt: 1 });
    expect(await brief(t, id)).toMatchObject({ status: "failed", error: "The build stopped responding. Your answers are saved. Try building again." });
    expect(await load(t, draft._id)).toMatchObject({ status: "failed", pages: [] });
  });

  test("a member who cancels mid-draft stops it: the next step writes nothing and nothing reaches the layout check", async () => {
    hold();
    const t = fresh();
    const member = await createBuilder(t);
    const turns = stubProviders(answers);
    const { draft } = await toDraft(t, member);
    await t.action(internal.buildDraft.write, { id: draft._id, budgetMs: 1000 });
    await member.as.mutation(api.onboarding.cancel, {});
    expect(await load(t, draft._id)).toMatchObject({ status: "cancelled", pages: [] });
    await t.action(internal.buildDraft.write, { id: draft._id });
    expect(turns).toHaveLength(1);
    expect(await t.run((ctx) => ctx.db.query("designGates").collect())).toEqual([]);
    expect(await holds(t)).toEqual([["generate", "released"]]);
  });

  test("a step that finds the site measured again writes nothing against the old measure", async () => {
    hold();
    const t = fresh();
    const member = await createBuilder(t);
    const turns = stubProviders(answers);
    const { id, draft } = await toDraft(t, member);
    const other = await storeDesignPackage(t);
    await t.run((ctx) => ctx.db.patch(draft.designId, { storageId: other }));
    await t.action(internal.buildDraft.write, { id: draft._id });
    expect(turns).toEqual([]);
    expect(await brief(t, id)).toMatchObject({ status: "failed", error: "The saved design reference disappeared during the build. Your answers are saved." });
    expect(await load(t, draft._id)).toMatchObject({ status: "failed" });
  });
});

describe("a one-page reference", () => {
  test("is still written in one reply, with no draft at all", async () => {
    setDesignRoutes(["/"]);
    const t = fresh();
    const member = await createBuilder(t);
    const turns = stubProviders(answers);
    const id = await answerEverything(member);
    await member.as.mutation(api.onboarding.submit, { id });
    await drain(t);
    expect(turns.map((turn) => turn.kind)).toEqual(["one"]);
    expect(await t.run((ctx) => ctx.db.query("buildDrafts").collect())).toEqual([]);
    expect(await brief(t, id)).toMatchObject({ status: "complete" });
    expect((await versions(t))[0].pages!.map((kept) => kept.path)).toEqual(["/"]);
  });
});
