// Test double for the design worker: research that returns a measured
// reference, and a layout check that passes unless a script says otherwise.
// CI never calls the live worker. convex-test does not serve the storage
// upload HTTP endpoint the real worker POSTs to, so the fixture stores the
// reference itself and returns that id.
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

export const DESIGN_WORKER_ORIGIN = "https://design-worker.test";
export const DESIGN_WORKER_TOKEN = "test-design-worker-token";
export const DESIGN_REFERENCE_URL = "https://harbor-reference.example/";
export const DESIGN_PROMPT =
  "Measured design reference for this site. Match its routes, header, menu, sections and footer at phone, tablet and desktop widths. Write original copy and request original images through forge-image. Do not copy source text, images, logos or brand identity.";
export const DESIGN_ROUTES = ["/"];

// The routes the next research measures. One page is the default; a reference
// with more is what a build written a page at a time is for (buildDraft.ts).
let routes: string[] = DESIGN_ROUTES;

export function setDesignRoutes(next: string[]) {
  routes = next;
}

export function resetDesignRoutes() {
  routes = DESIGN_ROUTES;
}

// The spec the worker writes: for one page the fixed prompt above, and for
// more a section per route, the shape design-worker/spec.mjs writes them in.
export function designPrompt(paths: readonly string[] = routes) {
  if (paths.length <= 1) return DESIGN_PROMPT;
  return [
    DESIGN_PROMPT,
    "",
    `ROUTES: build exactly these pages and no others: ${paths.join(", ")}.`,
    ...paths.flatMap((path) => ["", `ROUTE ${path}`, `- desktop 1440px: the ${path} page is 3200px tall.`]),
  ].join("\n");
}

// "layout-fails" answers every layout check below the bar; "audit-error"
// answers it with an error. Research answers normally under both.
export type DesignWorkerScript = "ok" | "unauthorized" | "error" | "incomplete" | "layout-fails" | "audit-error";

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

export function isLayoutCheckRequest(url: string) {
  return workerPath(url) === "/audit";
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

const cappedRoutes = () => routes.slice(0, 5);
const referenceJson = () => JSON.stringify({
  format: "skillui-ultra-v1",
  source: DESIGN_REFERENCE_URL,
  design: "Primary #112233.",
  claude: "Use the extract.",
  skill: "Match it.",
  tokens: { colors: { ink: "#112233" } },
  routes: cappedRoutes().map((path) => ({ path })),
});

export function storeDesignPackage(t: TestRunner) {
  return t.run(async (ctx) => ctx.storage.store(new Blob([referenceJson()], { type: "application/json" })));
}

export async function insertDesignPackage(
  ctx: PackageCtx,
  userId: Id<"users">,
  siteId: Id<"sites">,
  epoch = 0,
) {
  const storageId = await ctx.storage.store(new Blob([referenceJson()], { type: "application/json" }));
  await ctx.db.insert("siteDesignPackages", {
    userId,
    siteId,
    storageId,
    referenceUrl: DESIGN_REFERENCE_URL,
    prompt: designPrompt(cappedRoutes()),
    inspectedPages: Math.min(5, Math.max(2, cappedRoutes().length)),
    buildEpoch: epoch,
    createdAt: Date.now(),
    format: "skillui-ultra-v1",
    routes: cappedRoutes(),
  });
  return storageId;
}

function ndjson(events: unknown[]) {
  return new Response(events.map((event) => JSON.stringify(event)).join("\n") + "\n", {
    status: 200,
    headers: { "content-type": "application/x-ndjson" },
  });
}

function auditor(id: string, agree: boolean) {
  return { id, agree, notes: agree ? "matches the SkillUI Ultra extract" : "does not match the SkillUI Ultra extract" };
}

// The crew the product requires. A failing script disagrees on both body
// auditors, which is not a page.
function auditorReport(passed: boolean, pages: { path: string }[]) {
  const agree = passed && pages.length > 0 && pages.length <= 5;
  return {
    type: "complete",
    passed: agree,
    pages: pages.map((page) => ({
      path: page.path,
      agreed: agree,
      crew: {
        header: { builders: 1, auditors: [auditor("header-1", true)] },
        body: { builders: 2, auditors: [auditor("body-1", agree), auditor("body-2", agree)] },
        footer: { builders: 1, auditors: [auditor("footer-1", true)] },
      },
    })),
    fixes: agree ? [] : [`${pages[0]?.path ?? "/"}: the auditors did not agree it matches the SkillUI Ultra extract.`],
  };
}

// Returns a response when `url` is the worker, otherwise null so the caller's
// provider stub can answer chat and image requests.
export async function answerDesignResearch(
  url: string,
  init: RequestInit | undefined,
  store: () => Promise<Id<"_storage">>,
): Promise<Response | null> {
  if (!isDesignResearchRequest(url) && !isLayoutCheckRequest(url)) return null;
  const authorization = new Headers(init?.headers).get("authorization");
  if (script === "unauthorized" || authorization !== `Bearer ${process.env.DESIGN_WORKER_TOKEN ?? ""}`) {
    return new Response("", { status: 401 });
  }
  if (isLayoutCheckRequest(url)) {
    let check: { reference?: string; pages?: { path: string; html: string }[] };
    try {
      check = JSON.parse(String(init?.body ?? ""));
    } catch {
      return new Response("", { status: 400 });
    }
    if (!check.reference || !Array.isArray(check.pages) || !check.pages.length) return new Response("", { status: 400 });
    if (script === "audit-error") return ndjson([{ type: "error", reason: "The page could not be rendered" }]);
    if (check.pages.length > 5) return ndjson([{ type: "error", reason: "A build can have at most 5 pages" }]);
    return ndjson([
      { type: "progress", phase: "auditing", detail: { page: 1, total: check.pages.length } },
      auditorReport(script !== "layout-fails", check.pages),
    ]);
  }
  let body: { uploadUrl?: string; offer?: string };
  try {
    body = JSON.parse(String(init?.body ?? ""));
  } catch {
    return new Response("", { status: 400 });
  }
  if (!body.offer || !body.uploadUrl?.startsWith("https://")) return new Response("", { status: 400 });
  if (script === "error") return ndjson([{ type: "error", reason: "No reference site could be inspected" }]);
  if (script === "incomplete") return ndjson([{ type: "complete", prompt: "" }]);
  const storageId = await store();
  return ndjson([
    { type: "progress", phase: "searching", detail: { city: "Los Angeles" } },
    { type: "progress", phase: "candidate", detail: { city: "New York", domain: "harbor-reference.example" } },
    { type: "progress", phase: "inspecting", detail: { page: 1, total: 2 } },
    { type: "progress", phase: "measuring", detail: { page: 1, total: 2 } },
    { type: "progress", phase: "uploading", detail: { pages: 2 } },
    {
      type: "complete",
      storageId,
      referenceUrl: DESIGN_REFERENCE_URL,
      prompt: designPrompt(cappedRoutes()),
      inspectedPages: Math.min(5, Math.max(2, cappedRoutes().length)),
      routes: cappedRoutes(),
    },
  ]);
}
