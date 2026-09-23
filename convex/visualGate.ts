// The builder visual gate. A crew part is not agreed until a rendered
// screenshot of it is within the pixel budget of the SkillUI reference shot
// for that part. The design worker renders and counts (`design-worker/visual.mjs`);
// this module decides whether that measurement is allowed to count as agreement.
//
// `BUILDER_VISUAL_GATE=0` turns the gate off (tests). Unset, it is on.
// `BUILDER_VISUAL_MAX_DIFF` is the fraction of pixels that may differ
// (default 0.001, which is 0.1%). Acceptance is this ratio, never a model's
// description of the picture.
import type { PartName } from "./crew";

export const PIXEL_DIFF_MAX = 0.001;

export function visualGateOn() {
  return process.env.BUILDER_VISUAL_GATE !== "0";
}

export function maxPixelDiff() {
  const raw = Number(process.env.BUILDER_VISUAL_MAX_DIFF);
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : PIXEL_DIFF_MAX;
}

// An auditor's "agree" is kept only when the gate is off, or the pixel check
// for this round reported a pass. Anything else is a rework.
export function allowAgree(agree: boolean, visualPass: boolean | undefined) {
  if (!agree) return false;
  if (!visualGateOn()) return true;
  return visualPass === true;
}

export function pixelPass(differing: number, total: number, max = maxPixelDiff()) {
  if (!Number.isFinite(differing) || !Number.isFinite(total) || total <= 0) return false;
  return differing / total <= max;
}

// The document the worker screenshots: the part, on the foundation, and
// nothing else. A later page's header or footer is the shell plus that
// page's CSS, which the caller assembles.
export function partDocument(foundation: string | undefined, markup: string) {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style>\n${foundation ?? ""}\n</style>`,
    "</head>",
    "<body>",
    markup,
    "</body>",
    "</html>",
  ].join("\n");
}

export type ReferenceShot = { label: string; mediaType: string; base64: string };
export type VisualReport = { pass: boolean; fixes: string[]; ratio?: number; width?: number; shot?: string };

function workerRoute() {
  const base = process.env.DESIGN_WORKER_URL?.replace(/\/+$/, "");
  const token = process.env.DESIGN_WORKER_TOKEN;
  if (!base || !token || !base.startsWith("https://")) {
    throw new Error("Design research is not configured. Set the design worker URL and token before building.");
  }
  return { base, token };
}

async function postWorker(path: "/shots" | "/visual", body: unknown, timeoutMs: number) {
  const { base, token } = workerRoute();
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Design worker ${path} answered ${response.status}`);
  return await response.json() as Record<string, unknown>;
}

const NO_MATCH = "The pixel gate did not pass against the SkillUI reference screenshot. Match that screenshot; this part is not complete.";

export async function referenceShots(input: { packageUrl: string; part: PartName; path: string }): Promise<ReferenceShot[]> {
  try {
    const data = await postWorker("/shots", input, 30000);
    if (!Array.isArray(data.shots)) return [];
    return data.shots.flatMap((shot) => {
      if (!shot || typeof shot !== "object") return [];
      const row = shot as { label?: unknown; mediaType?: unknown; base64?: unknown };
      if (typeof row.base64 !== "string" || !row.base64 || row.base64.length > 1_500_000) return [];
      if (row.mediaType !== "image/png" && row.mediaType !== "image/jpeg" && row.mediaType !== "image/webp") return [];
      return [{ label: typeof row.label === "string" ? row.label : "reference", mediaType: row.mediaType, base64: row.base64 }];
    }).slice(0, 3);
  } catch {
    return [];
  }
}

// The worker's measurement, accepted only when it actually compared pixels
// and the ratio is inside the budget. A missing ratio or a failed compare
// is a fail, with the worker's own notes when it sent them.
export async function comparePart(input: { packageUrl: string; part: PartName; path: string; html: string }): Promise<VisualReport> {
  if (!input.packageUrl.startsWith("https://")) throw new Error("The SkillUI package could not be opened for the pixel gate");
  const data = await postWorker("/visual", { ...input, maxRatio: maxPixelDiff() }, 90000);
  const ratio = typeof data.ratio === "number" && Number.isFinite(data.ratio) ? data.ratio : undefined;
  const fixes = Array.isArray(data.fixes) ? data.fixes.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 8) : [];
  const pass = data.pass === true && data.compared === true && ratio !== undefined && ratio <= maxPixelDiff();
  return {
    pass,
    fixes: pass ? [] : (fixes.length ? fixes : [NO_MATCH]),
    ratio,
    width: typeof data.width === "number" ? data.width : undefined,
    shot: typeof data.shot === "string" ? data.shot : undefined,
  };
}
