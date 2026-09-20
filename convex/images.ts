// Every picture Forge makes comes through here, and only pictures do. The
// route is Gemini's Nano Banana 2 Lite, called with the deployment's own image
// key. Conversation and site building never touch this module, and nothing in
// it ever calls the chat model -- the two providers cannot stand in for each
// other, so a missing image key costs a site its pictures, never its build.
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalMutation, type ActionCtx } from "./_generated/server";

export const IMAGE_MODEL = "gemini-3.1-flash-lite-image";
export const IMAGE_MODEL_LABEL = "Gemini Nano Banana 2 Lite";
const IMAGE_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const IMAGE_TIMEOUT_MS = 60000;
const PROMPT_LIMIT = 900;
const ASPECTS = new Set(["1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16"]);
const DEFAULT_ASPECT = "16:9";

// What stands in for a picture that could not be made: a quiet wash that takes
// the shape of whatever box the page gave it. A `data:` image is allowed by the
// published page's policy, so a failed image never leaves a broken one behind.
const FALLBACK_SVG =
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 9' preserveAspectRatio='none'>" +
  "<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>" +
  "<stop offset='0' stop-color='#8a8f98' stop-opacity='.3'/><stop offset='1' stop-color='#8a8f98' stop-opacity='.1'/>" +
  "</linearGradient></defs><rect width='16' height='9' fill='url(#g)'/></svg>";
const FALLBACK_SRC = `data:image/svg+xml;base64,${btoa(FALLBACK_SVG)}`;

// Lite is the rule. `AI_IMAGE_MODEL` may name a different Lite build (a dated
// or preview id); any other image model only runs when the deployment also
// sets `AI_IMAGE_MODEL_OVERRIDE=true`, so full Nano Banana 2 is a decision
// somebody made rather than a variable somebody mistyped.
export function imageRoute() {
  const wanted = process.env.AI_IMAGE_MODEL?.trim() ?? "";
  const override = process.env.AI_IMAGE_MODEL_OVERRIDE === "true";
  const lite = /flash-lite-image/i.test(wanted);
  const model = wanted && (lite || override) ? wanted : IMAGE_MODEL;
  return {
    apiKey: process.env.AI_IMAGE_API_KEY,
    baseUrl: (process.env.AI_IMAGE_BASE_URL?.trim() || IMAGE_BASE_URL).replace(/\/+$/, ""),
    model,
    // Set when the deployment asked for a model this route would not use.
    pinned: Boolean(wanted) && model !== wanted,
  };
}

type Inline = { mimeType?: string; mime_type?: string; data?: string };
type GeminiReply = {
  candidates?: { content?: { parts?: { inlineData?: Inline; inline_data?: Inline }[] } }[];
};

async function post(url: string, apiKey: string, body: unknown) {
  return await fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(body),
  });
}

// One prompt in, one picture out, as bytes. The aspect ratio is asked for the
// way the image models take it; a model build that does not know `imageConfig`
// gets the same request again without it rather than no picture.
async function requestImage(prompt: string, aspect: string) {
  const route = imageRoute();
  if (!route.apiKey) throw new Error("Image generation isn't set up on this deployment yet");
  const url = `${route.baseUrl}/models/${encodeURIComponent(route.model)}:generateContent`;
  const contents = [{ role: "user", parts: [{ text: prompt }] }];
  const shaped = { contents, generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: aspect } } };
  const plain = { contents, generationConfig: { responseModalities: ["IMAGE"] } };
  let response = await post(url, route.apiKey, shaped);
  if (response.status === 400) response = await post(url, route.apiKey, plain);
  else if (response.status === 429 || response.status >= 500) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    response = await post(url, route.apiKey, shaped);
  }
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`The image provider answered ${response.status}: ${text.replace(/\s+/g, " ").slice(0, 160)}`);
  }
  const reply = JSON.parse(text) as GeminiReply;
  for (const part of reply.candidates?.[0]?.content?.parts ?? []) {
    const inline = part.inlineData ?? part.inline_data;
    if (inline?.data) {
      const binary = atob(inline.data);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      return { bytes, type: inline.mimeType ?? inline.mime_type ?? "image/png" };
    }
  }
  throw new Error("The image provider returned no picture");
}

