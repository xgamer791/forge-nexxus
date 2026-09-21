import { afterEach, describe, expect, test } from "vitest";
import { createMeter, imageCostCents, readUsage, storedCents, textRate, usageCostCents } from "./pricing";

const ENV = ["AI_PRICE_INPUT_USD_PER_MTOK", "AI_PRICE_OUTPUT_USD_PER_MTOK", "AI_IMAGE_USD_PER_IMAGE"];
afterEach(() => {
  for (const name of ENV) delete process.env[name];
});

const DURING_INTRO = Date.UTC(2026, 8, 21);
const AFTER_INTRO = Date.UTC(2027, 0, 2);

describe("what a call costs", () => {
  // Gemini 3.x Flash runs at an introductory rate through 2026-12-31 and at
  // standard rates from 2027-01-01. A table pinned to today's number would
  // quietly under-count every request from January.
  test("the published rate is read against the clock", () => {
    expect(textRate(DURING_INTRO)).toEqual({ input: 0.75, output: 3.75 });
    expect(textRate(AFTER_INTRO)).toEqual({ input: 1.5, output: 7.5 });
  });

  test("a deployment on another provider states its own rate", () => {
    process.env.AI_PRICE_INPUT_USD_PER_MTOK = "2";
    process.env.AI_PRICE_OUTPUT_USD_PER_MTOK = "10";
    expect(textRate(DURING_INTRO)).toEqual({ input: 2, output: 10 });
    // A half-configured deployment keeps the published rate for the other half.
    delete process.env.AI_PRICE_OUTPUT_USD_PER_MTOK;
    expect(textRate(DURING_INTRO)).toEqual({ input: 2, output: 3.75 });
  });

  // 20k in at $0.75/M is 1.5¢; 24k out at $3.75/M is 9¢.
  test("tokens become cents at the rate of the day", () => {
    const usage = { inputTokens: 20_000, outputTokens: 24_000 };
    expect(usageCostCents(usage, DURING_INTRO)).toBeCloseTo(10.5, 6);
    expect(usageCostCents(usage, AFTER_INTRO)).toBeCloseTo(21, 6);
  });

  test("usage is read from either spelling, and refused when absent", () => {
    expect(readUsage({ usage: { prompt_tokens: 10, completion_tokens: 20 } })).toEqual({
      inputTokens: 10,
      outputTokens: 20,
    });
    expect(readUsage({ usage: { input_tokens: 3, output_tokens: 4 } })).toEqual({
      inputTokens: 3,
      outputTokens: 4,
    });
    // One side reported is still a reading; neither is not.
    expect(readUsage({ usage: { prompt_tokens: 5 } })).toEqual({ inputTokens: 5, outputTokens: 0 });
    for (const payload of [null, {}, { usage: null }, { usage: {} }, { usage: { prompt_tokens: "lots" } }]) {
      expect(readUsage(payload)).toBeNull();
    }
  });

  test("an image is priced per picture, and unset means unpriced rather than free", () => {
    expect(imageCostCents()).toBeNull();
    process.env.AI_IMAGE_USD_PER_IMAGE = "0.04";
    expect(imageCostCents()).toBeCloseTo(4, 6);
  });
});

describe("the meter", () => {
  // A build is rarely one call: a retry and up to two continuations all bill.
  test("every answered call in a turn adds to the same bill", () => {
    const meter = createMeter();
    expect(meter.metered()).toBe(false);
    meter.add({ inputTokens: 20_000, outputTokens: 24_000 }, DURING_INTRO);
    meter.add({ inputTokens: 44_000, outputTokens: 24_000 }, DURING_INTRO);
    expect(meter.calls()).toBe(2);
    expect(meter.cents()).toBeCloseTo(10.5 + (44_000 / 1e6) * 0.75 * 100 + 9, 6);
  });

  // A provider that reported nothing leaves the turn unmetered, which is not
  // the same as a turn that cost nothing.
  test("an unreported call leaves the meter untouched", () => {
    const meter = createMeter();
    meter.add(null);
    expect(meter.metered()).toBe(false);
    expect(meter.cents()).toBe(0);
  });

  test("a flat-priced call can be added directly, and nonsense cannot", () => {
    const meter = createMeter();
    meter.addCents(4);
    meter.addCents(Number.NaN);
    meter.addCents(-9);
    expect(meter.calls()).toBe(1);
    expect(meter.cents()).toBe(4);
  });
});

// One chat is worth a fraction of a cent, so rounding each to a whole cent on
// the way in would lose most of a month's spend.
test("cost is kept to the hundredth of a cent", () => {
  expect(storedCents(9.41327)).toBe(9.41);
  expect(storedCents(0.0041)).toBe(0);
  expect(storedCents(0.006)).toBe(0.01);
});
