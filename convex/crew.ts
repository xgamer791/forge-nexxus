// The crew that writes one page, and the auditors that hold it to the design
// reference.
//
// Every page of a first build or a rebuild is written by a crew of its own
// (buildDraft.ts runs it): a builder and an auditor for the header, two of
// each for the body -- the top of the page and the rest of it -- and a builder
// and an auditor for the footer. An auditor is a separate agent with its own
// instructions. It reads what its builder wrote the moment it is written,
// compares it with the SkillUI Ultra extract of the reference site, and either
// agrees or sends it back with fixes. A page is kept only once every one of its
// auditors agrees; a part that still does not match after PART_REWORKS rounds
// stops the build, and nothing is saved.
//
// The header and the footer are the site's shared chrome: they live in the
// shell every page is served inside, and the home page's crew writes them. On
// every later page their auditors check them again as they stand there,
// against the reference's same page. One that differs gets CSS for that page
// alone from its builder, so the markup every other page shares never moves.
//
// The same auditors check an edit made in the thread before it is saved
// (designGate.ts). Nothing in this file calls a model or reads a table.
import { elided, firstObject, lines, truth } from "./designCheck";
import { DESIGN_GOD } from "./designgod";
import { fenceAttr, fencedBlocks, type ChatMessage } from "./generate";
import { CARRY_ON } from "./onboarding";
import { BODY_MARKER, TITLE_MARKER, type SitePage } from "./pages";

type Message = ChatMessage;

// On every builder turn, in the system channel and again beside the ask.
// The pixel measurement that keeps the part lives in visualGate.ts; this is
// what the builder is told, with the reference screenshots beside it.
export const VISUAL_INSPECT = [
  "VISUAL GATE — match the SkillUI Ultra reference to the pixel.",
  "Inspect the reference screenshot(s) attached to this turn. They are the design for this part (the header, the top half, the bottom half, or the footer).",
  "Your part is not complete, and you must not treat it as done, until it matches those screenshots: the same structure, spacing, type scale, colour and alignment.",
  "Forge renders the HTML you return and compares it, pixel by pixel, with the matching SkillUI screenshot at phone width (390) and desktop width (1440).",
  "The part is kept only when at most 0.1% of pixels differ. Saying it matches does not count. If the part was sent back, the notes are measurements from that diff.",
].join("\n");

const VISUAL_LINE = "Visual gate: match the attached SkillUI screenshots to the pixel (at most 0.1% of pixels may differ). This part is not complete until that measured diff passes.";

export type ReferenceImage = { label: string; mediaType: string; base64: string };

function withVisual(text: string) {
  return `${text}\n\n${VISUAL_LINE}`;
}

function imageMessage(shots: ReferenceImage[]): Message {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `SkillUI Ultra reference screenshot(s) for this part. Match these to the pixel.\n${shots.map((shot) => `- ${shot.label}`).join("\n")}`,
      },
      ...shots.map((shot) => ({ type: "image_url" as const, image_url: { url: `data:${shot.mediaType};base64,${shot.base64}` } })),
    ],
  };
}

export const PARTS = ["header", "body1", "body2", "footer"] as const;
export type PartName = (typeof PARTS)[number];

// How many times an auditor may send its part back before the build stops:
// round 1 is the first audit, so the fourth is the last.
export const PART_REWORKS = 3;

export type CrewPart = {
  name: PartName;
  markup?: string;
  title?: string;
  agreed: boolean;
  round: number;
  tries: number;
  // What the auditor sent back and the builder has still to make; and once it
  // has, what the auditor asked for, to check on its next round.
  fixes: string[];
  asked?: string[];
  problem?: string;
  // The builder's reply as far as it got when its step's clock stopped it
  // part way, which the next step carries on from that character, and how
  // many steps have saved it part way (MOST_RESUMES, buildDraft.ts).
  partial?: string;
  resumes?: number;
};
export type Crew = { path: string; parts: CrewPart[] };

// Each part, in the words the build log and the builders' own messages use,
// and the agents that write and check it.
export const PART_NAMES: Record<PartName, string> = {
  header: "header",
  body1: "top half",
  body2: "bottom half",
  footer: "footer",
};
export const PART_AGENTS: Record<PartName, string> = {
  header: "Header",
  body1: "Top-half",
  body2: "Bottom-half",
  footer: "Footer",
};

export function isChrome(name: PartName): name is "header" | "footer" {
  return name === "header" || name === "footer";
}