// The builder writes `<img src="forge-image:1" data-forge-image="…">` where it
// wants a picture; this is what reads those back out of the page.
const IMG_TAG = /<img\b[^>]*>/gi;
function attribute(tag: string, name: string) {
  const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"));
  return match ? (match[1] ?? match[2] ?? "").trim() : null;
}
function withoutAttribute(tag: string, name: string) {
  return tag.replace(new RegExp(`\\s${name}\\s*=\\s*(?:"[^"]*"|'[^']*')`, "gi"), "");
}
function withSrc(tag: string, src: string) {
  const bare = withoutAttribute(withoutAttribute(withoutAttribute(tag, "src"), "data-forge-image"), "data-forge-aspect");
  return bare.replace(/^<img\b/i, `<img src="${src}"`);
}
function decode(text: string) {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function wantsImages(html: string) {
  return /forge-image:/i.test(html) || /data-forge-image\s*=/i.test(html);
}

// Turns every picture the page asked for into a real one. Each is its own
// `image` request: its credits are held before the provider is called, settled
// when the picture is stored and released when it is not, so a picture that
// failed costs nothing and a thin balance makes fewer pictures rather than no
// site. Whatever could not be made becomes the quiet wash above, and the page
// that comes back never points at anything that does not exist.
export async function fulfilImages(
  ctx: ActionCtx,
  { html, userId, siteId, limit }: { html: string; userId: Id<"users">; siteId: Id<"sites">; limit: number },
) {
  if (!wantsImages(html)) return { html, wanted: 0, made: 0 };
  const tags = [...new Set(html.match(IMG_TAG) ?? [])].filter(
    (tag) => attribute(tag, "data-forge-image") !== null || /^forge-image:/i.test(attribute(tag, "src") ?? ""),
  );
  const jobs = tags.map((tag, index) => {
    const prompt = decode(attribute(tag, "data-forge-image") || attribute(tag, "alt") || "").slice(0, PROMPT_LIMIT);
    const asked = attribute(tag, "data-forge-aspect") ?? "";
    return { tag, prompt, aspect: ASPECTS.has(asked) ? asked : DEFAULT_ASPECT, run: index < limit && Boolean(prompt) };
  });
  const sources = await Promise.all(
    jobs.map(async (job) => {
      if (!job.run) return null;
      let holdId: Id<"creditHolds"> | null = null;
      try {
        ({ holdId } = await ctx.runMutation(internal.billing.reserve, { userId, requestKind: "image" }));
        const picture = await requestImage(
          `${job.prompt}\n\nA photograph or illustration for a website. No text, captions, watermarks, logos or borders in the picture.`,
          job.aspect,
        );
        const storageId = await ctx.storage.store(new Blob([picture.bytes], { type: picture.type }));
        const url = await ctx.storage.getUrl(storageId);
        if (!url) throw new Error("The stored picture has no address");
        await ctx.runMutation(internal.images.record, { userId, siteId, storageId, prompt: job.prompt });
        await ctx.runMutation(internal.billing.settle, { holdId });
        return url;
      } catch (error) {
        console.error("Forge image failed:", scrub(error));
        if (holdId) await ctx.runMutation(internal.billing.release, { holdId });
        return null;
      }
    }),
  );
  let page = html;
  jobs.forEach((job, index) => {
    page = page.split(job.tag).join(withSrc(job.tag, sources[index] ?? FALLBACK_SRC));
  });
  // Anything still reaching for a picture from CSS gets the wash as well.
  page = page.replace(/url\(\s*['"]?forge-image:[^)]*\)/gi, `url(${FALLBACK_SRC})`);
  return { html: page, wanted: jobs.length, made: sources.filter(Boolean).length };
}

// Never the key, never more than a line.
function scrub(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  const key = process.env.AI_IMAGE_API_KEY;
  return (key ? raw.split(key).join("[key]") : raw).slice(0, 300);
}

// A generated picture is the member's, like the site it sits on: recorded so it
// goes when the site or the account does.
export const record = internalMutation({
  args: { userId: v.id("users"), siteId: v.id("sites"), storageId: v.id("_storage"), prompt: v.string() },
  handler: async (ctx, { userId, siteId, storageId, prompt }) => {
    // The site was deleted while its picture was being made: keep nothing.
    if (!(await ctx.db.get(siteId))) {
      await ctx.storage.delete(storageId);
      return;
    }
    await ctx.db.insert("siteImages", { userId, siteId, storageId, prompt, createdAt: Date.now() });
  },
});
