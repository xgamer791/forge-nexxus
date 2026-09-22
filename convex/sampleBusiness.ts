// ——— TEMPORARY: a new San Antonio business on every rebuild ———————————
// Testing only, while there are no real members. A rebuild throws the
// member's answers away and builds from a small business invented for the
// occasion, always in San Antonio, Texas, so each rebuild tests the agent on
// a new brief instead of the same one again. The invented answers are saved
// over the old ones, so the questions show what the site was built from.
//
// The trade, the part of town and the feel are drawn here, at random, rather
// than left to the model: asked the same question, a model gives much the
// same answer, which is the problem this exists to get around. The model only
// fills in a business that fits the draw.
//
// To stop it: `npx convex env set REBUILD_SAMPLE off`, which needs no deploy.
// To remove it: delete this file and the block in onboarding.ts that calls it
// (grep `sample-business block`).
import { callProvider } from "./generate";
import { QUESTIONS } from "./onboardingQuestions";

export function sampleRebuilds() {
  return process.env.REBUILD_SAMPLE?.trim().toLowerCase() !== "off";
}

const TRADES = [
  "bakery", "taquería", "coffee roaster", "florist", "barbershop", "hair salon", "nail studio",
  "tattoo studio", "yoga studio", "boxing gym", "climbing gym", "dance school", "music school",
  "guitar repair shop", "record store", "used bookshop", "comic shop", "board game café",
  "bike shop", "auto detailing shop", "mobile mechanic", "plumber", "electrician", "roofer",
  "landscaper", "pool cleaning service", "pest control company", "house cleaning service",
  "moving company", "locksmith", "dog groomer", "dog trainer", "veterinary clinic",
  "pediatric dentist", "chiropractor", "massage therapist", "physical therapy clinic",
  "family law firm", "CPA practice", "real estate agent", "wedding photographer",
  "event planner", "caterer", "food truck", "craft brewery", "wine bar", "ice cream shop",
  "paleta shop", "bridal boutique", "vintage clothing store", "custom boot maker",
  "leather goods workshop", "ceramics studio", "screen printing shop", "sign maker",
  "furniture restorer", "interior designer", "architect", "tutoring center",
  "daycare", "senior home care agency", "piñata maker", "mariachi band for hire",
  "conjunto accordion teacher", "quinceañera dress shop", "barbecue joint", "panadería",
  "tamale shop", "plant nursery", "beekeeper selling honey", "farm stand",
];

const NEIGHBOURHOODS = [
  "Southtown", "King William", "the Pearl", "Tobin Hill", "Monte Vista", "Alamo Heights",
  "Beacon Hill", "Dignowity Hill", "Government Hill", "Lavaca", "Olmos Park", "Terrell Hills",
  "Stone Oak", "the Medical Center", "Leon Valley", "the West Side", "the East Side",
  "Harlandale", "Mission Reach", "Castle Hills", "Helotes", "Alamo Ranch", "Shavano Park",
  "Downtown on the River Walk", "Five Points", "Deco District", "Tobin Hill near St. Mary's Strip",
];

// The two single-choice questions and the one multiple-choice question.
const pick = <T,>(list: readonly T[]) => list[Math.floor(Math.random() * list.length)];
const options = (id: string) => [...((QUESTIONS.find((q) => q.id === id) as { options?: readonly string[] })?.options ?? [])];

export type SampleDraw = { trade: string; neighbourhood: string; feel: string };

export function drawSample(): SampleDraw {
  return { trade: pick(TRADES), neighbourhood: pick(NEIGHBOURHOODS), feel: pick(options("feel")) };
}

export function samplePrompt(draw: SampleDraw, previousName: string) {
  return `Invent one small, independent business so a website builder can be tested on it. It is fictional, but it must read like a real place.

- Trade: ${draw.trade}
- Where: ${draw.neighbourhood}, San Antonio, Texas
- Not called "${previousName.trim() || "anything"}", and not a play on that name.

Give it a specific name, a street address in that part of San Antonio, a 210 phone number, opening hours, the people who run it, what it is known for, and a short catalogue with prices in US dollars. Write the answers the way the owner would type them into a form: first person, plain, specific, no marketing gloss.

Reply with one JSON object and nothing else, with exactly these keys:
{
  "name": "the business name, under 60 characters",
  "offer": "what it offers, 2-4 sentences",
  "audience": "who the site is for, naming the neighbourhood and San Antonio",
  "goal": one of ${JSON.stringify(options("goal"))},
  "difference": "the one thing visitors should remember, 1-3 sentences",
  "features": an array of one to three of ${JSON.stringify(options("features"))},
  "brand": "",
  "references": "",
  "content": "address, phone, email, hours, owners' names and anything else that must be on the site",
  "catalogue": "one product or service per line, each with a price"
}`;
}

// The model's JSON, as the answers the form stores: one string per question,
// in question order, each inside its limit. Choice answers must be one of the
// choices, and several choices are one per line, as the form writes them.
export function sampleAnswers(reply: string, draw: SampleDraw): string[] {
  const json = reply.slice(reply.indexOf("{"), reply.lastIndexOf("}") + 1);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("The sample business came back unreadable");
  }
  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  const answers = QUESTIONS.map((question) => {
    const value = parsed[question.id];
    if (question.id === "feel") return draw.feel;
    // An invented owner's colours would outrank the design rules the way a
    // real member's do, so a test business never brings any.
    if (question.id === "brand") return "";
    if (question.id === "features") {
      const chosen = (Array.isArray(value) ? value : [value]).map(text).filter((v) => options("features").includes(v));
      return [...new Set(chosen)].join("\n");
    }
    if (question.id === "goal") {
      const goal = text(value);
      return options("goal").includes(goal) ? goal : "Contact you";
    }
    return text(value);
  }).map((answer, index) => answer.slice(0, QUESTIONS[index].limit));
  if (!answers[0] || !answers[1]) throw new Error("The sample business came back without a name or an offer");
  return answers;
}

// One small call on the chat route. It is not the building agent and never
// reaches it: the agent sees only the answers this returns.
export async function inventSample(previousName: string) {
  const draw = drawSample();
  const reply = await callProvider([{ role: "user", content: samplePrompt(draw, previousName) }], 16000, 120000, undefined, "chat");
  return { draw, answers: sampleAnswers(reply, draw) };
}
// ——— end sample-business block ————————————————————————————————————