// A page's crew, ready to start. Once the shell is written, the header and
// footer start as the shared ones as they stand, which go straight to their
// auditors; everything else starts with its builder.
export function newCrew(path: string, chromeWritten: boolean): Crew {
  return {
    path,
    parts: PARTS.map((name) => ({
      name,
      ...(chromeWritten && isChrome(name) ? { markup: "" } : {}),
      agreed: false,
      round: 0,
      tries: 0,
      fixes: [],
    })),
  };
}

// What a part waits on next: its builder -- nothing written yet, or its
// auditor sent it back -- or its auditor.
export function nextFor(part: CrewPart): "build" | "audit" | "done" {
  if (part.agreed) return "done";
  if (part.markup === undefined || part.fixes.length) return "build";
  return "audit";
}

export function partOf(crew: Crew, name: PartName) {
  return crew.parts.find((part) => part.name === name)!;
}

// How much of a part, or of the site so far, a turn is shown at most.
const EXTRACT_LIMIT = 90000;
const PART_LIMIT = 60000;
const SITE_LIMIT = 80000;
const clip = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit)}\n<!-- the rest is cut from this view -->` : text;
const quoteless = (text: string) => text.replace(/"/g, "'");

// A page's own title, for the example in its fence; the builder chooses the
// real one.
export function titleOf(path: string, siteName: string) {
  const last = path.split("/").filter(Boolean).pop();
  return last ? last.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : siteName;
}

function where(routes: string[], path: string) {
  return `page ${routes.indexOf(path) + 1} of ${routes.length}`;
}

// ---------------------------------------------------------------------------
// The foundation: what Forge puts under every part
// ---------------------------------------------------------------------------

// Forge's floor under the reference's tokens: the box model, a body that never
// scrolls sideways, pictures that fit their column, and the type variables the
// header's builder sets from Fontshare. The design package's own foundation --
// the SkillUI Ultra tokens as custom properties -- comes after it.
const FLOOR = [
  ":root{--font-display:'Satoshi',system-ui,sans-serif;--font-body:'Satoshi',system-ui,sans-serif}",
  "*,*::before,*::after{box-sizing:border-box}",
  "html{-webkit-text-size-adjust:100%}",
  "body{margin:0;font-family:var(--font-body);overflow-wrap:break-word}",
  "img,svg,video{max-width:100%;height:auto}",
].join("\n");
const DEFAULT_FONT = '<link rel="stylesheet" href="https://api.fontshare.com/v2/css?f[]=satoshi@400,500,700&display=swap">';

export function foundationCss(tokens: string | undefined) {
  return tokens?.trim() ? `${FLOOR}\n${tokens.trim()}` : FLOOR;
}

function foundationNote(tokens: string | undefined) {
  return [
    "Forge writes the document around the parts: the <head> with the viewport, each page's <title> and the foundation stylesheet below, then the header, the page's <main>, and the footer.",
    "The foundation is the SkillUI Ultra reference's tokens as custom properties. Use them for colour, spacing, radius and shadow instead of new values, and set type with var(--font-display) and var(--font-body).",
    "```css",
    foundationCss(tokens),
    "```",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The builders
// ---------------------------------------------------------------------------

// The crew, as every builder is told it.
function crewOrder(routes: string[], path: string) {
  return [
    `This is an onboarding BUILD, written one page at a time by a crew. The site has ${routes.length} ${routes.length === 1 ? "page" : "pages"}: ${routes.join(", ")}. This turn is ${where(routes, path)}: ${path}.`,
    "Each page has a crew: a builder for the header, two builders for the body -- the top of the page and the rest of it -- and a builder for the footer, each paired with an auditor. An auditor compares a part with the SkillUI Ultra design reference the moment it is written, and the page is kept only when every auditor agrees it matches. Build to the reference: anything invented in its place is sent back.",
    "This turn's reply is one part of one page, not the whole site: where the platform contract asks for a shell and pages, reply the way this turn asks instead. Read the attached website-build-brief.md and work privately. Do not ask questions, discuss your plan, or reply with planning prose.",
  ].join("\n\n");
}

const SECTION_RULES = [
  "- Build each section to the SkillUI Ultra reference's page at this address: the same sections in the same order, with the same layout, spacing, type scale, colours and components, at phone and desktop widths. A page with no counterpart among the reference's pages follows the reference's design system: its components, spacing, type and colour.",
  "- Write every word from the brief, and ask for every picture through forge-image at the aspect of the reference's image slot. Never use the reference's words, pictures, logos or name.",
].join("\n");

