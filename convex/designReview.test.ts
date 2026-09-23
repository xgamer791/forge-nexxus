/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { answerDesignResearch, auditCalls, crewCall, DESIGN_PROMPT, partReply, resetAuditScript, storeDesignPackage } from "./designWorkerMock";
import {
  chromeHash,
  designReviewOn,
  elided,
  lostPageStyles,
  needsReview,
  readVerdict,
  unnamedParts,
} from "./designCheck";
import { parseReply, parseShellReply } from "./generate";
import { QUESTIONS } from "./onboardingQuestions";
import schema from "./schema";

// The second agent. A build's header, dropdown menu and footer go to a
// separate design reviewer before the build is saved, and come back to the
// design agent until the reviewer agrees. The scheduler runs for real, so a
// check and its reworks run the way they would on Convex.
const modules = import.meta.glob("./**/*.*s");
function makeTest() {
  return convexTest(schema, modules);
}
type T = ReturnType<typeof makeTest>;
let active: T;
const fresh = () => (active = makeTest());

async function createBuilder(t: T, email: string) {
  const { userId, sessionId } = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email });
    const sessionId = await ctx.db.insert("authSessions", { userId, expirationTime: Date.now() + 60_000 });
    return { userId, sessionId };
  });
  await t.mutation(internal.billing.grantPlan, { userId, plan: "starter" });
  return { userId, as: t.withIdentity({ subject: `${userId}|${sessionId}` }) };
}
type Member = Awaited<ReturnType<typeof createBuilder>>;

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
  "Pier Roast 250g — £11",
];

async function answerEverything(member: Member) {
  const id = await member.as.mutation(api.onboarding.start, {});
  for (let index = 0; index < QUESTIONS.length; index += 1) {
    await member.as.mutation(api.onboarding.save, { id, index, answer: ANSWERS[index], advance: true });
  }
  return id;
}

const CLONES = [
  "Header: Locomotive, https://locomotive.ca",
  "A 96px bar: wordmark left, four links right at 15px, 40px side padding.",
  "Dropdown menu: Locomotive, https://locomotive.ca",
  "A full-width panel that drops from the bar, links at 48px, 40px padding.",
  "Footer: Locomotive, https://locomotive.ca",
  "A four-column grid over a 12vw wordmark, 80px top padding.",
].join("\n");

const PAGE_STYLES = ".menu-card{padding:24px}.hours{display:grid}";
const shell = (css = "", pageStyles = PAGE_STYLES) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Harbor Roasters</title>` +
  `<style>body{margin:0}${pageStyles}${css}</style></head><body><header class="bar"><a href="/">Harbor Roasters</a>` +
  `<button class="menu-button" aria-expanded="false">Beans and hours</button><nav class="drop"><a href="/">Home</a></nav></header>` +
  `<!--forge-page--><footer class="foot">Pier 4, Port Ellen</footer></body></html>`;
const HOME =
  `<main><h1>Harbor Roasters</h1><div class="menu-card">Pier Roast</div><ul class="hours"><li>7am</li></ul>` +
  `<img src="forge-image:1" data-forge-image="Morning light on the roastery counter" data-forge-aspect="16:9" alt="The roastery counter" width="1600" height="900"></main>`;

const fence = (info: string, body: string) => `\`\`\`${info}\n${body}\n\`\`\``;
function siteReply(options: { clones?: string | null; shell?: string; home?: string; summary?: string } = {}) {
  return [
    options.summary ?? "Built a harbour-side site for Harbor Roasters.",
    ...(options.clones === null ? [] : [fence("clones", options.clones ?? CLONES)]),
    fence("html shell", options.shell ?? shell()),
    fence('html path="/" title="Home"', options.home ?? HOME),
  ].join("\n\n");
}
const reworkReply = (reworked: string, clones = CLONES) =>
  ["Made the header 96px tall.", fence("clones", clones), fence("html shell", reworked)].join("\n\n");

