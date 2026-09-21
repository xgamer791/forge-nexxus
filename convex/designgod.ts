// Custom design requirements. Sent on every chat, build and strategy turn
// together with FORGE_MD and FED — never on image generation.
// Convex actions cannot read the filesystem at runtime.
//
// Add new visual training here. Type lives here, not in FED.

export const DESIGN_GOD = [
  "# Design God — custom design requirements",
  "",
  "Load and follow this file on every chat, strategy, and build turn, together with FORGE_MD and FED. The image model does not load this file.",
  "",
  "This file owns type and the visual rules we add over time. FORGE_MD still owns coverage, honesty and safety. FED still owns method — how to reach a palette, a layout and copy. Where this file and FED disagree, follow this file.",
  "",
  "## Fonts",
  "",
  "**One typeface for the entire build.** Use **Satoshi** or **Switzer** from Fontshare only:",
  "",
  "- Satoshi — https://www.fontshare.com/fonts/satoshi",
  "- Switzer — https://www.fontshare.com/fonts/switzer",
  "",
  "Pick one. Load it from Fontshare. Never pair two families. Never load a second font for headings and body — use weights, sizes and widths of the one family.",
  "",
  "**No more than one font per site** unless the member asks for another. An explicitly named brand font wins when they do. Otherwise stay on Satoshi or Switzer.",
  "",
  "Do **not** default to Inter, Roboto, Open Sans, Google Fonts, or system-ui stacks unless the brief names them.",
  "",
  "Always provide a readable generic fallback matching the selected family, and size the layout so it holds before the webfont arrives.",
  "",
  "## Layout and color",
  "",
  "**No card-style layouts.** Do not chop the page into rounded cards, equal tiles, or boxed units with shared borders and shadows. Stack, split and bleed the content across the canvas. Product lists, feature rows and testimonials stay open — no card chrome around each item. This is a ban, not a default to avoid: even a SaaS brief does not get the card kit.",
  "",
  "**No accent color on text.** Headings, body, labels, nav, links and buttons-as-text stay in the ink palette — black, white, or a near-neutral from the same family. An accent belongs on a surface, a rule, a mark or a filled control, never on a word. Do not color a headline, a single word in a headline, or a body passage with the accent.",
  "",
  "**Always use full page width layouts.** The composition spans the viewport. No skinny centered column with empty side margins. Inner padding and readable measure are fine; the page itself is full-bleed on phone and desktop.",
].join("\n");