function headerAsk(routes: string[]) {
  return [
    "You are the header builder. Write the site's header to the SkillUI Ultra reference's header: the same structure, placement, height, spacing, type scale, colours and states, and on a phone the same menu, opening the same way.",
    "- The brand is this business's own name as a wordmark, never the reference's logo or name.",
    `- The navigation links every page of this site by its path: ${routes.join(", ")}. Name each destination in the business's own words.`,
    '- A menu that opens on a phone is a button with a small script that opens and closes it by touch and by keyboard. The same script marks the link to the page being shown with aria-current="page", from location.pathname.',
    "- Choose the type from Fontshare the way DESIGN_GOD's Type section says: one <link> to https://api.fontshare.com and a :root rule setting --font-display and --font-body. Leave both out to keep the foundation's Satoshi.",
    '- Add one <meta name="description"> for the site, written from the brief.',
    "Put every style the header uses in one <style> element before it, every rule scoped under .site-header or classes starting hd-. Forge moves your <link>, <meta> and <style> into the <head>.",
    'Reply with one sentence saying what you built, then the header in a ```html part="header" block, and nothing after.',
  ].join("\n");
}

function footerAsk(routes: string[]) {
  return [
    "You are the footer builder. Write the site's footer to the SkillUI Ultra reference's footer: the same structure, columns, order, spacing, type scale and colours, at phone and desktop widths.",
    `- It carries this business's own details from the brief -- its name, where to find it, when it is open, how to reach it -- and links every page by its path: ${routes.join(", ")}. Never the reference's details.`,
    "Put every style the footer uses in one <style> element before it, every rule scoped under .site-footer or classes starting ft-. Forge moves it into the <head>.",
    'Reply with one sentence saying what you built, then the footer in a ```html part="footer" block, and nothing after.',
  ].join("\n");
}

function topAsk(path: string, siteName: string, imagery?: string) {
  return [
    "You are the builder for the top of this page: its opening and the sections after it, to about the middle of the reference's page at this address. Another builder writes the rest of the page after yours, and the header and footer are written separately: write none of them.",
    SECTION_RULES,
    "- The page has one h1, and it is in your opening.",
    ...(imagery ? [`- ${imagery}`] : []),
    "Put the styles your sections use in one <style> element at the start of your markup, every class starting a-. Send only your <section> elements: Forge puts the page's <main> around them.",
    `Reply with one sentence saying what you built, then your sections in a \`\`\`html part="body1" title="${quoteless(titleOf(path, siteName))}" block, and nothing after. The title is this page's own, for the browser tab.`,
  ].join("\n");
}

function restAsk() {
  return [
    "You are the builder for the rest of this page: from about the middle of the reference's page at this address down to the last section before the footer. The top of the page is written, below: carry on from where it ends, and do not repeat its opening or any of its sections. The header and footer are written separately: write neither.",
    SECTION_RULES,
    "- The top of the page holds its h1: start your headings at h2.",
    "Put the styles your sections use in one <style> element at the start of your markup, every class starting b-. Send only your <section> elements: Forge puts the page's <main> around them.",
    'Reply with one sentence saying what you built, then your sections in a ```html part="body2" block, and nothing after.',
  ].join("\n");
}

// A later page's header or footer: the shared one, changed for this page by
// CSS alone.
function chromeAsk(name: "header" | "footer", path: string, fixes: string[]) {
  return [
    `You are the ${name} builder. The ${name} is shared by every page: it was written and approved with the home page, and it is in the shell above. On this page its auditor compared it with the reference's ${name} on the reference's page at this address, and asked for these changes:`,
    fixes.map((fix) => `- ${fix}`).join("\n"),
    `Make them as CSS for this page alone: one <style> element and nothing else, every selector starting with body:has(main[data-forge-route="${path}"]) so no other page changes. The markup stays as it is.`,
    `Reply with one sentence saying what you changed, then the style in a \`\`\`html part="${name}" block, and nothing after.`,
  ].join("\n");
}

