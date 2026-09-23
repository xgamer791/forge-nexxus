// The builder's measured spec, written from a captured reference.
//
// ai-site-cloner's spec-scaffold writes the mechanical parts of a spec
// straight from the extraction JSON so nothing is transcribed by hand, and its
// linter refuses a spec without measured numbers at every width. This is the
// same idea for Forge: every line below is generated from the capture, at all
// three widths, in the words the layout check uses when it sends a build back.
import { THRESHOLDS, VIEWPORTS, VIEWPORT_NAMES, describeBlock, regionBounds, summarizeBlock } from "./layout.mjs";

const px = (value) => `${Math.round(value)}px`;

function typeLine(type) {
  if (!type) return "not measured";
  const role = (name, value) => {
    if (!value) return null;
    const bits = [px(value.size), String(value.weight)];
    if (value.lineHeight !== "normal") bits.push(`line ${px(value.lineHeight)}`);
    if (value.tracking) bits.push(`tracking ${value.tracking}px`);
    if (value.transform && value.transform !== "none") bits.push(value.transform);
    if (value.italic) bits.push("italic");
    return `${name} ${bits.join(" ")}`;
  };
  return ["h1", "h2", "h3", "body", "nav", "button"].map((name) => role(name, type[name])).filter(Boolean).join("; ") || "not measured";
}

function headerLine(page) {
  const header = page.header;
  if (!header) return "no header";
  const bits = [`0–${px(header.bottom)}`, header.overlay ? "laid over the opening section" : "above the opening section"];
  if (header.fixed) bits.push("stays on screen while scrolling");
  bits.push(`${header.links} visible links`);
  if (header.toggle) bits.push(`menu button ${px(header.toggle.w)}×${px(header.toggle.h)} at ${px(header.toggle.x)},${px(header.toggle.y)}`);
  const block = summarizeBlock(page.boxes, 0, header.bottom, page.width);
  if (block.media) bits.push(`${block.media} image slot${block.media === 1 ? "" : "s"} behind it`);
  return bits.join("; ");
}

function menuLine(page) {
  const menu = page.menu;
  if (!menu?.opened) return page.header?.toggle ? "the menu button did not open anything measurable" : "nothing to open: the links sit in the header";
  const panel = menu.panel ? `a ${px(menu.panel.w)}×${px(menu.panel.h)} panel at ${px(menu.panel.x)},${px(menu.panel.y)}` : "no visible panel";
  const block = summarizeBlock(menu.boxes, 0, page.viewportHeight, page.width);
  return `the menu button opens ${panel} showing ${menu.links} links; the opened first screen has ${block.textLines + block.headingLines} lines of text, ${block.controls} controls and ${block.media} image slots`;
}

export function referencePrompt(reference) {
  const routes = reference.routes;
  const paths = routes.map((route) => route.path);
  const threshold = Math.round(Math.min(...Object.values(THRESHOLDS)) * 100);
  const lines = [
    `MEASURED DESIGN REFERENCE: ${reference.source}`,
    `Measured by script on ${reference.capturedAt.slice(0, 10)} at ${VIEWPORT_NAMES.map((name) => `${name} ${VIEWPORTS[name].width}×${VIEWPORTS[name].height}`).join(", ")}. Every number here was read from the live pages; none is an estimate.`,
    "",
    "WHAT IT DECIDES",
    "- The layout: which pages the site has, and on each page the order, height and composition of every section, the header, the opened menu and the footer, at every width below.",
    `- A layout check measures every page you return the same way and compares it with these numbers, route by route, at every width, region by region: full page, header, opened menu, body and footer. Each region has to agree at ${threshold}% or better. A site that does not is sent back with the measured differences, and a build that never agrees is not saved.`,
    "- On a rebuild this measured layout stands in for FORGE_MD's \"how the new page is designed is yours to decide\": the new build differs from the discarded one in its words and pictures, not in this geometry. Where DESIGN_GOD's layout guidance (section heights, rhythm, the nav's shape) differs from these numbers, the numbers win.",
    "",
    "WHAT IT DOES NOT DECIDE",
    "- The words, the pictures, the logo, the colours and the font families. Write every word from the brief. Fill every image slot with a new picture through forge-image at the slot's aspect ratio. Never link to, load or copy anything from the reference's host.",
    "- DESIGN_GOD's Type, Icons, Anti-slop and accessibility rules apply in full. Where Anti-slop rules out a kind of content the reference has, keep the measured geometry and fill it with content the brief supports.",
    "",
    `ROUTES: build exactly these pages and no others: ${paths.join(", ")}. Link between them by these paths. A page the reference does not have fails the check, and so does a missing one.`,
    "Put in the shell only what every route has: where a region below appears on some routes and not others, it belongs in those pages' own markup.",
    "Give each section its measured height at each width with min-height on the section itself; Forge adds a phone min-height floor to sections that set none.",
    "",
    "TYPE SCALE (sizes only; the families are DESIGN_GOD's):",
  ];
  const home = routes[0];
  for (const name of VIEWPORT_NAMES) {
    lines.push(`- ${name}: ${typeLine(home?.viewports?.[name]?.type)}`);
  }
  for (const route of routes) {
    lines.push("", `ROUTE ${route.path}`);
    for (const name of VIEWPORT_NAMES) {
      const page = route.viewports?.[name];
      if (!page) {
        lines.push(`- ${name}: not measured`);
        continue;
      }
      const bounds = regionBounds(page);
      lines.push(`- ${name} ${VIEWPORTS[name].width}px: the page is ${px(page.height)} tall.`);
      lines.push(`  header: ${headerLine(page)}.`);
      lines.push(`  menu: ${menuLine(page)}.`);
      const [bodyTop, bodyBottom] = bounds.body;
      const sections = (page.sections ?? []).filter((section) => section.top + section.height / 2 >= bodyTop && section.top + section.height / 2 < bodyBottom);
      if (!sections.length) {
        const block = summarizeBlock(page.boxes, bodyTop, bodyBottom, page.width);
        lines.push(`  body: ${describeBlock(block, null)}.`);
      }
      sections.forEach((section, index) => {
        const block = summarizeBlock(page.boxes, section.top, section.top + section.height, page.width);
        lines.push(`  section ${index + 1} of ${sections.length}: ${describeBlock(block, section)}.`);
      });
      const [footerTop, footerBottom] = bounds.footer;
      if (footerBottom > footerTop) {
        const block = summarizeBlock(page.boxes, footerTop, footerBottom, page.width);
        lines.push(`  footer: ${describeBlock(block, page.footer)}.`);
      } else {
        lines.push("  footer: none on this route.");
      }
    }
  }
  return lines.join("\n");
}
