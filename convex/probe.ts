// What a deployment's chat route actually answers with, for whoever runs it:
// `npx convex run probe:chat`. `generate:routing` says where a turn is sent;
// this says what comes back from there, which is the other half of the answer
// when builds fail and the route looks right.
//
// It exists because an OpenAI-shaped 200 can still carry nothing to build
// from: a reasoning model spends the length budget thinking and leaves
// `content` empty, and a rejected key and a slow model look identical from
// the thread. One small call settles which.
//
// Nothing here returns a key. The key is described — its length, whether it
// carries whitespace a paste would have added, and the masked ends a provider
// prints itself — and every string that comes back from the provider is run
// through the same scrubber the thread uses.
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { chatRoute, completionBody, describe as scrub } from "./generate";

// Enough of a reply to tell an answer from a refusal, and never a whole page.
const PREVIEW = 200;

type Message = { content?: unknown; reasoning_content?: unknown; reasoning?: unknown };

export const chat = internalAction({
  args: {
    // A build asks for whatever `generate:routing` reports as its maxTokens;
    // the default here is small so a probe is quick and cheap. Raise it to
    // reproduce what a real build sees.
    maxTokens: v.optional(v.number()),
    prompt: v.optional(v.string()),
    purpose: v.optional(v.union(v.literal("chat"), v.literal("build"))),
  },
  handler: async (_ctx, { maxTokens, prompt, purpose }) => {
    const route = chatRoute(purpose ?? "build");
    const trimmed = route.apiKey?.trim() ?? "";
    const key = route.apiKey
      ? {
          length: route.apiKey.length,
          trimmedLength: trimmed.length,
          // A pasted newline or space is invisible in the dashboard and is
          // exactly what a 401 on an otherwise correct key looks like.
          hasOuterWhitespace: route.apiKey !== trimmed,
          hasInnerWhitespace: /\s/.test(trimmed),
          head: trimmed.slice(0, 3),
          tail: trimmed.slice(-4),
        }
      : null;
    if (!route.apiKey) {
      return { host: hostOf(route.baseUrl), model: route.model, key, error: "No API key is set on this deployment" };
    }
    const started = Date.now();
    let response: Response;
    let body: string;
    try {
      response = await fetch(`${route.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${route.apiKey}` },
        body: JSON.stringify(
          completionBody(route, [{ role: "user", content: prompt ?? "Reply with the exact word: ok" }], maxTokens ?? 200),
        ),
      });
      body = await response.text();
    } catch (error) {
      return { host: hostOf(route.baseUrl), model: route.model, key, durationMs: Date.now() - started, unreachable: scrub(error) };
    }
    const durationMs = Date.now() - started;
    const head = { host: hostOf(route.baseUrl), model: route.model, key, durationMs, httpStatus: response.status };
    let data: { model?: unknown; usage?: unknown; error?: { message?: unknown }; choices?: { finish_reason?: unknown; message?: Message }[] };
    try {
      data = JSON.parse(body);
    } catch {
      return { ...head, unreadable: scrub(body) };
    }
    const choice = data?.choices?.[0];
    const message: Message = choice?.message ?? {};
    const content = typeof message.content === "string" ? message.content : "";
    const reasoning = [message.reasoning_content, message.reasoning].find((value) => typeof value === "string") as string | undefined;
    return {
      ...head,
      servedModel: typeof data?.model === "string" ? data.model : null,
      finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : null,
      // The field names are the tell: a reasoning model carries one Forge
      // cannot build from, and how long each one is says where a budget went.
      messageKeys: Object.keys(message),
      contentChars: content.length,
      reasoningChars: reasoning?.length ?? 0,
      contentPreview: content ? scrub(content.slice(0, PREVIEW)) : null,
      usage: data?.usage ?? null,
      providerError: data?.error?.message ? scrub(String(data.error.message)) : null,
    };
  },
});

function hostOf(baseUrl: string) {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}
