// How the crew's builders are recognised and answered in tests. CI never
// calls a live model.
import { PARTS, type PartName } from "./crew";

export const DESIGN_FOUNDATION = ":root{--color-ink:#1d1a16;--color-paper:#ffffff;--color-accent:#b4441b;--space-1:8px;--space-2:16px;--radius-1:6px}";

export type CrewCall = { role: "builder"; part: PartName; path: string; round: number; messages: { role: string; content: string }[] };

// Which builder of a crew a chat request is from, or null for any other turn.
export function crewCall(body: unknown): CrewCall | null {
  const messages = (body as { messages?: { role: string; content: string }[] })?.messages;
  if (!Array.isArray(messages) || !messages.length) return null;
  const text = (role: string) => messages.filter((m) => m.role === role).map((m) => String(m.content)).join("\n");
  const system = text("system");
  const crew = system.match(/This turn is page \d+ of \d+: (\S+)\./);
  if (!crew || !/written one page at a time by a crew/.test(system)) return null;
  const ask = messages.filter((m) => m.role === "user").map((m) => String(m.content)).find((content) => /You are the /.test(content)) ?? "";
  const part = ask.match(/part="(header|body1|body2|footer)"/)?.[1] as PartName | undefined;
  if (!part) return null;
  const round = messages.filter((m) => m.role === "assistant").length;
  return { role: "builder", part, path: crew[1], round, messages };
}

export const PART_PICTURE =
  '<img src="forge-image:1" data-forge-image="Morning light across the roastery counter, sacks of green coffee in the background" ' +
  'data-forge-aspect="16:9" alt="The roastery counter" width="1600" height="900">';

// A part as a well-behaved builder writes it. `label` marks which build a page
// came from, so a rebuild can be told from the first.
export function partMarkup(call: Pick<CrewCall, "part" | "path">, label = "first") {
  const slug = call.path === "/" ? "home" : call.path.slice(1).replace(/[^a-z0-9]+/g, "-");
  switch (call.part) {
    case "header":
      return `<link rel="stylesheet" href="https://api.fontshare.com/v2/css?f[]=switzer@400,600&display=swap">` +
        `<meta name="description" content="Coffee roasted on the pier">` +
        `<style>:root{--font-display:'Switzer',system-ui,sans-serif}.site-header{display:flex;padding:var(--space-2)}</style>` +
        `<header class="site-header"><a href="/" class="hd-brand">Harbor Roasters</a><nav><a href="/">Home</a></nav></header>`;
    case "footer":
      return `<style>.site-footer{padding:var(--space-2)}</style><footer class="site-footer"><p>Harbor Roasters, Port Ellen pier</p></footer>`;
    case "body1":
      return `<style>.a-open{min-height:80svh}</style><section class="a-open"><h1>${label} ${slug}</h1>${PART_PICTURE}</section>`;
    case "body2":
      return `<style>.b-more{padding:var(--space-2)}</style><section class="b-more"><h2>More about ${slug}</h2><p>The ${label} ${slug} page.</p></section>`;
  }
}

// A builder's whole reply: the sentence, then the part in its block.
export function partReply(call: Pick<CrewCall, "part" | "path">, label = "first") {
  const title = call.part === "body1" ? ` title="${call.path === "/" ? "Harbor Roasters" : call.path.slice(1)}"` : "";
  return `Built the ${call.part}.\n\n\`\`\`html part="${call.part}"${title}\n${partMarkup(call, label)}\n\`\`\``;
}

// Every crew builder a page gets, in order, for tests that check the layout.
export const CREW_PARTS: readonly PartName[] = PARTS;
