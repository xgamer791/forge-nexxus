// Test double for the design worker: research that returns a SkillUI Ultra
// package, and how the crew's builders are recognised and answered. CI never
// calls the live worker or a live model. convex-test does not serve the
// storage upload HTTP endpoint the real worker POSTs to, so the fixture stores
// the package itself and returns that id.
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { PARTS, type PartName } from "./crew";

export const DESIGN_WORKER_ORIGIN = "https://design-worker.test";
export const DESIGN_WORKER_TOKEN = "test-design-worker-token";
export const DESIGN_REFERENCE_URL = "https://harbor-reference.example/";
export const DESIGN_PROMPT =
  "SkillUI Ultra design reference for this site. Build every page to its layout, components, spacing, type scale and colours at phone and desktop widths. Write original copy and request original images through forge-image. Do not copy source text, images, logos or brand identity.";
export const DESIGN_FOUNDATION = ":root{--color-ink:#1d1a16;--color-paper:#ffffff;--color-accent:#b4441b;--space-1:8px;--space-2:16px;--radius-1:6px}";
export const DESIGN_ROUTES = ["/"];

// The routes the next research discovers. One page is the default; a
// reference with more is what a build written a page at a time is for
// (buildDraft.ts).
let routes: string[] = DESIGN_ROUTES;

export function setDesignRoutes(next: string[]) {
  routes = next;
}

export function resetDesignRoutes() {
  routes = DESIGN_ROUTES;
}

// The extract the worker writes: for one page the fixed prompt above, and for
// more a section per screen, the shape design-worker/skillui.mjs writes them in.
export function designPrompt(paths: readonly string[] = routes) {
  if (paths.length <= 1) return DESIGN_PROMPT;
  return [
    DESIGN_PROMPT,
    "",
    `PAGES: build exactly these pages and no others: ${paths.join(", ")}.`,
    ...paths.flatMap((path) => ["", `SCREEN ${path}`, `- the ${path} page opens on a full-bleed picture with the heading over it.`]),
  ].join("\n");
}

// "error" and "incomplete" answer research that way; "unauthorized" refuses
// it.
export type DesignWorkerScript = "ok" | "unauthorized" | "error" | "incomplete";

let script: DesignWorkerScript = "ok";

export function setDesignWorkerScript(next: DesignWorkerScript) {
  script = next;
}

export function resetDesignWorkerScript() {
  script = "ok";
}

function workerPath(url: string) {
  const origin = process.env.DESIGN_WORKER_URL?.replace(/\/+$/, "");
  if (!origin) return null;
  try {
    const parsed = new URL(url);
    return parsed.origin === new URL(origin).origin ? parsed.pathname : null;
  } catch {
    return null;
  }
}

export function isDesignResearchRequest(url: string) {
  return workerPath(url) === "/research";
}

// `store` is how convex-test saves a file from a mutation. The generated
// mutation storage type only lists the upload URL, which this runtime does
// not serve.
type PackageCtx = {
  storage: { store: (blob: Blob) => Promise<Id<"_storage">> };
  db: MutationCtx["db"];
};

type TestRunner = {
  run: (fn: (ctx: PackageCtx) => Promise<Id<"_storage">>) => Promise<Id<"_storage">>;
};

// A `.skill` package is a zip; its bytes are never read back in these tests.
const skillPackage = () => new Blob([`PK\u0003\u0004 skillui-ultra ${routes.join(" ")}`], { type: "application/zip" });

export function storeDesignPackage(t: TestRunner) {
  return t.run(async (ctx) => ctx.storage.store(skillPackage()));
}

export async function insertDesignPackage(
  ctx: PackageCtx,
  userId: Id<"users">,
  siteId: Id<"sites">,
  epoch = 0,
) {
  const storageId = await ctx.storage.store(skillPackage());
  await ctx.db.insert("siteDesignPackages", {
    userId,
    siteId,
    storageId,
    referenceUrl: DESIGN_REFERENCE_URL,
    prompt: designPrompt(),
    inspectedPages: Math.max(1, routes.length),
    buildEpoch: epoch,
    createdAt: Date.now(),
    format: "skillui-ultra-v1",
    routes,
    foundation: DESIGN_FOUNDATION,
  });
  return storageId;
}

function ndjson(events: unknown[]) {
  return new Response(events.map((event) => JSON.stringify(event)).join("\n") + "\n", {
    status: 200,
    headers: { "content-type": "application/x-ndjson" },
  });
}

// ---------------------------------------------------------------------------
// The crew, as a test double sees it
// ---------------------------------------------------------------------------

export type CrewCall = { role: "builder"; part: PartName; path: string; round: number; messages: { role: string; content: string }[] };

