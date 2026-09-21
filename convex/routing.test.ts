/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { chatRoute } from "./generate";
import { imageRoute } from "./images";

// Where a turn goes is the deployment's business. Forge used to refuse some
// routes before trying them — any Google host, any model named Gemini — which
// meant a deployment that had chosen one got a build that failed before a
// request was ever sent. Nothing is refused now: the route is what the
// variables say, and a provider that cannot serve it says so in its own words,
// which is what the thread and the failed screen show.
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

describe("the route is whatever the deployment names", () => {
  test("a Gemini text model is carried through exactly as configured", () => {
    process.env.AI_BASE_URL = GOOGLE_OPENAI;
    process.env.AI_MODEL = "gemini-3.8-flash";
    expect(chatRoute()).toEqual({
      baseUrl: GOOGLE_OPENAI,
      model: "gemini-3.8-flash",
      apiKey: "sk-test",
      // No marketing name is borrowed: the agent reports the id it runs on.
      label: "gemini-3.8-flash",
    });
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
    for (const key of ["AI_BASE_URL", "AI_MODEL"]) delete process.env[key];
    expect(chatRoute()).toMatchObject({
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-flash",
      label: "DeepSeek V4.1 Flash",
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
