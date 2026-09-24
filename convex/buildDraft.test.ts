/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { joinCarry, MOST_RESUMES, nextPage, STEP_TRIES } from "./buildDraft";
import { builderTurn, newCrew, nextFor, pageFrom, readPart, shellFrom, type CrewPart } from "./crew";
import { crewCall, DESIGN_FOUNDATION, partReply, type CrewCall } from "./crewFixture";
import { CARRY_ON, MOST_RESTARTS, NEW_IMAGERY, PAGE_STEP_MS } from "./onboarding";
import { QUESTION_SET, QUESTIONS } from "./onboardingQuestions";
import { MAX_PAGES, pagePlan } from "./pages";
import { REQUEST_COSTS } from "./plans";
import schema from "./schema";

// Every first build and rebuild is written a page at a time by a crew: a
// builder for the header, two for the body and one for the footer. These
// drive the real chain -- the scheduler, the builders' replies and the save.
// A first build writes the home page.
const modules = import.meta.glob("./**/*.*s");
function makeTest() {
  return convexTest(schema, modules);
}
type T = ReturnType<typeof makeTest>;
let active: T;
const fresh = () => (active = makeTest());

const SEVEN = ["/", "/food-menu", "/drink-menu", "/specials", "/events", "/party", "/cater"];
const FIVE = SEVEN.slice(0, MAX_PAGES);
const KEY = "sk-test-secret-key";
const PNG = btoa("not really a png, but bytes are bytes");
const ANSWERS = [
  "Taquería El Farolito",
  "Tacos, burritos and aguas frescas, made to order",
  "See a menu or price list",
  "Tacos al pastor — $3.50\nHorchata — $4",
  "Families and lunch crowds in Plano",
  "",
  "",
  "Warm and welcoming",
  "",
  "",
];

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
// A reply still going when its step's clock runs out: what it has said is read,
// the provider keeps the connection alive, and then the clock -- faked, with
// `clockTimers()` -- reaches the end of the step and the call is aborted there.
const clockTimers = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
const outlivesStep = (init: RequestInit, ...events: string[]) =>
  new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(event));
      let ticks = 0;
      const tick = setInterval(() => {
        controller.enqueue(encoder.encode(": keep-alive\n\n"));
        if (++ticks === 3) vi.advanceTimersByTime(PAGE_STEP_MS);
      }, 20);
      init.signal?.addEventListener("abort", () => {
        clearInterval(tick);
        controller.error(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
      });
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });

// Which build a page came from, so a rebuild is a different design.
let edition = "first";

// One fetch for the worker, the pictures, the strategist, the memory note and
// the crew's builders, which `answer` speaks for. Every builder call is
// recorded, and any other call -- one no builder made -- fails the test.
function stubProviders(answer: (call: CrewCall, init: RequestInit) => Response = (call) => said(partReply(call, edition))) {
  const builders: CrewCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      if (/generateContent/.test(url)) {
        return json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: PNG } }] } }] });
      }
      const body = JSON.parse(String(init.body));
      const system = body.messages.filter((m: any) => m.role === "system").map((m: any) => m.content).join("\n");
      if (/private website strategist/.test(system)) return said("Lead with the al pastor.");
      if (/maintain Forge's memory/.test(system)) return said('{"add":[],"forget":[],"replace":{}}');
      const call = crewCall(body);
      if (!call) throw new Error("A call no crew member made");
      builders.push(call);
      return answer(call, init);
    }),
  );
  return builders;
}

async function createBuilder(t: T) {
  const { userId, sessionId } = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email: `m${Math.random().toString(36).slice(2, 8)}@example.com` });
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
    await member.as.mutation(api.onboarding.save, { id, index, answer: ANSWERS[index] ?? "", advance: true, questionSet: QUESTION_SET });
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

// Answer, submit, and run the build by hand: the draft exists, and its first
// step is queued but has not run. Needs `hold()`.
async function toDraft(t: T, member: Member) {
  const id = await answerEverything(member);
  await member.as.mutation(api.onboarding.submit, { id });
  await t.action(internal.onboarding.build, { id, attempt: 1 });
  const draft = await t.run(async (ctx) => (await ctx.db.query("buildDrafts").collect()).find((row) => row.onboardingId === id)!);
  await dropScheduled(t);
  return { id, draft };
}

// Submit and let the scheduler run everything.
async function build(t: T, member: Member) {
  const id = await answerEverything(member);
  await member.as.mutation(api.onboarding.submit, { id });
  await drain(t);
  return id;
}

beforeEach(() => {
  process.env.AI_BASE_URL = "https://ai.example/v1/";
  process.env.AI_API_KEY = KEY;
  process.env.AI_MODEL = "forge-test";
  process.env.AI_IMAGE_API_KEY = "img-test-secret-key";
  process.env.CONVEX_SITE_URL = "https://forge-test.convex.site";
  edition = "first";
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const name of ["AI_BASE_URL", "AI_API_KEY", "AI_MODEL", "AI_IMAGE_API_KEY", "CONVEX_SITE_URL"]) delete process.env[name];
});

