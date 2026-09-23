import { afterEach, describe, expect, test } from "vitest";
import { allowAgree, comparePart, maxPixelDiff, partDocument, pixelPass, PIXEL_DIFF_MAX, referenceShots, visualGateOn } from "./visualGate";

const PREV_GATE = process.env.BUILDER_VISUAL_GATE;
const PREV_DIFF = process.env.BUILDER_VISUAL_MAX_DIFF;

afterEach(() => {
  if (PREV_GATE === undefined) delete process.env.BUILDER_VISUAL_GATE;
  else process.env.BUILDER_VISUAL_GATE = PREV_GATE;
  if (PREV_DIFF === undefined) delete process.env.BUILDER_VISUAL_MAX_DIFF;
  else process.env.BUILDER_VISUAL_MAX_DIFF = PREV_DIFF;
});

describe("the builder pixel gate", () => {
  test("agreement needs a measured pass, and 0.1% is the budget", () => {
    delete process.env.BUILDER_VISUAL_GATE;
    delete process.env.BUILDER_VISUAL_MAX_DIFF;
    expect(visualGateOn()).toBe(true);
    expect(maxPixelDiff()).toBe(PIXEL_DIFF_MAX);
    expect(allowAgree(true, undefined)).toBe(false);
    expect(allowAgree(true, false)).toBe(false);
    expect(allowAgree(false, true)).toBe(false);
    expect(allowAgree(true, true)).toBe(true);
    expect(pixelPass(0, 10000)).toBe(true);
    expect(pixelPass(10, 10000)).toBe(true);
    expect(pixelPass(11, 10000)).toBe(false);
    expect(pixelPass(0, 0)).toBe(false);
    process.env.BUILDER_VISUAL_GATE = "0";
    expect(allowAgree(true, undefined)).toBe(true);
    process.env.BUILDER_VISUAL_MAX_DIFF = "0.05";
    expect(maxPixelDiff()).toBe(0.05);
  });

  test("the part is rendered as its own document on the foundation", () => {
    const html = partDocument(":root{--color-paper:#ffffff}", "<header class=\"site-header\">Hi</header>");
    expect(html).toContain(":root{--color-paper:#ffffff}");
    expect(html).toContain("<header class=\"site-header\">Hi</header>");
    expect(html).toContain("<!doctype html>");
  });

  test("a worker that did not compare, or that is over the budget, is not a pass", async () => {
    process.env.BUILDER_VISUAL_GATE = "1";
    process.env.DESIGN_WORKER_URL = "https://design-worker.test";
    process.env.DESIGN_WORKER_TOKEN = "test-design-worker-token";
    const calls: { url: string; body: any }[] = [];
    const fetchMock = async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body ?? "")) });
      const path = new URL(url).pathname;
      if (path === "/shots") {
        return new Response(JSON.stringify({ shots: [
          { label: "screens/scroll/scroll-000.png", mediaType: "image/png", base64: "AAAA" },
          { label: "skip", mediaType: "text/plain", base64: "nope" },
        ] }), { status: 200 });
      }
      const ratio = calls.length > 2 ? 0.2 : 0;
      return new Response(JSON.stringify({
        pass: ratio === 0,
        compared: path === "/visual",
        ratio,
        width: 1440,
        shot: "screens/scroll/scroll-000.png",
        fixes: ratio === 0 ? [] : ["Pixel gate failed at 1440px against screens/scroll/scroll-000.png: 200 of 1000 pixels differ (20.000%)."],
      }), { status: 200 });
    };
    const previous = globalThis.fetch;
    globalThis.fetch = fetchMock as typeof fetch;
    try {
      const shots = await referenceShots({ packageUrl: "https://cdn.example/pkg", part: "header", path: "/" });
      expect(shots).toEqual([{ label: "screens/scroll/scroll-000.png", mediaType: "image/png", base64: "AAAA" }]);
      const passed = await comparePart({ packageUrl: "https://cdn.example/pkg", part: "header", path: "/", html: "<header></header>" });
      expect(passed.pass).toBe(true);
      expect(passed.ratio).toBe(0);
      const failed = await comparePart({ packageUrl: "https://cdn.example/pkg", part: "header", path: "/", html: "<header></header>" });
      expect(failed.pass).toBe(false);
      expect(failed.fixes[0]).toMatch(/20\.000%/);
      expect(calls[1].body.maxRatio).toBe(PIXEL_DIFF_MAX);
    } finally {
      globalThis.fetch = previous;
    }
  });
});