// The site so far, for a later page's builders: how its pages are made, which
// they build on and never change.
function siteSoFar(shell: string, home: SitePage | undefined) {
  const shown = [`\`\`\`html shell\n${clip(shell, SITE_LIMIT)}\n\`\`\``];
  if (home && shell.length < SITE_LIMIT) shown.push(`\`\`\`html path="/"\n${clip(home.body, SITE_LIMIT - shell.length)}\n\`\`\``);
  return ["The site so far, as written and approved. Build on it and keep to how it is made; none of it is yours to change or repeat.", ...shown].join("\n\n");
}

export type BuilderInput = {
  // The house rules, the design files and the platform contract every build
  // turn carries (onboardingMessages).
  base: Message[];
  extract: string;
  foundation?: string;
  brief: string;
  siteName: string;
  routes: string[];
  path: string;
  part: CrewPart;
  // The shell and the home page, once the home page's crew has written them.
  written?: { shell: string; home?: SitePage };
  // For the rest of the page: the top of it, as written.
  top?: string;
  rebuild?: string;
  // A rebuild's home page owes the member new pictures.
  imagery?: string;
  // The reply its step's clock stopped part way, to carry on.
  carry?: string;
  // SkillUI reference screenshots for this part, already resized.
  shots?: ReferenceImage[];
};

// One builder's turn: the rules every build turn carries, the reference, the
// crew and the foundation, the brief, and then its own part to write -- or,
// when its auditor sent the part back, its last reply and the fixes.
export function builderTurn(input: BuilderInput): Message[] {
  const { part, path } = input;
  const adjusting = Boolean(input.written) && isChrome(part.name);
  const messages: Message[] = [
    ...input.base,
    { role: "system", content: clip(input.extract, EXTRACT_LIMIT) },
    { role: "system", content: foundationNote(input.foundation) },
    { role: "system", content: VISUAL_INSPECT },
    { role: "system", content: crewOrder(input.routes, path) },
    ...(input.rebuild ? [{ role: "system" as const, content: input.rebuild }] : []),
    { role: "user", content: `File: website-build-brief.md\n\n${input.brief}` },
  ];
  const shots = (input.shots ?? []).filter((shot) => /^image\/(png|jpeg|webp)$/.test(shot.mediaType) && shot.base64.length > 0 && shot.base64.length <= 1_500_000).slice(0, 3);
  if (shots.length) messages.push(imageMessage(shots));
  const context: string[] = [];
  if (input.written) context.push(siteSoFar(input.written.shell, adjusting ? undefined : input.written.home));
  if (part.name === "body2" && input.top !== undefined) {
    context.push(`The top of this page, as written:\n\`\`\`html\n${clip(input.top, PART_LIMIT)}\n\`\`\``);
  }
  if (adjusting && part.markup) {
    context.push(`Your last CSS for this page's ${part.name}, which its auditor sent back:\n\`\`\`html\n${clip(part.markup, PART_LIMIT)}\n\`\`\``);
  }
  const ask = adjusting
    ? chromeAsk(part.name as "header" | "footer", path, part.fixes)
    : part.name === "header"
      ? headerAsk(input.routes)
      : part.name === "footer"
        ? footerAsk(input.routes)
        : part.name === "body1"
          ? topAsk(path, input.siteName, input.imagery)
          : restAsk();
  messages.push({ role: "user", content: withVisual([...context, ask].join("\n\n")) });
  // Sent back: the builder's own last reply, then what its auditor asked for.
  // A later page's chrome states its fixes in the ask itself.
  if (!adjusting && part.fixes.length && part.markup) {
    messages.push({ role: "assistant", content: `\`\`\`html part="${part.name}"\n${clip(part.markup!, PART_LIMIT)}\n\`\`\`` });
    messages.push({
      role: "user",
      content: withVisual([
        `Your ${PART_NAMES[part.name]} was compared with the SkillUI Ultra reference and did not match. Make every one of these changes, keep everything else as it is, and write the whole part out again, in the same kind of block:`,
        part.fixes.map((fix) => `- ${fix}`).join("\n"),
      ].join("\n")),
    });
  }
  if (part.problem) {
    const last = messages[messages.length - 1];
    messages[messages.length - 1] = { ...last, content: `${last.content}\n\nYour last reply for this part could not be used: ${part.problem}` };
  }
  // Stopped part way by its step's clock: the reply so far goes back as the
  // builder's own words, with the request to carry on from where it ended.
  if (input.carry !== undefined) {
    messages.push({ role: "assistant", content: input.carry });
    messages.push({ role: "user", content: CARRY_ON });
  }
  return messages;
}

