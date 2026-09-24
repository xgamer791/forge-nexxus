// The second agent. The design agent builds a site and names the Awwwards
// originals it cloned for the header, the dropdown menu and the footer; this is
// what a separate reviewer is told about that work, how its verdict is read,
// and how the design agent's rework is checked before it is reviewed again.
// The Convex functions that run the check are in `designReview.ts`. Nothing
// here calls a model or reads a table, so both build paths can import it
// without importing the chain.
import { DESIGN_GOD } from "./designgod";
import { hasPages, type BuiltSite } from "./pages";

type Message = { role: "system" | "user" | "assistant"; content: string };

// On unless the deployment turns it off: `npx convex env set DESIGN_REVIEW 0`.
export function designReviewOn() {
  // Retired: the reviewer stays off.
  return false;
}

// How many times the reviewer may send the work back before the build stops
// without saving. `DESIGN_REVIEW_ROUNDS` changes it; 0 means the first verdict
// is the only one.
const DEFAULT_REVISIONS = 3;
const MOST_REVISIONS = 8;
export function revisionsAllowed() {
  const raw = process.env.DESIGN_REVIEW_ROUNDS?.trim();
  const set = raw ? Number(raw) : NaN;
  return Number.isInteger(set) && set >= 0 ? Math.min(set, MOST_REVISIONS) : DEFAULT_REVISIONS;
}

// How long a step of the check can go without a word before it is taken for
// dead. A step is one action, and an action has ten minutes.
export const REVIEW_QUIET_MS = 630000;

// Whether a check is still carrying its build: working on it, or through it
// and saving it. A watchdog waits while one is and has been heard from lately.
export function reviewInFlight(review: { status: string; updatedAt: number } | null | undefined, now = Date.now()) {
  return Boolean(review && ["checking", "revising", "passed"].includes(review.status) && now - review.updatedAt < REVIEW_QUIET_MS);
}

export type Part = "header" | "menu" | "footer";
export const PARTS: { part: Part; name: string }[] = [
  { part: "header", name: "header" },
  { part: "menu", name: "dropdown menu" },
  { part: "footer", name: "footer" },
];

// "the header", "the header and the footer", "the header, the dropdown menu
// and the footer".
export function partList(parts: Part[]) {
  const names = PARTS.filter(({ part }) => parts.includes(part)).map(({ name }) => `the ${name}`);
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

// The clones block, split into its three entries. An entry starts on a line
// that names its part ("Header:", "Dropdown menu:", "Footer:") and runs to
// the next one.
const ENTRY = /^\s*(?:[-*#>]+\s*|\d+[.)]\s*)?(?:\*\*)?\s*(header|(?:drop-?down\s+)?menu|drop-?down|footer)(?:\*\*)?(?:\s*:|\s+[-–—]|\s*[–—])/i;
function entries(clones: string) {
  const found = new Map<Part, string>();
  let current: Part | null = null;
  for (const line of clones.split("\n")) {
    const label = line.match(ENTRY)?.[1]?.toLowerCase();
    if (label) current = label === "header" ? "header" : label === "footer" ? "footer" : "menu";
    if (current) found.set(current, `${found.get(current) ?? ""}${line}\n`);
  }
  return found;
}

// The parts the clones block leaves without an original: no entry, or an entry
// with no address to find its original at.
const ADDRESS = /https?:\/\/[^\s)>\]"']+\.[^\s)>\]"']+/i;
export function unnamedParts(clones: string | undefined): Part[] {
  const found = entries(clones ?? "");
  return PARTS.filter(({ part }) => !ADDRESS.test(found.get(part) ?? "")).map(({ part }) => part);
}

export type PartVerdict = { original: string; equal: boolean; differences: string[] };
export type Verdict = { equal: boolean; parts: Record<Part, PartVerdict>; fixes: string[] };

// What the check says when there is nothing to compare: a part with no named
// original cannot be equal to one, and no model is asked to pretend otherwise.
export function unnamedVerdict(missing: Part[], hadBlock: boolean): Verdict {
  const parts = Object.fromEntries(PARTS.map(({ part }) => [part, {
    original: "",
    equal: !missing.includes(part),
    differences: missing.includes(part) ? ["No Awwwards original is named for it, with its address."] : [],
  }])) as Record<Part, PartVerdict>;
  const fixes = [
    ...(hadBlock ? [] : ["Your reply had no clones block. Put one after your first sentence and before the shell."]),
    ...PARTS.filter(({ part }) => missing.includes(part)).map(({ name }) =>
      `Name the Awwwards original you cloned for the ${name} in the clones block: the site, its address, and its ${name} described with values. Then make the ${name} a clone of it.`),
  ];
  return { equal: false, parts, fixes };
}

// The first whole JSON object in a reply, however it was wrapped: a code
// fence, a sentence in front, a sentence after.
export function firstObject(text: string): unknown {
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === "{") depth += 1;
      else if (char === "}" && --depth === 0) {
        try {
          return JSON.parse(text.slice(start, index + 1));
        } catch {
          break;
        }
      }
    }
  }
  return null;
}

