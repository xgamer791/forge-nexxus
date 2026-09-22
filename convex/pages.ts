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
  return path === "/" ? (version.html ?? null) : null;
}

// The title sits inside the shell's own <title>, so it is text there and not
// markup. A page called `Bread & Butter` must not close the element early.
function escapeTitle(title: string) {
  return title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function spliceIntoShell(shell: string, page: { title: string; body: string }) {
  const titled = shell.includes(TITLE_MARKER)
    ? shell.split(TITLE_MARKER).join(escapeTitle(page.title))
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
