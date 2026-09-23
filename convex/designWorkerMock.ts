// Test double for the design worker. CI never calls the live worker.
// convex-test does not serve the storage upload HTTP endpoint the real worker
// POSTs to, so the fixture stores the package itself and returns that id.
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

export const DESIGN_WORKER_ORIGIN = "https://design-worker.test";
export const DESIGN_WORKER_TOKEN = "test-design-worker-token";
export const DESIGN_REFERENCE_URL = "https://harbor-reference.example/";
export const DESIGN_PROMPT =
  "Measured design reference for this site. Follow its layout, routes and section geometry. Write original copy and request original images through forge-image. Do not copy source text, images, logos or brand identity.";

export type DesignWorkerScript = "ok" | "unauthorized" | "error" | "incomplete";

let script: DesignWorkerScript = "ok";

export function setDesignWorkerScript(next: DesignWorkerScript) {
  script = next;
}

export function resetDesignWorkerScript() {
  script = "ok";
}

export function isDesignResearchRequest(url: string) {
  const origin = process.env.DESIGN_WORKER_URL?.replace(/\/+$/, "");
  if (!origin) return false;
  try {
    const parsed = new URL(url);
    return parsed.origin === new URL(origin).origin && parsed.pathname === "/research";
  } catch {
    return false;
  }
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

export function storeDesignPackage(t: TestRunner) {
  return t.run(async (ctx) => ctx.storage.store(new Blob([JSON.stringify({ format: "forge-measured-v1" })], { type: "application/json" })));
}

export async function insertDesignPackage(
  ctx: PackageCtx,
  userId: Id<"users">,
  siteId: Id<"sites">,
  epoch = 0,
) {
  const storageId = await ctx.storage.store(new Blob([JSON.stringify({ format: "forge-measured-v1" })], { type: "application/json" }));
  await ctx.db.insert("siteDesignPackages", {
    userId,
    siteId,
    storageId,
    referenceUrl: DESIGN_REFERENCE_URL,
    prompt: DESIGN_PROMPT,
    inspectedPages: 2,
    buildEpoch: epoch,
    createdAt: Date.now(),
  });
  return storageId;
}

function ndjson(events: unknown[]) {
  return new Response(events.map((event) => JSON.stringify(event)).join("\n") + "\n", {
    status: 200,
    headers: { "content-type": "application/x-ndjson" },
  });
}

// Returns a response when `url` is the worker, otherwise null so the caller's
// provider stub can answer chat and image requests.
function authorized(init: RequestInit | undefined) {
  const authorization = new Headers(init?.headers).get("authorization");
  return script !== "unauthorized" && authorization === `Bearer ${process.env.DESIGN_WORKER_TOKEN ?? ""}`;
}

function workerPath(url: string) {
  const origin = process.env.DESIGN_WORKER_URL?.replace(/\/+$/, "");
  if (!origin) return null;
  try {
    const parsed = new URL(url);
    if (parsed.origin !== new URL(origin).origin) return null;
    return parsed.pathname === "/research" || parsed.pathname === "/audit" ? parsed.pathname : null;
  } catch {
    return null;
  }
}

// Layout check double. A passing verdict lets the build save; the real worker
// is what applies the 0.85 thresholds.
function answerAudit(init: RequestInit | undefined): Response {
  if (!authorized(init)) return new Response("", { status: 401 });
  let body: { reference?: string; pages?: { path?: string; html?: string }[] };
  try {
    body = JSON.parse(String(init?.body ?? ""));
  } catch {
    return new Response("", { status: 400 });
  }
  if (typeof body.reference !== "string" || !body.reference.startsWith("https://") || !Array.isArray(body.pages) || !body.pages.length ||
      !body.pages.every((page) => typeof page?.path === "string" && typeof page?.html === "string")) {
    return new Response("", { status: 400 });
  }
  if (script === "error") return ndjson([{ type: "error", reason: "The layout check could not measure the site" }]);
  return ndjson([
    { type: "progress", phase: "rendering", detail: { done: 1, total: body.pages.length } },
    { type: "progress", phase: "comparing", detail: { routes: body.pages.length } },
    { type: "complete", passed: true, routes: [], fixes: [] },
  ]);
}

export async function answerDesignResearch(
  url: string,
  init: RequestInit | undefined,
  store: () => Promise<Id<"_storage">>,
): Promise<Response | null> {
  const path = workerPath(url);
  if (!path) return null;
  if (path === "/audit") return answerAudit(init);
  if (!authorized(init)) return new Response("", { status: 401 });
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
    { type: "progress", phase: "measuring", detail: { pages: 2 } },
    { type: "progress", phase: "uploading", detail: { pages: 2 } },
    {
      type: "complete",
      storageId,
      referenceUrl: DESIGN_REFERENCE_URL,
      prompt: DESIGN_PROMPT,
      inspectedPages: 2,
    },
  ]);
}
