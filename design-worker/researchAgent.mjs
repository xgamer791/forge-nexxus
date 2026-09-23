// The design-reference chooser. Brave and the DOM score only shortlist.
// A candidate becomes the reference only after Gemini 3.8 Flash sees a
// homepage screenshot and accepts it. Gemini's thinking levels are low,
// medium and high; high is the ceiling, which is what "Flash Max" means here.
// Page builders stay on the chat/build route and never call this module.

export const RESEARCH_MODEL = "gemini-3.8-flash";
export const RESEARCH_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
export const RESEARCH_THINKING = "high";
export const VISION_LOOKS = 4;
export const NO_VISION_PASS = "No design reference passed a visual check";

export function researchRoute(env = process.env) {
  const model = (env.AI_RESEARCH_MODEL || RESEARCH_MODEL).trim() || RESEARCH_MODEL;
  const baseUrl = (env.AI_RESEARCH_BASE_URL || RESEARCH_BASE_URL).trim().replace(/\/+$/, "") || RESEARCH_BASE_URL;
  const apiKey = (env.AI_RESEARCH_API_KEY || env.GEMINI_API_KEY || env.AI_IMAGE_API_KEY || "").trim();
  if (!apiKey) throw new Error("AI_RESEARCH_API_KEY is required for design research");
  return { model, baseUrl, apiKey, thinkingLevel: RESEARCH_THINKING };
}

export function parseVerdict(text) {
  const raw = String(text || "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Vision reply was not a decision");
  const parsed = JSON.parse(raw.slice(start, end + 1));
  if (typeof parsed.accept !== "boolean") throw new Error("Vision reply had no accept decision");
  const reason = typeof parsed.reason === "string" ? parsed.reason.replace(/\s+/g, " ").trim().slice(0, 180) : "";
  return { accept: parsed.accept, reason };
}

function answerText(reply) {
  const parts = reply?.candidates?.[0]?.content?.parts ?? [];
  const visible = parts.filter((part) => part?.text && !part.thought);
  return (visible.length ? visible : parts).map((part) => part.text || "").join("").trim();
}

export function visionRequest(route, candidate) {
  const offer = String(candidate.offer || "").slice(0, 400);
  const feel = String(candidate.feel || "").slice(0, 200);
  const title = String(candidate.title || "").slice(0, 160);
  const description = String(candidate.description || "").slice(0, 300);
  return {
    contents: [{
      role: "user",
      parts: [
        {
          text: [
            "You are choosing a design reference for a new business website.",
            `Business: ${offer || "unspecified"}`,
            `Feel: ${feel || "unspecified"}`,
            `Candidate homepage: ${candidate.url}`,
            `Title: ${title}`,
            `Description: ${description}`,
            "The image is a screenshot of that homepage. Accept it only when you can see a designed business site with its own layout, type and imagery that would be a useful visual reference.",
            "Reject a login wall, an error, a blank or broken page, a directory or search listing, or a page that is mostly someone else's product chrome rather than a designed business site. Judge only what you see.",
            'Reply with JSON only: {"accept": true or false, "reason": "one short sentence"}',
          ].join("\n"),
        },
        { inline_data: { mime_type: candidate.mimeType || "image/jpeg", data: candidate.image } },
      ],
    }],
    generationConfig: {
      thinkingConfig: { thinkingLevel: route.thinkingLevel },
      responseMimeType: "application/json",
      maxOutputTokens: 1024,
    },
  };
}

export async function judgeHomepage(route, candidate, fetchImpl = fetch) {
  if (!candidate.image) throw new Error("Homepage screenshot is missing");
  const endpoint = `${route.baseUrl}/models/${encodeURIComponent(route.model)}:generateContent`;
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": route.apiKey },
    body: JSON.stringify(visionRequest(route, candidate)),
    signal: AbortSignal.timeout(45000),
  });
  const text = await response.text();
  if (response.status === 401 || response.status === 403) {
    throw new Error(`Design research model refused the key (HTTP ${response.status})`);
  }
  if (!response.ok) throw new Error(`Design research model answered HTTP ${response.status}`);
  let reply;
  try { reply = JSON.parse(text); } catch { throw new Error("Design research model returned no decision"); }
  return parseVerdict(answerText(reply));
}

// DOM score only orders who is looked at. The returned URL is one Gemini
// accepted after seeing its homepage. None accepted means no reference.
export async function chooseByVision(measured, { offer = "", feel = "", emit = () => {}, judge, looks = VISION_LOOKS } = {}) {
  const ranked = [...measured].sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, looks);
  if (!ranked.length) throw new Error("No reference site could be inspected");
  let judged = false;
  for (const candidate of ranked) {
    const domain = new URL(candidate.url).hostname;
    emit("vision", { domain, verdict: "judging" });
    if (!candidate.shot) {
      emit("vision_rejected", { domain, verdict: "rejected", reason: "The homepage could not be screenshotted" });
      continue;
    }
    let verdict;
    try {
      verdict = await judge({
        url: candidate.url,
        offer,
        feel,
        title: candidate.detail?.title || candidate.title || "",
        description: candidate.detail?.description || candidate.description || "",
        image: candidate.shot,
        mimeType: "image/jpeg",
      });
    } catch (error) {
      const message = String(error?.message || error);
      if (/refused the key/i.test(message)) throw error;
      emit("vision_rejected", { domain, verdict: "rejected", reason: message.slice(0, 180) });
      continue;
    }
    judged = true;
    if (!verdict?.accept) {
      emit("vision_rejected", { domain, verdict: "rejected", reason: verdict?.reason || "Rejected after seeing the homepage" });
      continue;
    }
    emit("vision_accepted", { domain, verdict: "accepted", reason: verdict.reason || "" });
    return candidate.url;
  }
  if (!judged) throw new Error("Design research could not visually check a reference");
  throw new Error(NO_VISION_PASS);
}
