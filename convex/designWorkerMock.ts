// Test double for the design worker. CI never calls the live worker.
// convex-test does not serve the storage upload HTTP endpoint the real worker
// POSTs to, so the fixture stores the package itself and returns that id.
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

export const DESIGN_WORKER_ORIGIN = "https://design-worker.test";
export const DESIGN_WORKER_TOKEN = "test-design-worker-token";
export const DESIGN_REFERENCE_URL = "https://harbor-reference.example/";
export const DESIGN_PROMPT =
  "SkillUI ultra design reference for this site. Use this for the shared shell, layout and component rhythm. Write original copy and request original images through forge-image. Do not copy source text, images, logos or brand identity.";

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
  return t.run(async (ctx) => ctx.storage.store(new Blob(["skillui ultra package"], { type: "application/zip" })));
}

export async function insertDesignPackage(
  ctx: PackageCtx,
  userId: Id<"users">,
  siteId: Id<"sites">,
  epoch = 0,
) {
  const storageId = await ctx.storage.store(new Blob(["skillui ultra package"], { type: "application/zip" }));
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
    { type: "progress", phase: "skillui", detail: { mode: "ultra", screens: 12 } },
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
