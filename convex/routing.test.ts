/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { chatRoute } from "./generate";
import { imageRoute } from "./images";

// Which provider a turn is allowed to go to. The rule is the shape of the
// endpoint and the job of the model, never the vendor's name: Forge runs on
// whatever the deployment points it at, as long as that thing speaks the
// OpenAI chat shape and writes text rather than pixels.
const ENV = ["AI_BASE_URL", "AI_MODEL", "AI_BUILD_MODEL", "AI_API_KEY", "AI_IMAGE_MODEL", "AI_IMAGE_MODEL_OVERRIDE"];
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

describe("a deployment can run the agent on Gemini", () => {
  test("a Gemini text model on Google's OpenAI-compatible path is allowed", () => {
    process.env.AI_BASE_URL = GOOGLE_OPENAI;
    process.env.AI_MODEL = "gemini-3.8-flash";
    const route = chatRoute();
    expect(route.misrouted).toBe(false);
    expect(route.misroutedReason).toBeUndefined();
    expect(route.model).toBe("gemini-3.8-flash");
    // No marketing name is borrowed: the agent reports the id it runs on.
    expect(route.label).toBe("gemini-3.8-flash");
    // A trailing slash is the same route.
    process.env.AI_BASE_URL = `${GOOGLE_OPENAI}/`;
    expect(chatRoute().misrouted).toBe(false);
  });

  test("builds can take a stronger Gemini than chat does", () => {
    process.env.AI_BASE_URL = GOOGLE_OPENAI;
    process.env.AI_MODEL = "gemini-3.8-flash";
    process.env.AI_BUILD_MODEL = "gemini-3.8-pro";
    expect(chatRoute("build")).toMatchObject({ model: "gemini-3.8-pro", misrouted: false });
    expect(chatRoute("chat")).toMatchObject({ model: "gemini-3.8-flash", misrouted: false });
  });

  test("the pictures keep their own route, and their own key", () => {
    process.env.AI_BASE_URL = GOOGLE_OPENAI;
    process.env.AI_MODEL = "gemini-3.8-flash";
    // Nano Banana 2 Lite is the default and stays it; the chat route saying
    // Gemini does not change what draws.
    expect(imageRoute().model).toBe("gemini-3.1-flash-lite-image");
    expect(imageRoute().pinned).toBe(false);
  });
});

describe("what is still refused, and why", () => {
  test("an image model cannot be asked to write a website", () => {
    process.env.AI_BASE_URL = GOOGLE_OPENAI;
    process.env.AI_MODEL = "gemini-3.1-flash-lite-image";
    const route = chatRoute();
    expect(route.misrouted).toBe(true);
    expect(route.misroutedReason).toContain("names an image model");
    for (const model of ["imagen-4.0", "nano-banana-2", "some-provider/thing-image"]) {
      process.env.AI_MODEL = model;
      expect(chatRoute().misrouted).toBe(true);
    }
  });

  test("Google's native endpoint is refused with the path that would work", () => {
    process.env.AI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
    process.env.AI_MODEL = "gemini-3.8-flash";
    const route = chatRoute();
    // /v1beta/chat/completions does not exist, so this would 404 and say nothing.
    expect(route.misrouted).toBe(true);
    expect(route.misroutedReason).toContain("/v1beta/openai");
  });

  test("an unset deployment still lands somewhere valid", () => {
    for (const key of ["AI_BASE_URL", "AI_MODEL"]) delete process.env[key];
    expect(chatRoute()).toMatchObject({
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-flash",
      misrouted: false,
    });
  });
});