const part = (equal: boolean, difference?: string) => ({
  original: "Locomotive, https://locomotive.ca",
  equal,
  differences: difference ? [difference] : [],
});
const AGREE = JSON.stringify({ equal: true, header: part(true), menu: part(true), footer: part(true), fixes: [] });
const PNG = btoa("not really a png, but bytes are bytes");
const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
const answer = (content: string) => json({ choices: [{ message: { content } }] });

type Call = { url: string; body: any };
const systemOf = (call: Call) =>
  call.body.messages.filter((message: any) => message.role === "system").map((message: any) => message.content).join("\n");
const lastUser = (call: Call) => call.body.messages.filter((message: any) => message.role === "user").at(-1)?.content ?? "";

// The design agent and the design reviewer, told apart by their instructions.
// The strategist and the memory note are answered so they stay out of the way,
// and a first build's crew builders get their parts (the auditors are the
// double's).
function stubAgents(agents: { build: (call: number) => string; review: (call: number) => string | Promise<string> }) {
  const calls: Call[] = [];
  let builds = 0;
  let reviews = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const research = await answerDesignResearch(url, init, () => storeDesignPackage(active));
      if (research) return research;
      const body = JSON.parse(String(init.body));
      const call = { url, body };
      calls.push(call);
      if (/generateContent/.test(url)) {
        return json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: PNG } }] } }] });
      }
      const system = systemOf(call);
      if (/private website strategist/.test(system)) return answer("Lead with the roastery.");
      if (/You maintain Forge's memory/.test(system)) return answer('{"add":[],"forget":[],"replace":{}}');
      if (/You are Forge's design reviewer/.test(system)) return answer(await agents.review(++reviews));
      const crew = crewCall(body);
      if (crew) return answer(partReply(crew));
      return answer(agents.build(++builds));
    }),
  );
  const chat = () => calls.filter((call) => /chat\/completions/.test(call.url));
  return {
    builds: () => chat().filter((call) => !crewCall(call.body) && !/You are Forge's design reviewer|private website strategist|You maintain Forge's memory/.test(systemOf(call))),
    crew: () => chat().filter((call) => crewCall(call.body)),
    reviews: () => chat().filter((call) => /You are Forge's design reviewer/.test(systemOf(call))),
  };
}

const drain = (t: T) => t.finishAllScheduledFunctions(() => {});
const holds = (t: T) => t.run(async (ctx) => (await ctx.db.query("creditHolds").collect()).map((hold) => [hold.requestKind, hold.status]));
const versions = (t: T) => t.run((ctx) => ctx.db.query("siteVersions").collect());
const reviews = (t: T) => t.run((ctx) => ctx.db.query("designReviews").collect());

beforeEach(() => {
  process.env.AI_BASE_URL = "https://ai.example/v1/";
  process.env.AI_API_KEY = "sk-test-secret-key";
  process.env.AI_MODEL = "forge-test";
  process.env.AI_IMAGE_API_KEY = "img-test-secret-key";
  process.env.CONVEX_SITE_URL = "https://forge-test.convex.site";
  process.env.DESIGN_REVIEW = "on";
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetAuditScript();
  for (const name of ["AI_BASE_URL", "AI_API_KEY", "AI_MODEL", "AI_BUILD_MODEL", "AI_IMAGE_API_KEY", "CONVEX_SITE_URL", "DESIGN_REVIEW_ROUNDS"]) {
    delete process.env[name];
  }
  process.env.DESIGN_REVIEW = "off";
});

// A member's first site, researched and saved. The Awwwards reviewer is retired.
async function firstSite(t: T, member: Member) {
  const id = await answerEverything(member);
  await member.as.mutation(api.onboarding.submit, { id });
  await drain(t);
  const row = (await t.run((ctx) => ctx.db.get(id)))!;
  const site = (await t.run((ctx) => ctx.db.get(row.siteId!)))!;
  return { id, site };
}