// ---------------------------------------------------------------------------
// What a builder sent back
// ---------------------------------------------------------------------------

export type BuiltPart = { markup: string; title?: string } | { problem: string };

const STYLE_ONLY = /<style\b[^>]*>[\s\S]*?<\/style>/gi;

// The block a builder's reply holds its part in: the one named for the part,
// else its first html block.
export function partBlock(reply: string, part: PartName) {
  const html = fencedBlocks(reply).filter((block) => /^html\b/i.test(block.info) && !/^html\s+shell\b/i.test(block.info));
  return html.find((candidate) => fenceAttr(candidate.info, "part")?.toLowerCase() === part) ?? html[0];
}

// A builder's reply, read for its part. A reply that is not one part, whole
// and clean, comes back as the problem to put right on the next go.
export function readPart(reply: string, input: { part: PartName; adjusting: boolean; path: string }): BuiltPart {
  const { part } = input;
  const block = partBlock(reply, part);
  if (!block) return { problem: `the reply had no \`\`\`html part="${part}" block in it. Send the ${PART_NAMES[part]} in one.` };
  if (!block.closed) return { problem: `the ${PART_NAMES[part]} stopped before its block closed. Write it out in full and close the fence.` };
  const markup = block.body.trim();
  if (!markup) return { problem: `the ${PART_NAMES[part]} came back empty. Write it out in full.` };
  if (/<(?:!doctype|html|head|body)\b/i.test(markup)) {
    return { problem: `the ${PART_NAMES[part]} is a whole document. Send only the ${PART_NAMES[part]}: Forge writes the <html>, <head> and <body> around it.` };
  }
  const gap = elided(markup);
  if (gap) return { problem: `the ${PART_NAMES[part]} has a comment standing in for part of it (${gap}). Write every line of it out in full, with no comment in place of code.` };
  if (input.adjusting) {
    if (markup.replace(STYLE_ONLY, "").replace(/<!--[\s\S]*?-->/g, "").trim()) {
      return { problem: `send only a <style> element: the shared ${part} keeps its markup, and this page changes it with CSS alone.` };
    }
    if (!/data-forge-route/.test(markup)) {
      return { problem: `scope every rule to this page, starting each selector with body:has(main[data-forge-route="${input.path}"]).` };
    }
    return { markup };
  }
  if (part === "header" && !/<header\b/i.test(markup)) return { problem: "the header has no <header> element. Put the whole header in one." };
  if (part === "footer" && !/<footer\b/i.test(markup)) return { problem: "the footer has no <footer> element. Put the whole footer in one." };
  if (part === "body1" || part === "body2") {
    if (/<main\b/i.test(markup)) return { problem: "Forge puts the page's <main> around the sections. Send only your <section> elements." };
    if (!markup.replace(STYLE_ONLY, "").trim()) return { problem: `the ${PART_NAMES[part]} has styles and no sections. Write the sections themselves.` };
  }
  const title = part === "body1" ? fenceAttr(block.info, "title")?.replace(/\s+/g, " ").trim().slice(0, 120) : undefined;
  return title ? { markup, title } : { markup };
}

// ---------------------------------------------------------------------------
// The auditors
// ---------------------------------------------------------------------------

