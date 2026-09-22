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
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { callProvider, chatRoute, completionBody, describe as scrub } from "./generate";

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
    purpose: v.optional(v.union(v.literal("chat"), v.literal("build"), v.literal("strategy"))),
    // Extra body fields to try, as JSON. A provider's own switches -- a
    // thinking budget, an effort level -- are not in the OpenAI shape, and
    // the only way to learn whether this route takes one is to send it and
    // read the answer. Never part of a real turn: `completionBody` decides
    // those, and this is how something gets tested before it is wired in.
    extra: v.optional(v.string()),
  },
  handler: async (_ctx, { maxTokens, prompt, purpose, extra }) => {
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
        body: JSON.stringify({
          ...completionBody(route, [{ role: "user", content: prompt ?? "Reply with the exact word: ok" }], maxTokens ?? 200),
          ...(extra ? (JSON.parse(extra) as Record<string, unknown>) : {}),
        }),
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

// What a published site's own address actually answers, for whoever runs the
// deployment: `npx convex run probe:site '{"slug":"my-site"}'`.
//
// It exists because a site can be published, correct and served by this
// deployment while its address still shows a visitor nothing. Between the two
// sits hosting nobody can see from here: DNS, a certificate, the Cloudways
// router in `cloudways/sites-router`, and the Varnish cache in front of it.
// This says which of them answered, by asking the address the way a visitor
// would and reporting the shape of what came back.
//
// It returns headers and a verdict, never a page: the page is the member's,
// and its bytes say nothing a header does not.
// Named, because this action asks the deployment about itself: without a
// return type of its own, typing it means typing `internal`, which means
// typing this action, and TypeScript gives up on the whole API rather than
// go round again.
type SiteProbe = {
  slug: string;
  error?: string;
  address?: string;
  origin?: string | null;
  durationMs?: number;
  unreachable?: string;
  httpStatus?: number;
  chars?: number;
  viaSitesRouter?: boolean;
  cacheControl?: string | null;
  age?: string | null;
  via?: string | null;
  varnish?: string | null;
  server?: string | null;
  shows?: string;
  deploymentShows?: string;
};

export const site = internalAction({
  args: { slug: v.string(), path: v.optional(v.string()) },
  handler: async (ctx, { slug, path }): Promise<SiteProbe> => {
    const where: { url: string | null; origin: string | null } = await ctx.runQuery(
      internal.sites.addressForSlug,
      { slug },
    );
    if (!where.url) return { slug, error: "No published address for that slug" };
    const target = `${where.url}${path ?? "/"}`;
    const started = Date.now();
    let response: Response;
    let body: string;
    try {
      response = await fetch(target, { headers: { accept: "text/html" } });
      body = await response.text();
    } catch (error) {
      // A certificate that does not cover the host, or a name that does not
      // resolve, both land here: the address is unreachable, and the member
      // sees the browser's own warning rather than anything Forge wrote.
      return { slug, address: target, durationMs: Date.now() - started, unreachable: scrub(error) };
    }
    const header = (name: string) => response.headers.get(name);
    const notPublished = /Nothing here yet/.test(body);
    return {
      slug,
      address: target,
      origin: where.origin,
      httpStatus: response.status,
      durationMs: Date.now() - started,
      chars: body.length,
      // Which doorway answered, and whether anything in front of it kept a copy.
      viaSitesRouter: header("x-forge-sites-router") === "1",
      cacheControl: header("cache-control"),
      age: header("age"),
      via: header("via"),
      varnish: header("x-varnish") ?? header("x-cache"),
      server: header("server"),
      // What the visitor sees, in one word.
      shows: notPublished ? "not-published" : response.ok ? "the site" : `http ${response.status}`,
      // The same question asked of this deployment directly, which is the
      // answer the hosting in front of it is meant to be passing on.
      deploymentShows: await ctx.runQuery(internal.sites.publishedHtml, { slug, path: path ?? "/" })
        ? "the site"
        : "nothing",
    };
  },
});

// What the chat provider says it serves, for whoever runs the deployment:
// `npx convex run probe:models`. `AI_MODEL` and `AI_BUILD_MODEL` name a model
// id and nothing checks it until a build fails with the provider's own words,
// so this is the list to choose an id from rather than guessing one.
//
// Ids only. No key leaves here, and the key is scrubbed from anything the
// provider echoes back.
type ModelList = { host: string; httpStatus?: number; models?: string[]; error?: string };

export const models = internalAction({
  args: {},
  handler: async (): Promise<ModelList> => {
    const route = chatRoute("build");
    const host = hostOf(route.baseUrl);
    if (!route.apiKey) return { host, error: "No API key is set on this deployment" };
    let response: Response;
    let body: string;
    try {
      response = await fetch(`${route.baseUrl}/models`, {
        headers: { accept: "application/json", authorization: `Bearer ${route.apiKey}` },
      });
      body = await response.text();
    } catch (error) {
      return { host, error: scrub(error) };
    }
    try {
      const data = JSON.parse(body) as { data?: { id?: unknown }[] };
      const ids = (data?.data ?? [])
        .map((row) => (typeof row?.id === "string" ? row.id : null))
        .filter((id): id is string => id !== null);
      return { host, httpStatus: response.status, models: ids.sort() };
    } catch {
      return { host, httpStatus: response.status, error: scrub(body).slice(0, 200) };
    }
  },
});

// One small streamed call through the very reader a build uses, for whoever
// runs the deployment: `npx convex run probe:stream` (add `'{"purpose":"build"}'`
// or `strategy` to read that route). `probe:chat` says what a
// whole reply carries; this says how a reply moves on this route -- when the
// first token came, how much was thinking and how much was answer, how the
// stream ended -- and, when it stopped, why. The log it returns is the one a
// build writes, so a stall shows here exactly as it would in a build. Never
// the key, never the text.
type StreamNote = { phase: string; label: string; detail?: Record<string, unknown> };
export const stream = internalAction({
  // Which route to read, as `probe:chat` takes it: planning and the build can
  // run on a provider of their own, and a build is always read as a stream,
  // so a stream is the test that says whether a build will get through.
  args: { purpose: v.optional(v.union(v.literal("chat"), v.literal("build"), v.literal("strategy"))) },
  handler: async (_ctx, { purpose }): Promise<{ ok: boolean; durationMs: number; replyChars?: number; error?: string; log: StreamNote[] }> => {
    const log: StreamNote[] = [];
    const trace = { note: async (note: StreamNote) => { log.push({ phase: note.phase, label: note.label, detail: note.detail }); } };
    const started = Date.now();
    try {
      const reply = await callProvider([{ role: "user", content: "In one short sentence, say what a bakery website needs most." }], 4000, 120000, trace, purpose ?? "chat");
      return { ok: true, durationMs: Date.now() - started, replyChars: reply.length, log };
    } catch (error) {
      return { ok: false, durationMs: Date.now() - started, error: scrub(error), log };
    }
  },
});