describe("a first build researches a SkillUI Ultra design reference and saves", () => {
  test("the worker runs once, the package is kept, the crew and its auditors build it, and the retired reviewer is not called", async () => {
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    const agents = stubAgents({ build: () => siteReply(), review: () => AGREE });

    const id = await answerEverything(member);
    await member.as.mutation(api.onboarding.submit, { id });
    await drain(t);

    expect(agents.builds()).toHaveLength(0);
    expect(agents.crew()).toHaveLength(4);
    expect(auditCalls()).toHaveLength(4);
    expect(agents.reviews()).toHaveLength(0);
    expect(await reviews(t)).toEqual([]);
    const brief = (await t.run((ctx) => ctx.db.get(id)))!;
    expect(brief).toMatchObject({ status: "complete" });
    expect(brief.error).toBeUndefined();
    const design = await t.run((ctx) => ctx.db.query("siteDesignPackages").withIndex("by_site", (q) => q.eq("siteId", brief.siteId!)).unique());
    expect(design).toMatchObject({ prompt: DESIGN_PROMPT, inspectedPages: 1, format: "skillui-ultra-v1" });
    const events = await t.run((ctx) => ctx.db.query("buildEvents").collect());
    expect(events.map((event) => event.phase)).toEqual(expect.arrayContaining([
      "research", "research_searching", "research_candidate", "research_vision", "research_vision_accepted", "research_discovering", "research_skillui", "research_uploading", "research_done",
      "design_loaded", "draft_start", "crew_page", "crew_built", "crew_agreed", "crew_page_done", "draft_done", "complete",
    ]));
    expect(events.map((event) => event.phase)).not.toContain("layout_check");
    expect(await versions(t)).toHaveLength(1);
    expect((await holds(t)).filter(([kind]) => kind === "generate")).toEqual([["generate", "settled"]]);
    for (const call of agents.crew()) {
      expect(systemOf(call)).toContain(DESIGN_PROMPT);
      expect(systemOf(call)).not.toContain("```clones");
    }
    expect(brief.events.map((event) => event.label)).not.toContain("Header, menu and footer sent back for changes");
  });

  test("a missing worker fails the build before the model is asked and spends nothing", async () => {
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    delete process.env.DESIGN_WORKER_URL;
    delete process.env.DESIGN_WORKER_TOKEN;
    const agents = stubAgents({ build: () => siteReply(), review: () => AGREE });
    const id = await answerEverything(member);
    await drain(t);
    const before = (await member.as.query(api.billing.summary, {}))!.credits;
    try {
      await member.as.mutation(api.onboarding.submit, { id });
      await drain(t);
      expect(agents.builds()).toHaveLength(0);
      const brief = (await t.run((ctx) => ctx.db.get(id)))!;
      expect(brief.status).toBe("failed");
      expect(brief.error).toContain("Design research is not configured");
      expect(await versions(t)).toEqual([]);
      expect((await member.as.query(api.billing.summary, {}))!.credits).toBe(before);
    } finally {
      process.env.DESIGN_WORKER_URL = "https://design-worker.test";
      process.env.DESIGN_WORKER_TOKEN = "test-design-worker-token";
    }
  });
});

describe("an edit uses the saved SkillUI Ultra design reference", () => {
  test("an edit is told to follow the reference, checked by its auditors, and saved", async () => {
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    const agents = stubAgents({
      build: () => siteReply({ summary: "Added this week's roast.", home: HOME.replace("Pier Roast", "Pier Roast, and this week's Kenya") }),
      review: () => AGREE,
    });
    const { site } = await firstSite(t, member);
    expect(agents.reviews()).toHaveLength(0);

    await member.as.action(api.generate.run, { conversationId: site.conversationId, prompt: "Add this week's roast" });
    await drain(t);

    expect(agents.reviews()).toHaveLength(0);
    expect(await reviews(t)).toEqual([]);
    expect(await versions(t)).toHaveLength(2);
    expect(agents.builds()).toHaveLength(1);
    expect(systemOf(agents.builds()[0])).toContain(DESIGN_PROMPT);
    // The edit's own auditors: the shell changed, so the header and footer,
    // and both halves of the page it touched.
    expect(auditCalls().slice(4).map((call) => `${call.path} ${call.part}`).sort()).toEqual(["/ body1", "/ body2", "/ footer", "/ header"]);
    expect((await holds(t)).filter(([kind]) => kind === "edit")).toEqual([["edit", "settled"]]);
  });
});