export const AUDITOR = [
  "# Design audit: one part of one page",
  "",
  "You are one of Forge's design auditors, a separate agent from the builders. You did not build this page and you do not fix it. Every part of every page has its own auditor, and you audit one: the header, the top of the page, the rest of the page, or the footer. You compare what the builder wrote with the SkillUI Ultra design reference -- the design SkillUI extracted from the reference site, with its tokens, type, spacing, components, layout and interactions, screen by screen -- and decide whether the part matches it. The page is kept only when every auditor agrees. Anything else goes back to the builder with your fixes.",
  "",
  "## What a match is",
  "",
  "A part matches the reference only when all of these hold:",
  "",
  "- **Structure.** The same elements, in the same order and arrangement, doing the same things as the reference's same part on the reference's page at this address: the sections and what each holds, where the brand and the links sit, what the menu is and how it opens, what stays on screen as the page scrolls.",
  "- **Layout and spacing.** Widths, columns, gaps, padding, heights and alignment, and the grid the part sits on. Read the CSS for the real values rather than judging from class names.",
  "- **Type scale.** Sizes, weights, case, tracking and line height, relative to one another.",
  "- **Colour and surfaces.** The reference's palette in the reference's roles, through the foundation's custom properties; borders, radii and shadows as the reference has them.",
  "- **Components and states.** Buttons, links, cards, forms and menus shaped and styled the way the reference's are, with the same hover, focus and open states.",
  "- **Both widths.** On a phone and on a wide screen the part is shaped the way the reference's is at that width.",
  "",
  "Some things are never differences, and asking for them is a mistake:",
  "",
  "- The words, the pictures, the business's name and its wordmark are this business's own, from its brief. The reference's must never appear: a part that uses them does not match.",
  "- DESIGN_GOD's Type, Icons, Anti-slop and floor rules win over the reference. A Fontshare family, a Phosphor or Lucide icon, a white light surface where the reference is cream, a visible focus style or a larger tap target is that rule being kept, not a difference.",
  "- A picture is a forge-image request until the build is saved: judge its slot -- where it sits and its aspect -- never what it shows.",
  "",
  "Close is not a match: a designer who knows the reference, looking at the two side by side at the same width, would call them the same design with the same spacing, this business's words and pictures aside. Judge what a visitor would see, and never ask for a change that would not change it.",
  "",
  "## How you answer",
  "",
  "Answer with one JSON object and nothing else: no prose before or after it, and no code fence.",
  "",
  '{"agree": false, "differences": ["..."], "fixes": ["..."]}',
  "",
  '- "agree" is true only when the part matches.',
  '- A difference says what the part does and what the reference does, with values where there are values: "the opening is 480px tall with the headline on the left; the reference\'s fills the first screen with the headline centred over the picture".',
  '- "fixes" is every change the builder must make, each one specific enough to act on without this audit beside it. It is empty only when "agree" is true.',
  "- On a later round you are shown the fixes you asked for last time. Check that each one was made, then audit the whole part again from the start.",
].join("\n");

// What each auditor audits, in its own instructions.
const AUDITS: Record<PartName, string> = {
  header: "the header, with its menu as it opens on a phone",
  body1: "the top of the page: its opening and the sections after it, to about the middle of the reference's page at this address",
  body2: "the rest of the page: from about the middle of the reference's page at this address down to the last section before the footer",
  footer: "the footer",
};

export type AuditInput = {
  extract: string;
  foundation?: string;
  siteName: string;
  routes: string[];
  path: string;
  part: PartName;
  // What the auditor judges, and what it is shown beside it for context.
  work: { label: string; markup: string };
  context?: { label: string; markup: string }[];
  round: number;
  lastFixes: string[];
};

// An auditor's turn: its own instructions, the builders' rules for reference,
// the reference itself, and the work. It never sees a builder's instructions
// or thinking, only what the builder wrote.
export function auditorTurn(input: AuditInput): Message[] {
  const known = input.routes.includes(input.path);
  return [
    { role: "system", content: AUDITOR },
    {
      role: "system",
      content:
        "The rules the builders work to, for reference. Of these, only the Type, Icons, Anti-slop and floor sections are yours to apply, and where they and the reference differ, they win.\n\n" +
        DESIGN_GOD,
    },
    { role: "system", content: clip(input.extract, EXTRACT_LIMIT) },
    {
      role: "user",
      content: [
        `Website: ${input.siteName}`,
        known
          ? `${where(input.routes, input.path)}: ${input.path}. You audit ${AUDITS[input.part]}.`
          : `A page at ${input.path}, which has no counterpart among the reference's pages: hold it to the reference's design system. You audit ${AUDITS[input.part]}.`,
        `Round ${input.round} of this part's audit.`,
        ...(input.lastFixes.length
          ? [`Last round you asked for these fixes. Check that each one was made, then audit the whole part again from the start:\n${input.lastFixes.map((fix) => `- ${fix}`).join("\n")}`]
          : []),
        `The foundation stylesheet in every page's <head>, the reference's tokens:\n\`\`\`css\n${foundationCss(input.foundation)}\n\`\`\``,
        `${input.work.label}\n\`\`\`html\n${clip(input.work.markup, PART_LIMIT)}\n\`\`\``,
        ...(input.context ?? []).map((item) => `${item.label} It is not yours to judge.\n\`\`\`html\n${clip(item.markup, PART_LIMIT)}\n\`\`\``),
      ].join("\n\n"),
    },
  ];
}

export type Audit = { agree: boolean; differences: string[]; fixes: string[] };

