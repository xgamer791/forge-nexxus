// Product configuration shared by the form and the building agent. Keep the
// wording/order identical for every new site, including repeat customers.
//
// Answers are stored by position. A brief saved under the first set of
// questions has no `questionSet`, and `currentBrief` reads it as this set, so
// nothing a member wrote is lost or relabelled. A new set of questions is a
// new QUESTION_SET and a SOURCES entry saying where each answer comes from.
export const QUESTION_SET = 2;

export const QUESTIONS = [
  { id: "name", title: "What’s your business called?", hint: "The name visitors will see on your site.", required: true, limit: 80 },
  { id: "offer", title: "What do you do, and who is it for?", hint: "A sentence or two, the way you’d tell a new customer.", required: true, limit: 5000 },
  { id: "features", title: "What should people be able to do on your site?", hint: "Choose all that fit.", options: ["Buy products", "Book an appointment", "Order for pickup or delivery", "See a menu or price list", "Find you on a map", "Browse a photo gallery", "Read reviews", "Read news or articles", "Send you a message"], multiple: true, limit: 3000 },
  { id: "catalogue", title: "What do you sell, and what does it cost?", hint: "One item or service per line, with its price if you want it shown. For example: Sourdough loaf, $9.", limit: 4000 },
  { id: "contact", title: "Where are you, and how can people reach you?", hint: "Your address or the area you serve, opening hours, phone, email and social links. Only add what you’re happy to show.", limit: 6000 },
  { id: "online", title: "Do you already sell or take bookings online?", hint: "Paste the link to your shop or booking page, like Square, Shopify, Etsy or Calendly, so your Buy and Book buttons can send customers there.", limit: 2000 },
  { id: "loved", title: "What do customers love about you?", hint: "What people tell their friends, or a review you’d like on your site.", limit: 2000 },
  { id: "feel", title: "How should your site feel?", hint: "Choose a direction, or leave it to Forge.", options: ["Clean and simple", "Bold and energetic", "Warm and welcoming", "Elegant and premium", "You decide"], limit: 1000 },
  { id: "brand", title: "Add your logo and photos", hint: "Photos of your place, products, team or work make the site yours. Type your brand colors here if you have them.", uploads: true, limit: 2000 },
  { id: "references", title: "Any websites you like the look of?", hint: "Paste up to three links if you want them noted. Forge writes your site from your answers.", limit: 2000 },
] as const;

// The last question's index. Reaching it is what lets a brief be built, so it
// is read from the list rather than written down twice.
export const FINAL_STEP = QUESTIONS.length - 1;

export type QuestionId = (typeof QUESTIONS)[number]["id"];

// One answer by its question, wherever the question sits in the list.
export function answerTo(answers: readonly string[], id: QuestionId) {
  return answers[QUESTIONS.findIndex(question => question.id === id)] ?? "";
}

// The first set of questions, by position: what a brief saved without a
// question set was answered under.
const FIRST_SET = ["name", "offer", "audience", "goal", "difference", "features", "feel", "brand", "references", "content", "catalogue"] as const;
type FirstId = (typeof FIRST_SET)[number];

// Where each answer here comes from in the first set. Two questions that
// overlapped there are one here, and the online link is new.
const SOURCES: Record<QuestionId, readonly FirstId[]> = {
  name: ["name"],
  offer: ["offer", "audience"],
  features: ["goal", "features"],
  catalogue: ["catalogue"],
  contact: ["content"],
  online: [],
  loved: ["difference"],
  feel: ["feel"],
  brand: ["brand"],
  references: ["references"],
};

// The first set's choices, as the choices here that mean the same thing. One
// with no match here stays, as the member's own words.
const FIRST_CHOICES: Record<string, string> = {
  "Buy something": "Buy products",
  "Sell products": "Buy products",
  "Accept bookings": "Book an appointment",
  "Contact you": "Send you a message",
  "Collect inquiries": "Send you a message",
  "Explore your work": "Browse a photo gallery",
  "Display a portfolio": "Browse a photo gallery",
  "Publish articles": "Read news or articles",
};
const FEATURES: readonly string[] = (QUESTIONS.find(question => question.id === "features") as { options: readonly string[] }).options;

function choices(lines: string[]) {
  const picked = new Set<string>();
  const own: string[] = [];
  for (const line of lines) {
    const choice = FIRST_CHOICES[line] ?? line;
    if (FEATURES.includes(choice)) picked.add(choice);
    else if (!own.includes(line)) own.push(line);
  }
  return [...FEATURES.filter(option => picked.has(option)), ...own].join("\n");
}

// Values saved under the first set, as this set's: the answers, or the
// answers a strategy was last drawn from, where `empty` stands for none sent.
function fromFirstSet<T extends string | null>(saved: readonly (string | null | undefined)[], empty: T): (string | T)[] {
  return QUESTIONS.map(question => {
    const parts = SOURCES[question.id].map(id => saved[FIRST_SET.indexOf(id)]);
    if (parts.every(part => part === null || part === undefined)) return empty;
    const texts = parts.map(part => (part ?? "").trim()).filter(Boolean);
    if (question.id !== "features") return texts.join("\n\n");
    return choices(texts.flatMap(text => text.split("\n").map(line => line.trim()).filter(Boolean)));
  });
}

// Where a member who had reached question `step` of the first set carries on:
// the first question here they had not answered yet. A finished brief stays
// finished.
function stepFromFirstSet(step: number, status: string) {
  if (status !== "questions" && step >= FIRST_SET.length - 1) return FINAL_STEP;
  const next = QUESTIONS.findIndex(question => {
    const sources = SOURCES[question.id];
    return !sources.length || sources.some(id => FIRST_SET.indexOf(id) >= step);
  });
  return next === -1 ? FINAL_STEP : next;
}

export type SavedBrief = {
  answers: string[];
  step: number;
  status: string;
  strategyAnswers?: (string | null)[];
  questionSet?: number;
};

// A saved brief as these questions read it.
export function currentBrief(row: SavedBrief) {
  if (row.questionSet === QUESTION_SET) return { answers: row.answers, step: row.step, strategyAnswers: row.strategyAnswers };
  return {
    answers: fromFirstSet(row.answers, ""),
    step: stepFromFirstSet(row.step, row.status),
    strategyAnswers: row.strategyAnswers ? fromFirstSet(row.strategyAnswers, null) : undefined,
  };
}

export function briefFile(answers: string[], strategy: string, assets: { name: string; url: string | null; text?: string }[]) {
  return `# Website build brief\n\n## Builder instructions\nRead this entire file before building. Create a complete, beautiful, responsive site from the answers. Develop and refine the design and build strategy privately. Never ask the user questions or explain the strategy. Use sensible design defaults for skipped preferences. Use the answers, links, assets, and uploaded text as the source for the finished site. Build every feature and integration the brief calls for.\n\n## Questions and answers\n${QUESTIONS.map((q, i) => `### ${i + 1}. ${q.title}\n${answers[i] || "Not supplied — choose a suitable default."}`).join("\n\n")}\n\n## Working design and build strategy\n${strategy || "Develop the strategy from the answers above before writing the site."}\n\n## Supplied assets\n${assets.length ? assets.map(a => `- ${a.name}: ${a.url ?? "No public URL"}${a.text ? `\n\n${a.text}` : ""}`).join("\n") : "No assets supplied. Use original CSS and SVG artwork where appropriate."}\n`;
}