const part = (fields: Partial<CrewPart> & Pick<CrewPart, "name">): CrewPart => ({ tries: 0, ...fields });

describe("the crew's pieces", () => {
  test("a build plans five pages at most, home first", () => {
    expect(MAX_PAGES).toBe(5);
    expect(pagePlan(SEVEN)).toEqual(FIVE);
    expect(pagePlan(["/cater", "/Food-Menu/", "/", "/food-menu", "/../x"])).toEqual(["/", "/cater", "/food-menu"]);
  });

  test("a crew starts at its builders, and on a later page the shared header and footer have nothing left to write", () => {
    const home = newCrew("/", false);
    expect(home.parts.map((each) => [each.name, nextFor(each)])).toEqual([["header", "build"], ["body1", "build"], ["body2", "build"], ["footer", "build"]]);
    const later = newCrew("/food-menu", true);
    expect(later.parts.map((each) => [each.name, nextFor(each)])).toEqual([["header", "done"], ["body1", "build"], ["body2", "build"], ["footer", "done"]]);
    // Written is done: nothing checks a part again once it is written.
    expect(nextFor(part({ name: "body1", markup: "<section></section>" }))).toBe("done");
    expect(nextFor(part({ name: "body1", partial: "```html part=\"body1\"\n<section>" }))).toBe("build");
  });

  test("a builder's part is read whole and clean, or comes back as what to put right", () => {
    const read = (reply: string, name: "header" | "body1" | "body2" | "footer") =>
      readPart(reply, { part: name }) as { markup?: string; title?: string; problem?: string };
    expect(read('Built it.\n\n```html part="header"\n<style>.site-header{}</style><header class="site-header">x</header>\n```', "header"))
      .toEqual({ markup: '<style>.site-header{}</style><header class="site-header">x</header>' });
    expect(read('Built it.\n\n```html part="body1" title="Food menu"\n<section><h1>Menu</h1></section>\n```', "body1"))
      .toEqual({ markup: "<section><h1>Menu</h1></section>", title: "Food menu" });
    expect(read("I would build a warm header.", "header")).toEqual({ problem: 'the reply had no ```html part="header" block in it. Send the header in one.' });
    expect(read('```html part="header"\n<header>cut', "header")).toEqual({ problem: "the header stopped before its block closed. Write it out in full and close the fence." });
    expect(read('```html part="header"\n<div>no header</div>\n```', "header")).toEqual({ problem: "the header has no <header> element. Put the whole header in one." });
    expect(read('```html part="footer"\n<!doctype html><html><body><footer></footer></body></html>\n```', "footer"))
      .toEqual({ problem: "the footer is a whole document. Send only the footer: Forge writes the <html>, <head> and <body> around it." });
    expect(read('```html part="body2"\n<main><section></section></main>\n```', "body2"))
      .toEqual({ problem: "Forge puts the page's <main> around the sections. Send only your <section> elements." });
    expect(read('```html part="body2"\n<style>.b{}</style>\n```', "body2")).toEqual({ problem: "the bottom half has styles and no sections. Write the sections themselves." });
    expect(read('```html part="body1"\n<section>a</section><!-- the rest is unchanged -->\n```', "body1").problem)
      .toMatch(/^the top half has a comment standing in for part of it/);
  });

  test("a builder is handed the crew, the foundation and the brief, and a part it could not use is named on its next go", () => {
    const base = [{ role: "system" as const, content: "RULES" }, { role: "user" as const, content: "Build the website from the saved onboarding brief." }];
    const common = { base, foundation: DESIGN_FOUNDATION, brief: "BRIEF", siteName: "Taquería El Farolito", routes: FIVE };
    const header = builderTurn({ ...common, path: "/", part: part({ name: "header" }) });
    expect(header[0].content).toBe("RULES");
    expect(header.some((m) => m.role === "system" && /This turn is page 1 of 5: \/\./.test(m.content) && /written one page at a time by a crew/.test(m.content))).toBe(true);
    expect(header.some((m) => m.role === "system" && m.content.includes(DESIGN_FOUNDATION))).toBe(true);
    expect(header.some((m) => m.content === "File: website-build-brief.md\n\nBRIEF")).toBe(true);
    expect(header.at(-1)!.content).toMatch(/^You are the header builder\./);
    expect(header.at(-1)!.content).toContain(`every page of this site by its path: ${FIVE.join(", ")}`);
    // The crew is builders alone: nobody is said to check their work.
    expect(header.some((m) => /auditor/i.test(m.content))).toBe(false);

    const rest = builderTurn({ ...common, path: "/", part: part({ name: "body2" }), top: "<section><h1>Tacos</h1></section>" });
    expect(rest.at(-1)!.content).toContain("The top of this page, as written:\n```html\n<section><h1>Tacos</h1></section>\n```");
    expect(rest.at(-1)!.content).toContain('part="body2"');

    const later = builderTurn({
      ...common, path: "/specials", part: part({ name: "body1" }), written: { shell: "<!doctype html><html>SHELL</html>", home: { path: "/", title: "Home", body: "HOME PAGE" } },
    });
    expect(later.at(-1)!.content).toContain("The site so far, as written.");
    expect(later.at(-1)!.content).toContain("HOME PAGE");

    const again = builderTurn({ ...common, path: "/", part: part({ name: "footer", tries: 1, problem: "the footer came back empty. Write it out in full." }) });
    expect(again.at(-1)!.content).toMatch(/^You are the footer builder\./);
    expect(again.at(-1)!.content).toContain("Your last reply for this part could not be used: the footer came back empty. Write it out in full.");
  });

  test("a part its step's clock stopped goes back as the builder's own words, with the ask to carry on after anything to put right", () => {
    const base = [{ role: "system" as const, content: "RULES" }];
    const common = { base, foundation: DESIGN_FOUNDATION, brief: "BRIEF", siteName: "Taquería El Farolito", routes: FIVE, path: "/" };
    const carry = 'Built the opening.\n\n```html part="body1" title="Home"\n<section class="a-open"><h1>Al pastor';
    const turn = builderTurn({ ...common, part: part({ name: "body1", partial: carry, problem: "the top half came back empty. Write it out in full." }), carry });
    expect(turn.slice(-2)).toEqual([{ role: "assistant", content: carry }, { role: "user", content: CARRY_ON }]);
    expect(turn.at(-3)!.content).toMatch(/^You are the builder for the top of this page/);
    expect(turn.at(-3)!.content).toContain("Your last reply for this part could not be used: the top half came back empty.");
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

  test("the shell is Forge's head, the foundation and the parts' own styles, and a page is its two halves in its <main>", () => {
    const shell = shellFrom({
      foundation: DESIGN_FOUNDATION,
      header: '<link rel="stylesheet" href="https://api.fontshare.com/v2/css?f[]=switzer@400&display=swap"><meta name="description" content="Tacos in Plano"><style>:root{--font-display:x;--font-body:y}.site-header{}</style><header class="site-header">H</header><script>menu()</script>',
      footer: '<style>.site-footer{}</style><footer class="site-footer">F</footer>',
      siteName: "Taquería El Farolito",
    });
    expect(shell.startsWith("<!doctype html>\n<html lang=\"en\">\n<head>")).toBe(true);
    expect(shell).toContain('<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">');
    expect(shell).toContain("<title><!--forge-title--></title>");
    expect(shell).toContain('<meta name="description" content="Tacos in Plano">');
    expect(shell).toContain(DESIGN_FOUNDATION);
    // The header chose its own families for both roles, so Satoshi is not loaded.
    expect(shell).not.toContain("f[]=satoshi");
    const head = shell.slice(0, shell.indexOf("</head>"));
    expect(head).toContain(".site-header{}");
    expect(head).toContain(".site-footer{}");
    expect(shell).toMatch(/<body>\n<header class="site-header">H<\/header><script>menu\(\)<\/script>\n<!--forge-page-->\n<footer class="site-footer">F<\/footer>\n<\/body>\n<\/html>$/);
    // No families of its own: the foundation's Satoshi, and the site's name for a description.
    const plain = shellFrom({ foundation: undefined, header: "<header>H</header>", footer: "<footer>F</footer>", siteName: "Harbor & Co" });
    expect(plain).toContain("f[]=satoshi");
    expect(plain).toContain('<meta name="description" content="Harbor &amp; Co">');

    const crew = newCrew("/specials", true);
    crew.parts = crew.parts.map((each) => ({
      ...each,
      markup: each.name === "header" || each.name === "footer" ? "" : `<section>${each.name}</section>`,
      ...(each.name === "body1" ? { title: "This week's specials" } : {}),
    }));
    expect(pageFrom(crew, { siteName: "Taquería El Farolito" })).toEqual({
      path: "/specials",
      title: "This week's specials",
      body: '<main id="main" data-forge-route="/specials">\n<section>body1</section>\n<section>body2</section>\n</main>',
    });
  });
});

describe("a site written by its crews, start to finish", () => {
  test("the home page is written by its crew and kept once every part is written", async () => {
    const t = fresh();
    const member = await createBuilder(t);
    const builders = stubProviders();
    const id = await build(t, member);
    expect(await brief(t, id)).toMatchObject({ status: "complete", attempt: 1 });

    const [draft] = await t.run((ctx) => ctx.db.query("buildDrafts").collect());
    expect(draft).toMatchObject({ status: "done", routes: ["/"], tries: 0 });
    const written = builders.map((call) => `${call.path} ${call.part}`);
    expect(written).toEqual(["/ header", "/ body1", "/ footer", "/ body2"]);
    const rest = builders.find((each) => each.part === "body2")!;
    expect(rest.messages.at(-1)!.content).toContain("The top of this page, as written:");
    expect(rest.messages.at(-1)!.content).toContain("first home</h1>");
    for (const call of builders) {
      expect(call.messages.some((m) => m.role === "system" && /Design every part from the brief and from DESIGN_GOD/.test(m.content))).toBe(true);
      expect(call.messages.some((m) => m.role === "system" && /The foundation below is the floor/.test(m.content))).toBe(true);
    }

    const all = await versions(t);
    expect(all).toHaveLength(1);
    const [version] = all;
    expect(version.shell).toContain('<header class="site-header">');
    expect(version.shell).toContain('<footer class="site-footer">');
    expect(version.pages!.map((page) => page.path)).toEqual(["/"]);
    for (const page of version.pages!) {
      expect(page.body.startsWith(`<main id="main" data-forge-route="${page.path}">`)).toBe(true);
      expect(page.body).not.toContain("forge-image:");
    }
    expect(version.summary).toBe("Built your one-page website.");
    const site = (await t.run((ctx) => ctx.db.query("sites").first()))!;
    expect(site).toMatchObject({ status: "published", currentVersionId: version._id });
    // One build's credits, held once across every step and settled once.
    expect((await holds(t)).filter(([kind]) => kind === "generate")).toEqual([["generate", "settled"]]);
    // It landed through its own step, as it was written.
    const [gate] = await t.run((ctx) => ctx.db.query("designGates").collect());
    expect(gate).toMatchObject({ status: "passed", round: 1, results: [] });
    expect(gate.audited).toBeUndefined();

    const labels = (await events(t)).map((event) => event.label);
    expect(labels).toEqual(expect.arrayContaining([
      "Writing your page",
      "Page 1 of 1, home: writing the header, the page and the footer",
      "Page 1 of 1: writing the header",
      "Page 1 of 1: the header is written",
      "Wrote page 1 of 1, home",
      "Wrote your page",
    ]));
    expect(labels.some((label) => /^Header builder: calling the model$/.test(label))).toBe(true);
    expect(labels.filter((label) => /audit|agreed|reference before/i.test(label))).toEqual([]);
  });

  // The build that failed on its header: the parts still being written when
  // one stopped it went on thinking, and on writing into the log, for minutes
  // after it had failed.
  test("once one part stops the build, the replies still being written for the others are called off", async () => {
    const t = fresh();
    const member = await createBuilder(t);
    const calledOff: string[] = [];
    const builders = stubProviders((call, init) => {
      if (call.part === "body1") return new Response(JSON.stringify({ error: { message: "Model Not Exist" } }), { status: 400 });
      // The header and the footer are still thinking when the top half fails.
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(delta({ reasoning_content: `Weigh the ${call.part}.` })));
          const tick = setInterval(() => controller.enqueue(encoder.encode(": keep-alive\n\n")), 10);
          init.signal?.addEventListener("abort", () => {
            clearInterval(tick);
            calledOff.push(call.part);
            controller.error(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
          });
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const id = await build(t, member);
    expect((await brief(t, id)).error).toContain("answered 400: Model Not Exist");
    expect(calledOff.sort()).toEqual(["footer", "header"]);
    // Asked once each: a reply called off is not a reply that dropped.
    expect(builders.map((call) => call.part).sort()).toEqual(["body1", "footer", "header"]);
    const log = await events(t);
    expect(log.filter((event) => ["provider_stop", "provider_retry", "crew_unusable"].includes(event.phase))).toEqual([]);
    // The log ends where the build did.
    expect(log.sort((a, b) => a.at - b.at).at(-1)).toMatchObject({ phase: "failed", label: "Build failed" });
    expect(await versions(t)).toEqual([]);
    expect((await holds(t)).filter(([kind]) => kind === "generate")).toEqual([["generate", "released"]]);

    // The debugger says what stopped the build, what went wrong just before,
    // and what each builder's calls came to -- in the provider's own words,
    // and never with the key.
    const trace = (await t.query(internal.diagnostics.trace, {}))!;
    expect(trace).toMatchObject({
      status: "failed",
      stoppedBy: {
        phase: "draft_failed",
        label: "Stopped at page 1 of 1: the top half came back unusable once",
        detail: expect.objectContaining({ part: "body1", reason: "The model provider answered 400: Model Not Exist" }),
      },
      cause: {
        phase: "provider_error",
        label: "Top-half builder: the model provider answered 400",
        detail: expect.objectContaining({ part: "body1", httpStatus: 400, providerError: "Model Not Exist" }),
      },
    });
    expect(trace.agents.map((agent) => agent.agent).sort()).toEqual(["Footer builder", "Header builder", "Top-half builder"]);
    expect(trace.agents.find((agent) => agent.agent === "Top-half builder")).toMatchObject({ calls: 1, answered: 0, errors: 1 });
    expect(trace.agents.find((agent) => agent.agent === "Header builder")).toMatchObject({ calls: 1, answered: 0, stops: 0, retries: 0 });
    expect(trace.lines).toContain("Agents");
    expect(trace.lines.find((line) => line.startsWith("  Stopped by"))).toContain("the top half came back unusable once");
    expect(trace.lines.find((line) => line.startsWith("  Went wrong before it"))).toContain('provider said "Model Not Exist"');
    expect(JSON.stringify(trace)).not.toContain(KEY);
  });

  test("a part that keeps coming back unusable is traced with every reason it could not be used", async () => {
    const t = fresh();
    const member = await createBuilder(t);
    stubProviders((call) => call.part === "footer"
      ? said('Built it.\n\n```html part="footer"\n<div class="site-footer">no landmark</div>\n```')
      : said(partReply(call)));
    const id = await build(t, member);
    expect(await brief(t, id)).toMatchObject({ status: "failed" });
    const trace = (await t.query(internal.diagnostics.trace, {}))!;
    expect(trace.stoppedBy).toMatchObject({
      label: `Stopped at page 1 of 1: the footer came back unusable ${STEP_TRIES} times in a row`,
      detail: expect.objectContaining({ part: "footer", reason: "the footer has no <footer> element. Put the whole footer in one." }),
    });
    expect(trace.cause).toMatchObject({
      phase: "crew_unusable",
      detail: expect.objectContaining({ part: "footer", reason: "the footer has no <footer> element. Put the whole footer in one." }),
    });
    const footer = trace.agents.find((agent) => agent.agent === "Footer builder")!;
    expect(footer).toMatchObject({ calls: STEP_TRIES, answered: STEP_TRIES });
    expect(footer.problems).toEqual(Array(STEP_TRIES).fill("the footer has no <footer> element. Put the whole footer in one."));
    expect(trace.lines).toContain("    unusable: the footer has no <footer> element. Put the whole footer in one.");
  });

  test("a builder's reply that cannot be used is named in the log, and its next turn is told what to put right", async () => {
    const t = fresh();
    const member = await createBuilder(t);
    let first = true;
    const builders = stubProviders((call) => {
      if (call.part === "header" && first) {
        first = false;
        return said('Built it.\n\n```html part="header"\n<div class="site-header">no landmark</div>\n```');
      }
      return said(partReply(call));
    });
    const id = await build(t, member);
    expect(await brief(t, id)).toMatchObject({ status: "complete" });
    const headers = builders.filter((call) => call.part === "header");
    expect(headers).toHaveLength(2);
    expect(headers[1].messages.at(-1)!.content).toContain("Your last reply for this part could not be used: the header has no <header> element. Put the whole header in one.");
    expect((await events(t)).map((event) => event.label)).toContain("Page 1 of 1: the header came back unusable: the header has no <header> element.");
  });

  test("a rebuild's home page must ask for new pictures", async () => {
    const t = fresh();
    const member = await createBuilder(t);
    stubProviders();
    await build(t, member);
    edition = "second";
    let bare = true;
    const builders = stubProviders((call) => {
      if (call.part === "body1" && bare) {
        bare = false;
        return said('Built the opening.\n\n```html part="body1" title="Home"\n<section><h1>Tacos</h1></section>\n```');
      }
      return said(partReply(call, edition));
    });
    const id = await member.as.mutation(api.onboarding.rebuild, {});
    await drain(t);
    expect(await brief(t, id)).toMatchObject({ status: "complete", attempt: 2 });
    const tops = builders.filter((call) => call.part === "body1");
    expect(tops[0].messages.at(-1)!.content).toContain(NEW_IMAGERY);
    expect(tops[1].messages.at(-1)!.content).toContain("a rebuild needs new pictures, and this page asked for none.");
    const [version] = await versions(t);
    expect(version.pages![0].body).toContain("second home");
  });
});

describe("when a crew cannot go on", () => {
  test("a part whose replies keep dropping stops the build after a few tries, says why, and gives the credits back", async () => {
    const t = fresh();
    const member = await createBuilder(t);
    const builders = stubProviders((call) => (call.part === "body1" ? streamed(delta({ reasoning_content: "Planning the opening." })) : said(partReply(call))));
    const id = await build(t, member);
    // Each try asks twice -- a dropped reply gets one fresh go -- and there are three.
    expect(builders.filter((call) => call.part === "body1")).toHaveLength(STEP_TRIES * 2);
    const row = await brief(t, id);
    expect(row).toMatchObject({ status: "failed", error: "The connection to the model dropped before it started writing your website. Try again. Your answers are saved." });
    expect(await versions(t)).toEqual([]);
    expect((await holds(t)).filter(([kind]) => kind === "generate")).toEqual([["generate", "released"]]);
    const [draft] = await t.run((ctx) => ctx.db.query("buildDrafts").collect());
    expect(draft).toMatchObject({ status: "failed", pages: [] });
    expect(draft.crew).toBeUndefined();
    const [run] = await t.run((ctx) => ctx.db.query("buildRuns").collect());
    expect(run).toMatchObject({ status: "failed" });
    expect((await events(t)).map((event) => event.label)).toContain("Stopped at page 1 of 1: the top half came back unusable 3 times in a row");
    expect((await pending(t)).filter((name) => name === "buildDraft:write")).toEqual([]);
  });

  test("a provider that refuses the request stops the build at once rather than asking again", async () => {
    const t = fresh();
    const member = await createBuilder(t);
    const builders = stubProviders((call) =>
      call.part === "body1" ? new Response(JSON.stringify({ error: { message: "Model Not Exist" } }), { status: 400 }) : said(partReply(call)));
    const id = await build(t, member);
    expect(builders.filter((call) => call.part === "body1")).toHaveLength(1);
    expect((await brief(t, id)).error).toContain("answered 400: Model Not Exist");
    expect(await versions(t)).toEqual([]);
  });

  test("a step whose clock runs short saves what its crew finished and queues the next, which carries on from there", async () => {
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
    const t = fresh();
    const member = await createBuilder(t);
    let slow = true;
    const builders = stubProviders((call) => {
      // The first builders take nearly the whole step between them.
      if (slow) vi.setSystemTime(Date.now() + 130_000);
      return said(partReply(call));
    });
    const id = await answerEverything(member);
    await member.as.mutation(api.onboarding.submit, { id });
    await t.action(internal.onboarding.build, { id, attempt: 1 });
    const [draft] = await t.run((ctx) => ctx.db.query("buildDrafts").collect());
    await dropScheduled(t);

    await t.action(internal.buildDraft.write, { id: draft._id });
    let row = await load(t, draft._id);
    expect(row.lease).toBeUndefined();
    expect(row.crew!.parts.filter((each) => each.markup !== undefined).map((each) => each.name).sort()).toEqual(["body1", "footer", "header"]);
    expect(await pending(t)).toContain("buildDraft:write");
    await dropScheduled(t);

    slow = false;
    await t.action(internal.buildDraft.write, { id: draft._id });
    await drain(t);
    row = await load(t, draft._id);
    expect(row).toMatchObject({ status: "done", step: 2, tries: 0 });
    // Nothing written was written twice.
    expect(builders.map((call) => call.part).sort()).toEqual(["body1", "body2", "footer", "header"]);
    expect(await brief(t, id)).toMatchObject({ status: "complete" });
  });

  test("a part the step's clock stopped part way is carried on from that character, not started again", async () => {
    hold();
    const t = fresh();
    const member = await createBuilder(t);
    const whole = partReply({ part: "body1", path: "/" });
    const cut = whole.indexOf("<h1>");
    const opening = whole.slice(0, cut);
    // What is kept is the part from its opening fence, as a page is.
    const kept = opening.slice(opening.indexOf("```"));
    const builders = stubProviders((call, init) => {
      if (call.part !== "body1") return said(partReply(call));
      if (call.messages.at(-1)!.content === CARRY_ON) return said(whole.slice(cut));
      return outlivesStep(init, delta({ reasoning_content: "Plan the opening." }), delta({ content: opening }));
    });
    const { id, draft } = await toDraft(t, member);
    clockTimers();

    // The step's clock runs out while the top half is being written.
    await t.action(internal.buildDraft.write, { id: draft._id });
    const row = await load(t, draft._id);
    const top = row.crew!.parts.find((each) => each.name === "body1")!;
    expect(top).toMatchObject({ partial: kept, resumes: 1, tries: 0 });
    expect(top.markup).toBeUndefined();
    expect(row).toMatchObject({ status: "writing", tries: 0, lastStop: expect.objectContaining({ reason: "out_of_time", phase: "writing" }) });
    expect(row.lease).toBeUndefined();
    expect(await pending(t)).toContain("buildDraft:write");
    const log = await events(t);
    expect(log.find((event) => event.phase === "draft_partial")).toMatchObject({
      label: "Saved the top half of page 1 of 1 as far as it got: home",
      detail: expect.objectContaining({ part: "body1", continuation: 1, stopReason: "out_of_time", streamPhase: "writing", replyChars: kept.length }),
    });
    // A kept part is a checkpoint, never a stop.
    expect(log.filter((event) => event.phase === "provider_stop")).toEqual([]);

    await dropScheduled(t);
    vi.useRealTimers();
    await t.action(internal.buildDraft.write, { id: draft._id });
    await drain(t);
    const tops = builders.filter((call) => call.part === "body1");
    expect(tops).toHaveLength(2);
    expect(tops[1].messages.slice(-2)).toEqual([{ role: "assistant", content: kept }, { role: "user", content: CARRY_ON }]);
    // What the first reply wrote, then the rest: one part, whole.
    const [version] = await versions(t);
    expect(version.pages![0].body.match(/<h1>/g)).toHaveLength(1);
    expect(version.pages![0].body).toContain('<section class="a-open"><h1>first home</h1>');
    expect(await brief(t, id)).toMatchObject({ status: "complete" });
    expect((await events(t)).map((event) => event.label)).toContain("Carrying on the top half of page 1 of 1 from where it stopped: home");
  });

  test("a step whose clock runs out while the builders are still thinking is tried again, and the build lands", async () => {
    hold();
    const t = fresh();
    const member = await createBuilder(t);
    let slow = true;
    const builders = stubProviders((call, init) =>
      slow ? outlivesStep(init, delta({ reasoning_content: `Weigh the ${call.part} against the reference.` })) : said(partReply(call)));
    const { id, draft } = await toDraft(t, member);
    clockTimers();

    await t.action(internal.buildDraft.write, { id: draft._id });
    await dropScheduled(t);
    // A step that finished nothing is a miss, whatever stopped it.
    expect(await load(t, draft._id)).toMatchObject({ status: "writing", tries: 1, lastStop: expect.objectContaining({ reason: "out_of_time", phase: "thinking" }) });
    expect((await events(t)).map((event) => event.label))
      .toContainEqual(expect.stringMatching(/^(Header|Top-half|Footer) builder: the build ran out of time while the model was thinking$/));

    slow = false;
    vi.useRealTimers();
    await t.action(internal.buildDraft.write, { id: draft._id });
    await drain(t);
    expect(await load(t, draft._id)).toMatchObject({ status: "done", tries: 0 });
    expect(await brief(t, id)).toMatchObject({ status: "complete" });
    expect(builders.filter((call) => call.part === "body2")).toHaveLength(1);
  });

  test("once its tries are spent, a draft whose clock kept running out while the builders thought says so, in the words any build uses", async () => {
    hold();
    const t = fresh();
    const member = await createBuilder(t);
    stubProviders((call, init) => outlivesStep(init, delta({ reasoning_content: `Weigh the ${call.part} against the reference.` })));
    const { id, draft } = await toDraft(t, member);
    clockTimers();

    for (let step = 1; step < STEP_TRIES; step += 1) {
      await t.action(internal.buildDraft.write, { id: draft._id });
      await dropScheduled(t);
      expect(await load(t, draft._id)).toMatchObject({ status: "writing", tries: step });
    }
    await t.action(internal.buildDraft.write, { id: draft._id });
    expect(await brief(t, id)).toMatchObject({
      status: "failed",
      error: "The model was still thinking your website through when the build ran out of time. Try again. Your answers are saved.",
    });
    expect(await holds(t)).toEqual([["generate", "released"]]);
    expect(await load(t, draft._id)).toMatchObject({ status: "failed", lastStop: expect.objectContaining({ reason: "out_of_time", phase: "thinking" }) });
    const [run] = await t.run((ctx) => ctx.db.query("buildRuns").collect());
    expect(run).toMatchObject({ status: "failed", errorClass: "out_of_time" });
    expect(await versions(t)).toEqual([]);
  });

  test("a step the platform lost is started again from the last saved part, and a draft that keeps going quiet stops", async () => {
    hold();
    const t = fresh();
    const member = await createBuilder(t);
    stubProviders();
    const { id, draft } = await toDraft(t, member);
    await t.run((ctx) => ctx.db.patch(draft._id, { routes: ["/", "/food-menu"] }));
    const quiet = (seconds: number) => t.run((ctx) => ctx.db.patch(draft._id, { beatAt: Date.now() - seconds * 1000 }));

    await t.mutation(internal.buildDraft.rescue, {});
    expect(await pending(t)).toEqual([]);
    await quiet(120);
    await t.mutation(internal.buildDraft.rescue, {});
    expect(await pending(t)).toEqual(["buildDraft:write"]);
    expect(await load(t, draft._id)).toMatchObject({ restarts: 1 });
    expect((await events(t)).map((event) => event.label)).toContain("Started page 1 of 2 again: nothing had been heard from it for 120s");
    await dropScheduled(t);

    for (let restart = 2; restart <= MOST_RESTARTS; restart += 1) {
      await quiet(120);
      await t.mutation(internal.buildDraft.rescue, {});
      await dropScheduled(t);
    }
    expect(await brief(t, id)).toMatchObject({ status: "building" });
    await quiet(120);
    await t.mutation(internal.buildDraft.rescue, {});
    expect(await brief(t, id)).toMatchObject({ status: "failed", error: "The build stopped responding. Your answers are saved. Try building again." });
    expect(await holds(t)).toEqual([["generate", "released"]]);
    expect(await load(t, draft._id)).toMatchObject({ status: "failed", pages: [] });
  });

  test("the attempt's watchdog waits while its draft is beating, and speaks once it is quiet", async () => {
    hold();
    const t = fresh();
    const member = await createBuilder(t);
    stubProviders();
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

  test("a part that keeps stopping part way, or a draft that takes too many steps, stops rather than going round", async () => {
    hold();
    const t = fresh();
    const member = await createBuilder(t);
    const builders = stubProviders();
    const { id, draft } = await toDraft(t, member);
    const { lease } = (await t.mutation(internal.buildDraft.claim, { id: draft._id }))!;
    await t.mutation(internal.buildDraft.muster, { id: draft._id, lease, path: "/" });
    const opening = '```html part="body1" title="Home"\n<section class="a-open">';
    for (let resume = 1; resume <= MOST_RESUMES; resume += 1) {
      expect(await t.mutation(internal.buildDraft.partCarried, { id: draft._id, lease, part: "body1", text: `${opening}${"<p>More</p>".repeat(resume)}` }))
        .toMatchObject({ state: "saved", part: { resumes: resume } });
    }
    expect(await t.mutation(internal.buildDraft.partCarried, { id: draft._id, lease, part: "body1", text: `${opening}<p>Still going</p>` }))
      .toEqual({ state: "failed" });
    expect(await brief(t, id)).toMatchObject({ status: "failed", error: "Your website couldn’t be completed. Your answers are saved. Try building again." });
    expect((await events(t)).map((event) => event.label)).toContain("Stopped at page 1 of 1: the top half kept stopping part way");

    // A second member's draft that has already taken its most steps.
    const other = await createBuilder(t);
    const second = await toDraft(t, other);
    await t.run((ctx) => ctx.db.patch(second.draft._id, { step: 6 }));
    await t.action(internal.buildDraft.write, { id: second.draft._id });
    expect(builders).toEqual([]);
    expect(await brief(t, second.id)).toMatchObject({ status: "failed" });
    expect((await events(t)).map((event) => event.label)).toContain("Stopped before every page was written");
  });

  test("a member who cancels mid-draft stops it: the next step writes nothing and nothing lands", async () => {
    hold();
    const t = fresh();
    const member = await createBuilder(t);
    const builders = stubProviders();
    const { draft } = await toDraft(t, member);
    const claimed = (await t.mutation(internal.buildDraft.claim, { id: draft._id }))!;
    await t.mutation(internal.buildDraft.muster, { id: draft._id, lease: claimed.lease, path: "/" });
    await t.mutation(internal.buildDraft.partBuilt, { id: draft._id, lease: claimed.lease, part: "header", markup: "<header>H</header>" });
    await member.as.mutation(api.onboarding.cancel, {});
    expect(await load(t, draft._id)).toMatchObject({ status: "cancelled", pages: [] });
    expect((await load(t, draft._id)).crew).toBeUndefined();
    await t.action(internal.buildDraft.write, { id: draft._id });
    expect(builders).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("designGates").collect())).toEqual([]);
    expect(await holds(t)).toEqual([["generate", "released"]]);
  });

  test("a copy that lost its hold saves nothing, and inspect shows where each part is and never a page", async () => {
    hold();
    const t = fresh();
    const member = await createBuilder(t);
    stubProviders();
    const { draft } = await toDraft(t, member);
    const claimed = (await t.mutation(internal.buildDraft.claim, { id: draft._id }))!;
    expect(await t.mutation(internal.buildDraft.claim, { id: draft._id })).toBeNull();
    await t.mutation(internal.buildDraft.muster, { id: draft._id, lease: claimed.lease, path: "/" });
    expect(await t.mutation(internal.buildDraft.partBuilt, { id: draft._id, lease: "not-mine", part: "header", markup: "<header>H</header>" })).toBeNull();
    expect(await t.mutation(internal.buildDraft.partBuilt, { id: draft._id, lease: claimed.lease, part: "header", markup: "<header>H</header>" }))
      .toEqual({ name: "header", markup: "<header>H</header>", tries: 0 });
    // Written is done: a second copy of the same part is not taken.
    expect(await t.mutation(internal.buildDraft.partBuilt, { id: draft._id, lease: claimed.lease, part: "header", markup: "<header>Again</header>" })).toBeNull();
    const opening = 'Built the opening.\n```html part="body1" title="Home"\n<section class="a-hero"><h1>Al pastor';
    expect(await t.mutation(internal.buildDraft.partCarried, { id: draft._id, lease: "not-mine", part: "body1", text: opening })).toEqual({ state: "gone" });
    expect(await t.mutation(internal.buildDraft.partCarried, { id: draft._id, lease: claimed.lease, part: "body1", text: opening }))
      .toMatchObject({ state: "saved", part: { name: "body1", partial: opening, resumes: 1, tries: 0 } });
    const saved = await load(t, draft._id);
    expect(nextPage(saved)).toBe("/");
    const inspected = (await t.query(internal.buildDraft.inspect, {}))[0];
    expect(inspected).toMatchObject({ status: "writing", routes: ["/"], written: [], partial: null, crew: { path: "/" } });
    expect(inspected.crew!.parts[0]).toEqual({ part: "header", written: true, tries: 0, chars: 18, carried: null, problem: null });
    expect(inspected.crew!.parts[1]).toEqual({ part: "body1", written: false, tries: 0, chars: null, carried: { chars: opening.length, resumes: 1 }, problem: null });
    expect(JSON.stringify(inspected)).not.toContain("<header");
    expect(JSON.stringify(inspected)).not.toContain("Al pastor");
  });

});

describe("a one-page build", () => {
  test("is written by its crew: four builders, one page", async () => {
    const t = fresh();
    const member = await createBuilder(t);
    const builders = stubProviders();
    const id = await build(t, member);
    expect(builders.map((call) => call.part).sort()).toEqual(["body1", "body2", "footer", "header"]);
    expect(await brief(t, id)).toMatchObject({ status: "complete" });
    expect((await versions(t))[0].pages!.map((page) => page.path)).toEqual(["/"]);
    expect(await member.as.query(api.billing.summary, {})).toMatchObject({ reserved: 0 });
    expect(REQUEST_COSTS.generate).toBeGreaterThan(0);
  });
});
