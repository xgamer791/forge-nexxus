// The chooser cannot pick a reference from DOM score alone. No browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NO_VISION_PASS, RESEARCH_MODEL, RESEARCH_THINKING, chooseByVision, judgeHomepage, parseVerdict, researchRoute, visionRequest,
} from "../researchAgent.mjs";

const high = { url: "https://highest.example/", score: 90, shot: "aGlnaA==", detail: { title: "Highest" } };
const low = { url: "https://lower.example/", score: 10, shot: "bG93", detail: { title: "Lower" } };

test("no vision pass means no pick, even when a DOM score is highest", async () => {
  const events = [];
  await assert.rejects(
    () => chooseByVision([high, low], {
      offer: "hair studio",
      emit: (phase, detail) => events.push({ phase, ...detail }),
      judge: async () => ({ accept: false, reason: "Not a designed site" }),
    }),
    new RegExp(NO_VISION_PASS),
  );
  assert.equal(events.some((event) => event.verdict === "accepted"), false);
  assert.equal(events.filter((event) => event.verdict === "rejected").length, 2);
  assert.equal(events[0].verdict, "judging");
});

test("a rejected high DOM score loses to a site vision accepts", async () => {
  const chosen = await chooseByVision([high, low], {
    judge: async ({ url, image }) => {
      assert.ok(image);
      return { accept: url.includes("lower"), reason: "Seen" };
    },
  });
  assert.equal(chosen, "https://lower.example/");
});

test("a missing screenshot is not a pick", async () => {
  let judged = 0;
  await assert.rejects(
    () => chooseByVision([{ url: "https://blank.example/", score: 100 }], {
      judge: async () => { judged += 1; return { accept: true, reason: "no" }; },
    }),
    /could not visually check/,
  );
  assert.equal(judged, 0);
});

test("research calls Gemini 3.8 Flash at its max thinking level with the screenshot", async () => {
  const route = researchRoute({ AI_RESEARCH_API_KEY: "research-key" });
  assert.equal(route.model, RESEARCH_MODEL);
  assert.equal(route.model, "gemini-3.8-flash");
  assert.equal(route.thinkingLevel, RESEARCH_THINKING);
  assert.equal(route.thinkingLevel, "high");
  const custom = researchRoute({
    AI_RESEARCH_API_KEY: "own",
    GEMINI_API_KEY: "other",
    AI_RESEARCH_MODEL: "gemini-3.8-flash",
    AI_RESEARCH_BASE_URL: "https://generativelanguage.googleapis.com/v1beta/",
  });
  assert.equal(custom.apiKey, "own");
  assert.equal(researchRoute({ GEMINI_API_KEY: "gemini-key" }).apiKey, "gemini-key");
  assert.throws(() => researchRoute({}), /AI_RESEARCH_API_KEY is required/);

  const calls = [];
  const verdict = await judgeHomepage(route, {
    url: "https://studio.example/",
    offer: "hair studio",
    feel: "warm",
    title: "Studio",
    description: "Cuts",
    image: "aGVsbG8=",
    mimeType: "image/jpeg",
  }, async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), key: init.headers["x-goog-api-key"] });
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ thought: true, text: "thinking" }, { text: '{"accept":true,"reason":"Designed homepage"}' }] } }],
    }), { status: 200 });
  });
  assert.equal(verdict.accept, true);
  assert.match(calls[0].url, /\/models\/gemini-3\.8-flash:generateContent$/);
  assert.equal(calls[0].key, "research-key");
  assert.equal(calls[0].body.generationConfig.thinkingConfig.thinkingLevel, "high");
  assert.equal(calls[0].body.contents[0].parts[1].inline_data.data, "aGVsbG8=");
  assert.equal(visionRequest(route, { url: "https://studio.example/", image: "eA==" }).generationConfig.thinkingConfig.thinkingLevel, "high");
});

test("a vision reply without an accept decision is not a pass", () => {
  assert.deepEqual(parseVerdict('{"accept":false,"reason":"Widget chrome"}'), { accept: false, reason: "Widget chrome" });
  assert.throws(() => parseVerdict("looks fine"), /not a decision/);
});