describe("the check's own reading", () => {
  test("a clones block names an original, with its address, for each part", () => {
    expect(unnamedParts(CLONES)).toEqual([]);
    expect(unnamedParts(undefined)).toEqual(["header", "menu", "footer"]);
    expect(unnamedParts(CLONES.replace("Footer: Locomotive, https://locomotive.ca", "Footer: Locomotive"))).toEqual(["footer"]);
    // A description that mentions a header-like strip is not a second header.
    expect(unnamedParts(`${CLONES}\nheader-like strip: none`)).toEqual([]);
    expect(unnamedParts("**Header:** Lusion, https://lusion.co\n**Dropdown menu** — Lusion, https://lusion.co\n1. Footer: Lusion, https://lusion.co")).toEqual([]);
  });

  test("a verdict agrees only when every part is equal, and a disagreement has to ask for something", () => {
    expect(readVerdict(`Here you go:\n\`\`\`json\n${AGREE}\n\`\`\``)?.equal).toBe(true);
    const halfway = JSON.stringify({ equal: true, header: part(true), menu: part(false, "the menu drops from the left"), footer: part(true), fixes: [] });
    // Called equal overall while the menu is not: the differences become the fixes.
    expect(readVerdict(halfway)).toMatchObject({ equal: false, fixes: ["The dropdown menu: the menu drops from the left"] });
    expect(readVerdict(JSON.stringify({ equal: "false", header: part(false), menu: part(true), footer: part(true), fixes: [] }))).toBeNull();
    expect(readVerdict(JSON.stringify({ equal: "true", header: { ...part(true), equal: "true" }, menu: part(true), footer: part(true) }))?.equal).toBe(true);
    expect(readVerdict(JSON.stringify({ equal: true, header: part(true), footer: part(true) }))).toBeNull();
    expect(readVerdict("They look the same to me.")).toBeNull();
  });

  test("a rework that leaves styles out is caught before it reaches the reviewer", () => {
    const pages = [{ body: HOME }];
    expect(lostPageStyles(shell(), shell(".bar{height:96px}"), pages)).toEqual([]);
    expect(lostPageStyles(shell(), shell(".bar{height:96px}", ".hours{display:grid}"), pages)).toEqual(["menu-card"]);
    expect(elided("<style>/* ... */</style>")).toBe("/* ... */");
    expect(elided("<style>.a{}/* rest of the styles unchanged */</style>")).toBe("/* rest of the styles unchanged */");
    expect(elided("<nav><!-- links unchanged --></nav>")).toBe("<!-- links unchanged -->");
    expect(elided("<style>/* the header's bar */.bar{}</style><!--forge-page-->")).toBeNull();
  });

  test("the retired reviewer never holds a build", async () => {
    const site = { shell: shell(), pages: [{ path: "/", title: "Home", body: HOME }] };
    const before = await chromeHash(site);
    expect(designReviewOn()).toBe(false);
    expect(await needsReview("generate", null, site)).toBe(false);
    expect(await needsReview("edit", before, { ...site, pages: [{ path: "/", title: "Home", body: "<main>New</main>" }] })).toBe(false);
    expect(await needsReview("edit", before, { ...site, shell: shell(".bar{height:96px}") })).toBe(false);
    process.env.DESIGN_REVIEW = "on";
    expect(designReviewOn()).toBe(false);
    expect(await needsReview("generate", null, site)).toBe(false);
  });

  test("a reply carries its clones block, and a rework may send back the shell alone", () => {
    expect(parseReply(siteReply())).toMatchObject({ clones: CLONES, summary: "Built a harbour-side site for Harbor Roasters." });
    expect(parseReply(siteReply({ clones: null })).clones).toBeUndefined();
    const back = parseShellReply(reworkReply(shell(".bar{height:96px}")));
    expect(back).toMatchObject({ clones: CLONES, pages: [], summary: "Made the header 96px tall." });
    expect(back.shell).toContain(".bar{height:96px}");
    expect(() => parseShellReply("Made the header taller.\n\n```html shell\n<!doctype html><html><body>cut")).toThrow("shell is missing or unfinished");
  });
});