// A model writing JSON by hand sometimes quotes its booleans.
export function truth(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string" && /^(true|false)$/i.test(value.trim())) return /^true$/i.test(value.trim());
  return undefined;
}

const LINE_LIMIT = 400;
const LIST_LIMIT = 24;
export function lines(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return list
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.replace(/\s+/g, " ").trim().slice(0, LINE_LIMIT))
    .slice(0, LIST_LIMIT);
}

// The reviewer's answer, or null when it did not give one that can be acted
// on. Agreement is all three parts equal, said outright: a verdict that calls
// the whole equal while one part is not, or one that finds a difference and
// asks for no change, is not a verdict to build on.
export function readVerdict(reply: string): Verdict | null {
  const data = firstObject(reply);
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  const read = (...keys: string[]): PartVerdict | null => {
    for (const key of keys) {
      const value = record[key];
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const part = value as Record<string, unknown>;
      return {
        original: typeof part.original === "string" ? part.original.replace(/\s+/g, " ").trim().slice(0, LINE_LIMIT) : "",
        equal: truth(part.equal) === true,
        differences: lines(part.differences),
      };
    }
    return null;
  };
  const header = read("header");
  const menu = read("menu", "dropdown", "dropdownMenu", "dropdown_menu", "dropdown menu");
  const footer = read("footer");
  const whole = truth(record.equal);
  if (whole === undefined || !header || !menu || !footer) return null;
  const parts = { header, menu, footer };
  const equal = whole && header.equal && menu.equal && footer.equal;
  if (equal) return { equal, parts, fixes: [] };
  const fixes = lines(record.fixes);
  const differences = PARTS.flatMap(({ part, name }) =>
    parts[part].equal ? [] : parts[part].differences.map((difference) => `The ${name}: ${difference}`));
  const asked = fixes.length ? fixes : differences;
  return asked.length ? { equal, parts, fixes: asked } : null;
}

// Everything the header, the menu and the footer are made of, as one string:
// for a site in pages that is its shell, which every page shares; for a site
// from before pages existed, its stylesheet and those three elements. Two
// builds with the same string have the same header, menu and footer.
export function chromeOf(site: BuiltSite) {
  const flat = (text: string) =>
    text.replace(/<!--[\s\S]*?-->/g, "").replace(/>\s+</g, "><").replace(/\s+/g, " ").trim();
  if (hasPages(site)) return flat(site.shell);
  const html = site.html ?? "";
  const every = (pattern: RegExp) => [...html.matchAll(pattern)].map((match) => match[0]).join("\n");
  return flat([
    every(/<style\b[^>]*>[\s\S]*?<\/style>/gi),
    every(/<header\b[\s\S]*?<\/header>/gi),
    every(/<nav\b[\s\S]*?<\/nav>/gi),
    every(/<footer\b[\s\S]*?<\/footer>/gi),
  ].join("\n"));
}