// An auditor's verdict, or null when it did not give one that can be acted
// on: no answer, or a part it says does not match with nothing to change.
export function readAudit(reply: string): Audit | null {
  const data = firstObject(reply);
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  const agree = truth(record.agree ?? record.matches ?? record.match ?? record.equal);
  if (agree === undefined) return null;
  if (agree) return { agree, differences: [], fixes: [] };
  const differences = lines(record.differences);
  const fixes = lines(record.fixes);
  const asked = fixes.length ? fixes : differences;
  return asked.length ? { agree, differences, fixes: asked } : null;
}

// What the crew's auditor for a part is shown: the part, and what it sits
// beside. On a later page the header and footer are the shared ones in the
// shell, with this page's own CSS for them.
export function crewWork(crew: Crew, name: PartName, shell: string | undefined): Pick<AuditInput, "work" | "context"> {
  const part = partOf(crew, name);
  if (shell && isChrome(name)) {
    return {
      work: {
        label: `The shared ${name} is in this shell, which every page is served inside; it was approved with the home page. Audit the ${name} as it stands on this page, with this page's own CSS for it below.`,
        markup: [shell, part.markup ? `<!-- this page's CSS for the ${name} -->\n${part.markup}` : `<!-- this page has no CSS of its own for the ${name} -->`].join("\n"),
      },
    };
  }
  if (isChrome(name)) return { work: { label: `The ${name}, as its builder wrote it:`, markup: part.markup ?? "" } };
  const other = partOf(crew, name === "body1" ? "body2" : "body1");
  return {
    work: { label: `The ${PART_NAMES[name]}, as its builder wrote it:`, markup: part.markup ?? "" },
    context: other.markup ? [{ label: `The ${PART_NAMES[other.name]}, for context.`, markup: other.markup }] : [],
  };
}

// ---------------------------------------------------------------------------
// Putting a page together
// ---------------------------------------------------------------------------

const escapeAttr = (text: string) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

// The head items a part carries -- its styles, its Fontshare link, the
// site's description -- and the part without them.
function headItems(markup: string) {
  const items: string[] = [];
  const rest = markup
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>|<link\b[^>]*>|<meta\b[^>]*>/gi, (tag) => {
      items.push(tag.trim());
      return "";
    })
    .trim();
  return { items, rest };
}

// The shell every page is served inside, from the home page's header and
// footer: Forge's head, the foundation, the parts' own styles, and the marker
// each page goes in at.
export function shellFrom(input: { foundation?: string; header: string; footer: string; siteName: string }) {
  const header = headItems(input.header);
  const footer = headItems(input.footer);
  const items = [...header.items, ...footer.items];
  const links = items.filter((tag) => /^<link\b/i.test(tag));
  const styles = items.filter((tag) => /^<style\b/i.test(tag));
  const description =
    items.find((tag) => /^<meta\b/i.test(tag) && /\bname\s*=\s*["']?description/i.test(tag)) ??
    `<meta name="description" content="${escapeAttr(input.siteName)}">`;
  // The foundation's Satoshi is loaded unless the header chose its own
  // families for both roles.
  const css = styles.join("\n");
  const ownType = links.some((tag) => /api\.fontshare\.com/i.test(tag)) && /--font-display\s*:/.test(css) && /--font-body\s*:/.test(css);
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    `<title>${TITLE_MARKER}</title>`,
    description,
    ...(ownType ? [] : [DEFAULT_FONT]),
    ...links,
    `<style>\n${foundationCss(input.foundation)}\n</style>`,
    ...styles,
    "</head>",
    "<body>",
    header.rest,
    BODY_MARKER,
    footer.rest,
    "</body>",
    "</html>",
  ].join("\n");
}

// A page, once every auditor on it agreed: the two halves of its body in the
// page's <main>, and on a page after the home page, its own CSS for the shared
// header and footer. The home page's header and footer are the shell's.
export function pageFrom(crew: Crew, input: { siteName: string; chromeInShell: boolean }): SitePage {
  const markup = (name: PartName) => partOf(crew, name).markup?.trim() ?? "";
  const own = input.chromeInShell ? [] : [markup("header"), markup("footer")].filter(Boolean);
  return {
    path: crew.path,
    title: partOf(crew, "body1").title || titleOf(crew.path, input.siteName),
    body: [...own, `<main id="main" data-forge-route="${escapeAttr(crew.path)}">`, markup("body1"), markup("body2"), "</main>"].join("\n"),
  };
}
