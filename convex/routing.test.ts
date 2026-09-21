/// <reference types="vite/client" />
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import { chatRoute } from "./generate";
import { imageRoute } from "./images";
import schema from "./schema";

// Where a turn goes is the deployment's business. Forge used to refuse some
// routes before trying them — any Google host, any model named Gemini — which
// meant a deployment that had chosen one got a build that failed before a
// request was ever sent. Nothing is refused now: the route is what the
// variables say, and a provider that cannot serve it says so in its own words,
// which is what the thread and the failed screen show.
const ENV = ["AI_BASE_URL", "AI_MODEL", "AI_MODEL_LABEL", "AI_BUILD_MODEL", "AI_API_KEY", "AI_IMAGE_MODEL", "AI_IMAGE_MODEL_OVERRIDE"];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV) saved[key] = process.env[key];
  process.env.AI_API_KEY = "sk-test";
});
afterEach(() => {
  for (const key of ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const GOOGLE_OPENAI = "https://generativelanguage.googleapis.com/v1beta/openai";

describe("the route is whatever the deployment names", () => {
  test("a Gemini text model is carried through exactly as configured", () => {
    process.env.AI_BASE_URL = GOOGLE_OPENAI;
    process.env.AI_MODEL = "gemini-3.8-flash";
    expect(chatRoute()).toEqual({
      baseUrl: GOOGLE_OPENAI,
      model: "gemini-3.8-flash",
      apiKey: "sk-test",
      // The pretty name belongs to the DeepSeek fallback id, so a configured
      // Gemini reports itself rather than borrowing that name.
      label: "gemini-3.8-flash",
    });
    // Any other id reports itself rather than borrowing that name.
    process.env.AI_MODEL = "gemini-3.8-pro";
    expect(chatRoute().label).toBe("gemini-3.8-pro");
    process.env.AI_MODEL = "gemini-3.8-flash";
    // A trailing slash is the same route; the request appends its own path.
    process.env.AI_BASE_URL = `${GOOGLE_OPENAI}/`;
    expect(chatRoute().baseUrl).toBe(GOOGLE_OPENAI);
  });

  test("nothing is gated on the vendor or the shape of the host", () => {
    process.env.AI_MODEL = "gemini-3.8-flash";
    for (const baseUrl of [
      GOOGLE_OPENAI,
      // Once refused outright. Now it is sent, and Google answers.
      "https://generativelanguage.googleapis.com/v1beta",
      "https://aiplatform.googleapis.com/v1",
      "https://api.openai.com/v1",
      "https://self-hosted.example/v1",
    ]) {
      process.env.AI_BASE_URL = baseUrl;
      expect(chatRoute().baseUrl).toBe(baseUrl);
    }
    // Including a model that cannot write a page: the provider is what says so.
    process.env.AI_BASE_URL = GOOGLE_OPENAI;
    for (const model of ["gemini-3.1-flash-lite-image", "imagen-4.0", "nano-banana-2"]) {
      process.env.AI_MODEL = model;
      expect(chatRoute().model).toBe(model);
    }
  });

  test("builds can take a stronger model than chat does", () => {
    process.env.AI_BASE_URL = GOOGLE_OPENAI;
    process.env.AI_MODEL = "gemini-3.8-flash";
    process.env.AI_BUILD_MODEL = "gemini-3.8-pro";
    expect(chatRoute("build").model).toBe("gemini-3.8-pro");
    expect(chatRoute("chat").model).toBe("gemini-3.8-flash");
    delete process.env.AI_BUILD_MODEL;
    expect(chatRoute("build").model).toBe("gemini-3.8-flash");
  });

  test("an unset deployment still lands somewhere valid", () => {
    for (const key of ["AI_BASE_URL", "AI_MODEL", "AI_MODEL_LABEL"]) delete process.env[key];
    expect(chatRoute()).toMatchObject({
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-flash",
      label: "DeepSeek v4.1 Flash",
    });
  });
});

describe("the pictures keep their own route", () => {
  test("moving text to Gemini does not change what draws", () => {
    process.env.AI_BASE_URL = GOOGLE_OPENAI;
    process.env.AI_MODEL = "gemini-3.8-flash";
    expect(imageRoute()).toMatchObject({
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      model: "gemini-3.1-flash-lite-image",
      pinned: false,
    });
  });

  test("a non-Lite image model is still ignored unless the override says so", () => {
    process.env.AI_IMAGE_MODEL = "gemini-3.8-image";
    expect(imageRoute()).toMatchObject({ model: "gemini-3.1-flash-lite-image", pinned: true });
    process.env.AI_IMAGE_MODEL_OVERRIDE = "true";
    expect(imageRoute()).toMatchObject({ model: "gemini-3.8-image", pinned: false });
  });
});

// `probe:chat` is the other half of `generate:routing`: where a turn goes, and
// then what comes back from there. It is read by whoever runs the deployment,
// so the one thing it must never do is carry the key out with the answer.
describe("probing the route never carries the key out", () => {
  const KEY = "sk-averysecretdeepseekkey00000000000";
  afterEach(() => vi.unstubAllGlobals());

  test("a rejected key is described, never quoted — even when the provider echoes it", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    process.env.AI_BASE_URL = "https://ai.example/v1";
    process.env.AI_MODEL = "some-model";
    process.env.AI_API_KEY = KEY;
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: `Authentication Fails, your key ${KEY} is invalid` } }),
        { status: 401, headers: { "content-type": "application/json" } }),
    ));

    const result: any = await t.action(internal.probe.chat, {});
    expect(result.httpStatus).toBe(401);
    expect(result.host).toBe("ai.example");
    expect(result.key).toMatchObject({ length: KEY.length, hasOuterWhitespace: false, head: "sk-", tail: KEY.slice(-4) });
    expect(result.providerError).toContain("Authentication Fails");
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  test("an empty reply with reasoning behind it is visible as exactly that", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    process.env.AI_BASE_URL = "https://ai.example/v1";
    process.env.AI_MODEL = "some-reasoner";
    process.env.AI_API_KEY = KEY;
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({
        model: "some-reasoner",
        choices: [{ finish_reason: "length", message: { content: "", reasoning_content: "thinking".repeat(10) } }],
      }), { status: 200, headers: { "content-type": "application/json" } }),
    ));

    const result: any = await t.action(internal.probe.chat, {});
    expect(result).toMatchObject({
      httpStatus: 200,
      servedModel: "some-reasoner",
      finishReason: "length",
      contentChars: 0,
      reasoningChars: 80,
    });
    expect(result.messageKeys).toEqual(["content", "reasoning_content"]);
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  test("no key set is said plainly rather than called on the network", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    delete process.env.AI_API_KEY;
    const fetched = vi.fn();
    vi.stubGlobal("fetch", fetched);
    const result: any = await t.action(internal.probe.chat, {});
    expect(result.error).toContain("No API key");
    expect(result.key).toBeNull();
    expect(fetched).not.toHaveBeenCalled();
  });
});