export async function chromeHash(site: BuiltSite) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(chromeOf(site)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Whether a build goes to the reviewer. A new site always does. An edit does
// when it changed the header, the menu or the footer -- anything in the shell
// -- because that is the design agent's work on them again; an edit that only
// touched a page leaves them as the last check found them.
export async function needsReview(kind: string, before: string | null, after: BuiltSite) {
  if (!designReviewOn()) return false;
  if (kind === "generate" || before === null) return true;
  return before !== (await chromeHash(after));
}

// A rework that writes "the rest is unchanged" in a comment instead of the
// rest. The model would be saving itself the typing and the member would lose
// every line it skipped. What comes back is the comment itself, so the design
// agent can be shown exactly what not to do again.
const ELIDED = [
  /\/\*\s*(?:\.\.\.|…)[^*]{0,160}\*\//,
  /\/\*[^*]{0,160}\b(?:unchanged|as before|omitted|truncated|elided|rest of the|remaining (?:styles|css|rules))\b[^*]{0,160}\*\//i,
  /<!--\s*(?:\.\.\.|…)(?:(?!-->)[\s\S]){0,160}-->/,
  /<!--(?:(?!-->)[\s\S]){0,160}?\b(?:unchanged|as before|omitted|truncated|elided|rest of the)\b(?:(?!-->)[\s\S]){0,160}?-->/i,
];
export function elided(markup: string): string | null {
  for (const pattern of ELIDED) {
    const found = markup.match(pattern)?.[0];
    if (found) return found.replace(/\s+/g, " ").slice(0, 120);
  }
  return null;
}

function classesIn(markup: string) {
  const found = new Set<string>();
  for (const match of markup.matchAll(/\bclass\s*=\s*(["'])([^"']*)\1/gi)) {
    for (const name of match[2].split(/\s+/)) if (name) found.add(name);
  }
  return found;
}

function styledIn(document: string) {
  const css = [...document.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((match) => match[1]).join("\n");
  return new Set([...css.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((match) => match[1]));
}

// The classes the pages use that the old shell styled and the new one does
// not. A rework is the header, the menu and the footer; the pages kept their
// markup, so every style they had they still need.
export function lostPageStyles(before: string, after: string, pages: { body: string }[]) {
  const had = styledIn(before);
  const has = styledIn(after);
  return [...classesIn(pages.map((page) => page.body).join("\n"))].filter((name) => had.has(name) && !has.has(name));
}

export const DESIGN_REVIEWER = [
  "# Design review: the header, the dropdown menu and the footer",
  "",
  "You are Forge's design reviewer, a second and separate agent. You did not build this website and you do not fix it. The design agent that built it was told to choose a beautiful header, dropdown menu and footer from the designs on Awwwards (https://www.awwwards.com/), one original for each, and to clone each one so that it matches its original completely. You compare what it built with those originals and decide whether each part is equal to its original in design and spacing. The build is saved only when you agree. Anything else sends the work back to the design agent with your fixes.",
  "",
  "## What you compare",
  "",
  "The design agent's clones block names each original and describes it. Compare against the original itself, as you know it, and not only against that description: a description that does not match the original is a difference too.",
  "",
  "A part is equal to its original only when all of these hold:",
  "",
  "- **It has an original.** A real site on Awwwards, named, with its address. A part with no original, or with an original you cannot recall well enough to compare, is not equal: ask for one you can.",
  "- **The structure matches.** The same elements, in the same order and arrangement, doing the same things: where the logo sits, how the links are grouped, what the menu is (a dropdown panel, a full-screen overlay, a mega menu), where it opens from, what it covers, what it holds, how it opens and closes, and what stays on screen as the page scrolls.",
  "- **The spacing matches.** Heights, padding, gaps, margins and alignment, the grid the part sits on, and the sizes, weights, case and tracking of its type relative to one another. Read the CSS in the shell for the real values rather than judging from class names.",
  "- **Both widths match.** On a phone and on a wide screen, the part is shaped and spaced the way its original is at that width.",
  "- **The fonts and colours are the site's own.** They match the aesthetic of the site being built, not the original's brand. Families come from Fontshare and icons from Phosphor or Lucide. Fonts and colours that differ from the original are expected and are not a difference; a family from anywhere else, an icon from another set, or colours that fight the rest of the site are.",
  "- **It still works.** The menu opens and closes by touch and by keyboard, every target is at least 44px, focus is visible, and nothing scrolls sideways.",
  "",
  "Equal means that a designer who knows the original, looking at the two side by side at the same width, would call them the same design with the same spacing, the site's own fonts and colours aside. Close is not equal.",
  "",
  "## How you answer",
  "",
  "Answer with one JSON object and nothing else: no prose before or after it, and no code fence.",
  "",
  '{"equal": false, "header": {"original": "Site name, https://its-address", "equal": false, "differences": ["..."]}, "menu": {"original": "...", "equal": true, "differences": []}, "footer": {"original": "...", "equal": false, "differences": ["..."]}, "fixes": ["..."]}',
  "",
  "- \"equal\" is true only when the header, the menu and the footer are each equal.",
  "- A difference says what the clone does and what the original does, with values where there are values: \"the header is 64px tall with 16px side padding; the original's is 96px tall with 40px\".",
  "- \"fixes\" is every change the design agent must make, each one specific enough to act on without this review beside it. It is empty only when \"equal\" is true.",
  "- On a later round you are shown the fixes you asked for last time. Check that each one was made, then review all three parts again from the start.",
].join("\n");

const SHELL_LIMIT = 90000;
const PAGE_LIMIT = 16000;
const clip = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit)}\n<!-- the rest is cut from this review -->` : text;

// The reviewer's turn: its own instructions, the rules the design agent was
// given for reference, and the work. It never sees the design agent's own
// instructions or thinking, only what it declared and what it built.
export function reviewMessages(input: {
  siteName: string;
  clones: string;
  site: BuiltSite;
  round: number;
  lastFixes: string[];
}): Message[] {
  const { site } = input;
  const work = hasPages(site)
    ? [
        "Its shell, which holds the header, the dropdown menu and the footer, and the stylesheet and scripts every page shares:",
        `\`\`\`html\n${clip(site.shell, SHELL_LIMIT)}\n\`\`\``,
        "Its home page, for the site's own aesthetic. It is not yours to judge:",
        `\`\`\`html\n${clip(site.pages.find((page) => page.path === "/")?.body ?? site.pages[0].body, PAGE_LIMIT)}\n\`\`\``,
      ]
    : [
        "Its page, which holds the header, the dropdown menu and the footer:",
        `\`\`\`html\n${clip(site.html ?? "", SHELL_LIMIT)}\n\`\`\``,
      ];
  return [
    { role: "system", content: DESIGN_REVIEWER },
    {
      role: "system",
      content:
        "The rules the design agent works to, for reference. You hold its header, dropdown menu and footer to the Header, menu and footer section, and to the parts of the Type, Icons and floor sections that touch them. Nothing else in these rules is yours to judge.\n\n" +
        DESIGN_GOD,
    },
    {
      role: "user",
      content: [
        `Website: ${input.siteName}`,
        `Round ${input.round} of the design check.`,
        ...(input.lastFixes.length
          ? [`Last round you asked for these fixes. Check that each one was made, then review all three parts again from the start:\n${input.lastFixes.map((fix) => `- ${fix}`).join("\n")}`]
          : []),
        "What the design agent says it cloned:",
        `\`\`\`clones\n${input.clones.trim()}\n\`\`\``,
        ...work,
      ].join("\n\n"),
    },
  ];
}

// What the design agent is asked on a rework: the reviewer's fixes, and the
// shape of the reply. A site in pages sends back its shell alone, since that
// is where the header, the menu and the footer live and the pages are not
// being changed; a site from before pages existed sends back its one page.
export function reworkRequest(input: { fixes: string[]; shellOnly: boolean; problem?: string }) {
  const reply = input.shellOnly
    ? "Reply with one sentence, then the clones block, then the whole shell in a ```html shell block, and nothing after. Return a page as well only if a fix cannot be made without changing it; every page you do not return stays exactly as it is. Keep every other line of the shell as it is and write it all out: the head, every style the pages use, every script and the <!--forge-page--> marker."
    : "Reply with one sentence, then the clones block, then the whole page in a ```html block, and nothing after. Keep every other line of the page as it is and write it all out.";
  return [
    "Forge's design reviewer, a second and separate agent, compared your header, dropdown menu and footer with the originals in your clones block and did not agree they are equal. Make every one of these fixes:",
    input.fixes.map((fix) => `- ${fix}`).join("\n"),
    ...(input.problem ? [`Your last rework could not be used: ${input.problem}`] : []),
    "Change only the header, the dropdown menu, the footer, and the styles and scripts that belong to them. If a fix shows your description of an original was wrong, correct the clones block as well.",
    reply,
  ].join("\n\n");
}
