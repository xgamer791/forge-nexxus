import type { Doc } from "./_generated/dataModel";

// A site is a shell and its pages. The shell is everything every page shares --
// the head, the whole stylesheet, the nav and the footer -- and it is written
// once per build; a page is only the markup between them. That split is what
// makes a second page cheap: on a measured build the shell was 60% of the
// document, so the pages after the first cost a fraction of the first one.
//
// These two markers are where the shell leaves room. A build that does not
// place them still serves -- see `spliceIntoShell` -- because a member's site
// going blank is a worse answer than a page in a slightly wrong frame.
export const BODY_MARKER = "<!--forge-page-->";
export const TITLE_MARKER = "<!--forge-title-->";

// What a stored page and a served address have to agree on. A visitor types
// `/About/`, a nav links `/about.html` and the model stored `/about`; all three
// name one page, and this is what makes them the same string.
//
// Null is a path that names nothing rather than a path we do not have: a `..`
// segment, or an escape that is not valid UTF-8. The caller turns that into the
// same 404 an unknown page gets, so a crafted address learns nothing from being
// refused differently.
export function normalizePath(raw: string | null | undefined): string | null {
  let path = (raw ?? "/").trim();
  if (!path) return "/";
  try {
    path = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (!path.startsWith("/")) path = `/${path}`;
  path = path.toLowerCase().replace(/\/+/g, "/");
  // `/about/`, `/about.html` and `/about/index.html` are all `/about`, the way
  // they would be on any static host. `/index.html` is the home page.
  path = path.replace(/\/index\.html$/, "/").replace(/\.html$/, "");
  if (path.length > 1) path = path.replace(/\/+$/, "");
  if (!path || path === "/") return "/";
  if (path.split("/").some((segment) => segment === "." || segment === "..")) return null;
  return path;
}

// Only the fields a page is built from, so this stays usable on a version that
// has been read for something else and on a fixture in a test.
type VersionPages = Pick<Doc<"siteVersions">, "html" | "shell" | "pages">;

// The document served at one address, or null when the site has no page there.
//
// A version saved before pages existed holds one document and no shell. That
// document is the home page and the site has no others, which is exactly what
// it served before this function existed.
export function composePage(
  version: VersionPages,
  rawPath: string | null | undefined,
): string | null {
  const path = normalizePath(rawPath);
  if (path === null) return null;
  const { shell, pages } = version;
  if (shell && pages?.length) {
    const page = pages.find((candidate) => normalizePath(candidate.path) === path);
    return page ? spliceIntoShell(shell, page) : null;
  }
  // A version from before pages existed is one document and no shell, and that
  // document is the whole site. Every address on such a site already served it:
  // the route took the slug and dropped the rest, so `/sites/<slug>/anything`
  // answered with the home page. That stays true here, so no site published
  // before pages existed answers differently after them.
  //
  // A site that does have pages is a different matter: it knows which
  // addresses it has, and the ones it does not have are nothing.
  return version.html ?? null;
}

// The title sits inside the shell's own <title>, so it is text there and not
// markup. A page called `Bread & Butter` must not close the element early.
function escapeTitle(title: string) {
  return title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function spliceIntoShell(shell: string, page: { title: string; body: string }) {
  // The page's title replaces whatever the shell's <title> holds, marker or
  // not, so a model that wrote the business name there and named each page
  // in its fence still gets a title per page. A page with no title of its own
  // leaves the shell's alone.
  const titled = shell.includes(TITLE_MARKER)
    ? shell.split(TITLE_MARKER).join(escapeTitle(page.title))
    : page.title
      ? shell.replace(/<title>[\s\S]*?<\/title>/i, () => `<title>${escapeTitle(page.title)}</title>`)
      : shell;
  if (titled.includes(BODY_MARKER)) return titled.split(BODY_MARKER).join(page.body);
  // A shell that came back without its marker has a head, a nav and a footer
  // and nowhere named for the page. Serving the frame alone would show the
  // member an empty site and report success; the end of the body is where the
  // markup goes instead.
  return /<\/body>/i.test(titled)
    ? titled.replace(/<\/body>/i, `${page.body}</body>`)
    : titled + page.body;
}

// Everything a version's design is made of, as one string: the shell every
// page shares, then each page in address order so the same site hashes the
// same way whatever order the model listed its pages in. A version from
// before pages existed is its one document.
//
// The title is left out on purpose. A rebuild that keeps the layout and
// rewrites the headings is the same design, and `designHash` exists to say so.
export function designSource(version: VersionPages) {
  const { shell, pages } = version;
  if (shell && pages?.length) {
    const ordered = [...pages].sort((a, b) => a.path.localeCompare(b.path));
    return [shell, ...ordered.map((page) => `${page.path}\n${page.body}`)].join("\n");
  }
  return version.html ?? "";
}

// The most pages a new build or a rebuild writes. The page discovery agent
// proposes no more than this, SkillUI Ultra extracts no more screens than
// this, and a build is planned to it whatever a design package says.
export const MAX_PAGES = 5;

// The pages a design reference asks for, as the addresses a build stores:
// each once, the home page first, the rest in the order they were discovered,
// and never more than MAX_PAGES. An address that cannot be served names no
// page, so it is left out. Every build is written a page at a time
// (buildDraft.ts).
export function pagePlan(routes: readonly string[] | undefined): string[] {
  const plan: string[] = [];
  for (const route of routes ?? []) {
    const path = normalizePath(route);
    if (path !== null && !plan.includes(path)) plan.push(path);
  }
  return ["/", ...plan.filter((path) => path !== "/")].slice(0, MAX_PAGES);
}

// One page of a build, before it is stored.
export type SitePage = { path: string; title: string; body: string };

// What a build produced: either the one document builds made before pages
// existed, or a shell and the pages that go in it.
export type BuiltSite = { html?: string; shell?: string; pages?: SitePage[] };

export function hasPages(site: BuiltSite): site is BuiltSite & { shell: string; pages: SitePage[] } {
  return Boolean(site.shell && site.pages?.length);
}

// The markup a build is made of, as flat strings. Pictures are asked for in
// markup, and a picture asked for in the shell belongs to every page, so the
// whole site is fulfilled in one pass rather than page by page: a repeated
// tag costs one picture, not one per page.
export function siteParts(site: BuiltSite): string[] {
  if (hasPages(site)) return [site.shell, ...site.pages.map((page) => page.body)];
  return site.html === undefined ? [] : [site.html];
}

// The same site with those strings put back, in the order `siteParts` gave
// them out. A count that does not match means the caller changed the shape
// rather than the markup, which is a bug here and not a build to store.
export function withParts(site: BuiltSite, parts: string[]): BuiltSite {
  if (hasPages(site)) {
    if (parts.length !== site.pages.length + 1) throw new Error("Site parts do not match the site");
    const [shell, ...bodies] = parts;
    return { shell, pages: site.pages.map((page, index) => ({ ...page, body: bodies[index] })) };
  }
  if (parts.length !== (site.html === undefined ? 0 : 1)) throw new Error("Site parts do not match the site");
  return { html: parts[0] };
}

// The site as the model wrote it, to hand back on the turn that edits it. It
// is the same shape the reply is parsed from, so a model reading its own last
// answer sees what it wrote and can return the same thing changed.
export function serializeSite(site: BuiltSite): string | null {
  if (hasPages(site)) {
    const blocks = site.pages.map(
      (page) => `\`\`\`html path="${page.path}" title="${page.title.replace(/"/g, "'")}"\n${page.body}\n\`\`\``,
    );
    return [`\`\`\`html shell\n${site.shell}\n\`\`\``, ...blocks].join("\n\n");
  }
  return site.html ? `\`\`\`html\n${site.html}\n\`\`\`` : null;
}

// Every root-relative link in a page -- `href="/about"`, `href="/"`, never a
// protocol-relative `//host` -- rewritten by `target`, which is given the path
// alone and returns what should stand in its place; a query or fragment on the
// link is kept. A page's links between pages are written as paths because that
// is what its address serves; anywhere else the page goes, they need translating.
export function rewriteRootLinks(html: string, target: (path: string) => string) {
  return html.replace(/(\bhref\s*=\s*)(["'])(\/(?!\/)[^"']*)\2/gi, (_, lead: string, quote: string, value: string) => {
    const cut = value.search(/[?#]/);
    const path = cut === -1 ? value : value.slice(0, cut);
    const suffix = cut === -1 ? "" : value.slice(cut);
    return `${lead}${quote}${target(path)}${suffix}${quote}`;
  });
}

// The file a page becomes when the site is handed over as files: the home page
// is `index.html`, `/about` is `about.html`, `/shop/shirts` is `shop/shirts.html`.
export function fileNameFor(path: string) {
  const clean = normalizePath(path) ?? "/";
  return clean === "/" ? "index.html" : `${clean.slice(1)}.html`;
}

// The link from one of those files to another, relative to where the first one
// sits, so the pages still find each other opened straight from a folder.
export function relativeFileLink(from: string, to: string) {
  const fromDirs = from.split("/").slice(0, -1);
  const toParts = to.split("/");
  let shared = 0;
  while (shared < fromDirs.length && shared < toParts.length - 1 && fromDirs[shared] === toParts[shared]) shared += 1;
  const up = "../".repeat(fromDirs.length - shared);
  return `${up}${toParts.slice(shared).join("/")}`;
}

// A page's links, made to work from a folder on disk: each link to a page
// points at that page's file, relative to this one.
export function diskLinks(html: string, fromFile: string) {
  return rewriteRootLinks(html, (path) => relativeFileLink(fromFile, fileNameFor(path)));
}