// Which builder of a crew a chat request is from, or null for any other turn.
export function crewCall(body: unknown): CrewCall | null {
  const messages = (body as { messages?: { role: string; content: string }[] })?.messages;
  if (!Array.isArray(messages) || !messages.length) return null;
  const text = (role: string) => messages.filter((m) => m.role === role).map((m) => String(m.content)).join("\n");
  const system = text("system");
  const crew = system.match(/This turn is page \d+ of \d+: (\S+)\./);
  if (!crew || !/written one page at a time by a crew/.test(system)) return null;
  const ask = messages.filter((m) => m.role === "user").map((m) => String(m.content)).find((content) => /You are the /.test(content)) ?? "";
  const part = ask.match(/part="(header|body1|body2|footer)"/)?.[1] as PartName | undefined;
  if (!part) return null;
  const round = messages.filter((m) => m.role === "assistant").length;
  return { role: "builder", part, path: crew[1], round, messages };
}

export const PART_PICTURE =
  '<img src="forge-image:1" data-forge-image="Morning light across the roastery counter, sacks of green coffee in the background" ' +
  'data-forge-aspect="16:9" alt="The roastery counter" width="1600" height="900">';

// A part as a well-behaved builder writes it. `label` marks which build a page
// came from, so a rebuild can be told from the first.
export function partMarkup(call: Pick<CrewCall, "part" | "path">, label = "first") {
  const slug = call.path === "/" ? "home" : call.path.slice(1).replace(/[^a-z0-9]+/g, "-");
  switch (call.part) {
    case "header":
      return `<link rel="stylesheet" href="https://api.fontshare.com/v2/css?f[]=switzer@400,600&display=swap">` +
        `<meta name="description" content="Coffee roasted on the pier">` +
        `<style>:root{--font-display:'Switzer',system-ui,sans-serif}.site-header{display:flex;padding:var(--space-2)}</style>` +
        `<header class="site-header"><a href="/" class="hd-brand">Harbor Roasters</a><nav><a href="/">Home</a></nav></header>`;
    case "footer":
      return `<style>.site-footer{padding:var(--space-2)}</style><footer class="site-footer"><p>Harbor Roasters, Port Ellen pier</p></footer>`;
    case "body1":
      return `<style>.a-open{min-height:80svh}</style><section class="a-open"><h1>${label} ${slug}</h1>${PART_PICTURE}</section>`;
    case "body2":
      return `<style>.b-more{padding:var(--space-2)}</style><section class="b-more"><h2>More about ${slug}</h2><p>The ${label} ${slug} page.</p></section>`;
  }
}

// A builder's whole reply: the sentence, then the part in its block.
export function partReply(call: Pick<CrewCall, "part" | "path">, label = "first") {
  const title = call.part === "body1" ? ` title="${call.path === "/" ? "Harbor Roasters" : call.path.slice(1)}"` : "";
  return `Built the ${call.part}.\n\n\`\`\`html part="${call.part}"${title}\n${partMarkup(call, label)}\n\`\`\``;
}

// Returns a response when `url` is the worker, otherwise null so the caller's
// provider stub can answer chat, builder and image requests.
export async function answerDesignResearch(
  url: string,
  init: RequestInit | undefined,
  store: () => Promise<Id<"_storage">>,
): Promise<Response | null> {
  if (!isDesignResearchRequest(url)) return null;
  const authorization = new Headers(init?.headers).get("authorization");
  if (script === "unauthorized" || authorization !== `Bearer ${process.env.DESIGN_WORKER_TOKEN ?? ""}`) {
    return new Response("", { status: 401 });
  }
  let body: { uploadUrl?: string; offer?: string; referenceUrl?: string };
  try {
    body = JSON.parse(String(init?.body ?? ""));
  } catch {
    return new Response("", { status: 400 });
  }
  if (!body.uploadUrl?.startsWith("https://") || !(body.offer || body.referenceUrl)) return new Response("", { status: 400 });
  if (script === "error") return ndjson([{ type: "error", reason: "No reference site could be inspected" }]);
  if (script === "incomplete") return ndjson([{ type: "complete", prompt: "" }]);
  const storageId = await store();
  return ndjson([
    { type: "progress", phase: "searching", detail: { city: "Los Angeles" } },
    { type: "progress", phase: "candidate", detail: { city: "New York", domain: "harbor-reference.example" } },
    { type: "progress", phase: "discovering", detail: { pages: routes.length } },
    { type: "progress", phase: "skillui", detail: { mode: "ultra", screens: routes.length } },
    { type: "progress", phase: "uploading", detail: { pages: routes.length } },
    {
      type: "complete",
      storageId,
      referenceUrl: DESIGN_REFERENCE_URL,
      prompt: designPrompt(),
      foundation: DESIGN_FOUNDATION,
      inspectedPages: routes.length,
      routes,
    },
  ]);
}

// Every crew builder a page gets, in order, for tests that check the layout.
export const CREW_PARTS: readonly PartName[] = PARTS;
