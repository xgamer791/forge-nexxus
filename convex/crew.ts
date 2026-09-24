// The crew that writes one page.
//
// Every page of a first build or a rebuild is written by a crew of its own
// (buildDraft.ts runs it): a builder for the header, two for the body -- the
// top of the page and the rest of it -- and one for the footer. Each works to
// the SkillUI Ultra extract of the reference site, and a page is kept once
// every one of its parts has come back whole and clean.
//
// The header and the footer are the site's shared chrome: they live in the
// shell every page is served inside, and the home page's crew writes them.
// Every later page's crew writes only its body, inside that shell.
//
// Nothing in this file calls a model or reads a table.
import { elided } from "./designCheck";
import { fenceAttr, fencedBlocks } from "./generate";
import { CARRY_ON } from "./onboarding";
import { BODY_MARKER, TITLE_MARKER, type SitePage } from "./pages";

type Message = { role: "system" | "user" | "assistant"; content: string };

export const PARTS = ["header", "body1", "body2", "footer"] as const;
export type PartName = (typeof PARTS)[number];

export type CrewPart = {
  name: PartName;
  // What its builder wrote, once it has. After the home page the header and
  // footer are "": the shared ones in the shell, with nothing to write.
  markup?: string;
  title?: string;
  // Replies in a row that could not be used, and why the last one could not.
  tries: number;
  problem?: string;
  // The builder's reply as far as it got when its step's clock stopped it
  // part way, which the next step carries on from that character, and how
  // many steps have saved it part way (MOST_RESUMES, buildDraft.ts).
  partial?: string;
  resumes?: number;
};
export type Crew = { path: string; parts: CrewPart[] };

// Each part, in the words the build log and the builders' own messages use,
// and the builder that writes it.
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
// footer are the shared ones in it, so only the body's builders have work.
export function newCrew(path: string, chromeWritten: boolean): Crew {
  return {
    path,
    parts: PARTS.map((name) => ({
      name,
      ...(chromeWritten && isChrome(name) ? { markup: "" } : {}),
      tries: 0,
    })),
  };
}

// What a part waits on: its builder, until it has written it.
export function nextFor(part: Pick<CrewPart, "markup">): "build" | "done" {
  return part.markup === undefined ? "build" : "done";
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
    "Each page has a crew: a builder for the header, two builders for the body -- the top of the page and the rest of it -- and a builder for the footer. Build every part to the SkillUI Ultra design reference rather than inventing in its place.",
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

// The site so far, for a later page's builders: how its pages are made, which
// they build on and never change.
function siteSoFar(shell: string, home: SitePage | undefined) {
  const shown = [`\`\`\`html shell\n${clip(shell, SITE_LIMIT)}\n\`\`\``];
  if (home && shell.length < SITE_LIMIT) shown.push(`\`\`\`html path="/"\n${clip(home.body, SITE_LIMIT - shell.length)}\n\`\`\``);
  return ["The site so far, as written. Build on it and keep to how it is made; none of it is yours to change or repeat.", ...shown].join("\n\n");
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
};

// One builder's turn: the rules every build turn carries, the reference, the
// crew and the foundation, the brief, and then its own part to write.
export function builderTurn(input: BuilderInput): Message[] {
  const { part, path } = input;
  const messages: Message[] = [
    ...input.base,
    { role: "system", content: clip(input.extract, EXTRACT_LIMIT) },
    { role: "system", content: foundationNote(input.foundation) },
    { role: "system", content: crewOrder(input.routes, path) },
    ...(input.rebuild ? [{ role: "system" as const, content: input.rebuild }] : []),
    { role: "user", content: `File: website-build-brief.md\n\n${input.brief}` },
  ];
  const context: string[] = [];
  if (input.written) context.push(siteSoFar(input.written.shell, input.written.home));
  if (part.name === "body2" && input.top !== undefined) {
    context.push(`The top of this page, as written:\n\`\`\`html\n${clip(input.top, PART_LIMIT)}\n\`\`\``);
  }
  const ask = part.name === "header"
    ? headerAsk(input.routes)
    : part.name === "footer"
      ? footerAsk(input.routes)
      : part.name === "body1"
        ? topAsk(path, input.siteName, input.imagery)
        : restAsk();
  messages.push({ role: "user", content: [...context, ask].join("\n\n") });
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
export function readPart(reply: string, input: { part: PartName }): BuiltPart {
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

// A page, once its crew has written it: the two halves of its body in the
// page's <main>. The header and footer are the shell's.
export function pageFrom(crew: Crew, input: { siteName: string }): SitePage {
  const markup = (name: PartName) => partOf(crew, name).markup?.trim() ?? "";
  return {
    path: crew.path,
    title: partOf(crew, "body1").title || titleOf(crew.path, input.siteName),
    body: [`<main id="main" data-forge-route="${escapeAttr(crew.path)}">`, markup("body1"), markup("body2"), "</main>"].join("\n"),
  };
}
