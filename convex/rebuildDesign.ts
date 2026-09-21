// Rebuild changes the art direction, not the business brief. These are
// compositional constraints, never page templates or stored previous designs.
const OPENINGS = [
  "A subject-led, edge-to-edge visual opening with compact typography placed in deliberate negative space. Do not use a text column followed by an illustration panel.",
  "An asymmetric opening with a narrow editorial text rail and a dominant portrait-format subject image. On phones put the subject image before the headline, not below the CTA.",
  "Open directly inside the offer: a large featured product, service or piece of work, with navigation and explanatory copy integrated around it. No separate generic marketing hero.",
  "A panoramic image band with a compact centered title crossing its boundary into the next surface. Keep the first viewport shallow and lead immediately into the substance of the business.",
  "A deliberately offset composition: a small lead statement, a large image cropped off one edge, and a second content column starting at a different vertical position. Preserve the asymmetry on mobile without overflow.",
  "An image-led editorial cover: full-height subject imagery, restrained title near the bottom, and a compact navigation strip. Follow with an open, non-card content composition.",
  "A gallery-led opening with unequal image sizes and a short title integrated into the gallery. Give the actual offer visual prominence rather than an oversized headline above a button.",
];
const TYPE = [
  "Use a characterful editorial serif for the one sitewide family, with moderate headline sizes and deliberate weight contrast.",
  "Use a condensed display-capable family sitewide, with short, large headings and generous body leading.",
  "Use a humanist sans family sitewide, with restrained, smaller headings and hierarchy driven by alignment and space.",
  "Use a rounded, expressive sans family sitewide, with a bold title scale and quieter navigation.",
  "Use a sharp grotesque family sitewide, with compact medium-weight headings and strong differences in content density.",
];
const SURFACES = [
  "Use a light neutral main canvas, a large brand-color surface and contrasting dark detail areas. Avoid a pale tinted canvas repeated through the entire page.",
  "Use a deep dark main canvas and bright, readable text, with one subject-derived accent and a light contrasting content surface. No neon or glow defaults.",
  "Use a confident saturated main surface chosen from the subject, with neutral supporting areas. Color should occupy substantial space, not merely recolor buttons.",
  "Use a crisp white main canvas with large photographic areas and very little decorative color. Let the subject imagery, scale and negative space carry the identity.",
];

export function rebuildDirection(attempt: number, round = 0) {
  // Reserve two directions per attempt, so a successful automatic retry does
  // not become the next manual rebuild's initial direction.
  const n = Math.max(0, Math.floor(attempt) - 1) * 2 + round;
  return `REBUILD ART DIRECTION — mandatory for this attempt, not a suggestion.
Opening/composition: ${OPENINGS[n % OPENINGS.length]}
Typography: ${TYPE[n % TYPE.length]}
Surface/color treatment: ${SURFACES[n % SURFACES.length]}
Preserve explicit brand fonts/colors and business facts if supplied; adapt these constraints around them. Unspecified choices are free, not requirements inherited from the previous output.
Privately plan 4–6 specific color tokens, one chosen font, responsive composition and image art direction before writing code. Apply this direction to the whole page, not just the hero. Invent section treatments for this business; do not fill a fixed section kit.
Do not default to a large left-aligned headline, paragraph, button and boxed illustration stacked in that order. Renaming classes, adding text, recoloring buttons or replacing an image is not a redesign. Compose new HTML and CSS from scratch.
Do not print these directions or their names on the page. Before returning, critique whether the result visibly follows this direction at phone and desktop widths.`;
}

// One-way layout/style signatures: the model receives none of these and no
// previous CSS. Ignore selectors, paint colors and prose so class renaming,
// palette swaps and extra copy cannot conceal substantial stylesheet reuse.
export async function styleSignature(html: string): Promise<string[]> {
  const css = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)]
    .map(match => match[1]).join("\n").replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks = [...new Set(css.split("}").map(block => {
    const declarations = block.slice(block.lastIndexOf("{") + 1).split(";")
      .map(value => value.trim().toLowerCase().replace(/\s+/g, " ").replace(/\s*([:,()])\s*/g, "$1"))
      .filter(value => /^(display|position|grid[-\w]*|flex[-\w]*|align[-\w]*|justify[-\w]*|gap|row-gap|column-gap|(?:min-|max-)?width|(?:min-|max-)?height|margin[-\w]*|padding[-\w]*|font-size|font-weight|line-height|letter-spacing|border-radius|text-align|overflow|object-fit|aspect-ratio)\s*:/.test(value));
    return declarations.length >= 3 ? declarations.sort().join(";") : "";
  }).filter(Boolean))].sort((a, b) => b.length - a.length).slice(0, 192);
  return await Promise.all(blocks.map(async block => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(block));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  }));
}

export function repeatsStyling(next: string[], discarded: string[][]) {
  const current = new Set(next);
  return discarded.some(previous => {
    const shared = previous.filter(hash => current.has(hash)).length;
    return shared >= 12 && shared / Math.min(previous.length, current.size) >= 0.72
      && shared / Math.max(previous.length, current.size) >= 0.45;
  });
}
