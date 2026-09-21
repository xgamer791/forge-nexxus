// What a request actually cost the deployment, in real cents.
//
// This is measurement, not billing. A member is charged the flat per-kind
// credit cost in `plans.ts` and never sees a cash value; what is recorded here
// is the provider's own bill for the same call, so the margin between what a
// plan funds and what it spends can be read off `billing.funding` rather than
// guessed at. Nothing in this module reaches a client.

// Published rates, in US dollars per million tokens. Gemini 3.x Flash runs at
// an introductory rate through 2026-12-31 and at standard rates from
// 2027-01-01, so the table is read against the clock rather than pinned to a
// number that goes quietly stale in January. A deployment on another provider
// sets AI_PRICE_INPUT_USD_PER_MTOK / AI_PRICE_OUTPUT_USD_PER_MTOK and those
// win outright.
const INTRO_UNTIL = Date.UTC(2027, 0, 1);
const INTRO_RATE = { input: 0.75, output: 3.75 };
const STANDARD_RATE = { input: 1.5, output: 7.5 };

export type Rate = { input: number; output: number };

function envRate(): Partial<Rate> {
  const input = Number(process.env.AI_PRICE_INPUT_USD_PER_MTOK);
  const output = Number(process.env.AI_PRICE_OUTPUT_USD_PER_MTOK);
  return {
    ...(Number.isFinite(input) && input >= 0 ? { input } : {}),
    ...(Number.isFinite(output) && output >= 0 ? { output } : {}),
  };
}

export function textRate(now = Date.now()): Rate {
  return { ...(now < INTRO_UNTIL ? INTRO_RATE : STANDARD_RATE), ...envRate() };
}

// A picture is priced per image rather than per token, and the rate belongs to
// whichever image model the deployment runs. Unset means the cost of a picture
// is not known here, which is reported as unmetered rather than as free.
export function imageCostCents(): number | null {
  const usd = Number(process.env.AI_IMAGE_USD_PER_IMAGE);
  return Number.isFinite(usd) && usd >= 0 ? usd * 100 : null;
}

export type Usage = { inputTokens: number; outputTokens: number };

// The `usage` object an OpenAI-shaped completion carries. A provider that
// omits it, or sends something unreadable, yields null: the call is then
// recorded as unmetered, which is honest, rather than as having cost nothing.
export function readUsage(payload: unknown): Usage | null {
  const usage = (payload as { usage?: Record<string, unknown> } | null)?.usage;
  if (!usage || typeof usage !== "object") return null;
  const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);
  const inputTokens = number(usage.prompt_tokens) ?? number(usage.input_tokens);
  const outputTokens = number(usage.completion_tokens) ?? number(usage.output_tokens);
  if (inputTokens === null && outputTokens === null) return null;
  return { inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0 };
}

export function usageCostCents(usage: Usage, now = Date.now()): number {
  const rate = textRate(now);
  const dollars =
    (usage.inputTokens / 1_000_000) * rate.input + (usage.outputTokens / 1_000_000) * rate.output;
  return dollars * 100;
}

// One request's running bill. A build is rarely one call -- a retry, and up to
// two continuations when a page is cut off by the output cap, all bill -- so
// the meter is handed down and every answered call adds to it. `metered` stays
// false until something has actually been counted, which is what separates a
// call that cost nothing from one whose cost was never reported.
export type Meter = {
  add(usage: Usage | null, now?: number): void;
  addCents(cents: number): void;
  cents(): number;
  calls(): number;
  metered(): boolean;
};

export function createMeter(): Meter {
  let cents = 0;
  let counted = 0;
  return {
    add(usage, now) {
      if (!usage) return;
      cents += usageCostCents(usage, now);
      counted += 1;
    },
    addCents(amount) {
      if (!Number.isFinite(amount) || amount < 0) return;
      cents += amount;
      counted += 1;
    },
    cents: () => cents,
    calls: () => counted,
    metered: () => counted > 0,
  };
}

// Stored to the hundredth of a cent: a single chat is worth a fraction of one,
// and rounding each to a whole cent on the way in would lose most of a month.
export function storedCents(cents: number) {
  return Math.round(cents * 100) / 100;
}
