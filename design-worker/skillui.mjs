// SkillUI Ultra: the reference site's design, extracted.
//
// `skillui --url <reference> --mode ultra --screens 5 --format both` crawls the
// reference in Chromium (Playwright) and writes a `<name>-design` folder:
// SKILL.md, CLAUDE.md and DESIGN.md, the layout, component, interaction,
// animation and visual-guide references, the colour, spacing and type tokens,
// scroll, page and section screenshots, and the whole of it packaged as a
// `.skill` zip. The five screens match Forge's five-page rule.
//
// Forge keeps the `.skill` package itself (it is uploaded to Convex and stays
// with the site), and hands the builders two things made from it:
// the extract -- the package's own text, cut to fit a turn -- and the
// foundation, its tokens as CSS custom properties for every page's <head>.
// Nothing here is a judgement: a run that did not produce the ultra outputs
// fails, and the build never goes ahead on a design a model made up.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { MAX_PAGES } from "./discover.mjs";

export const SCREENS = MAX_PAGES;
const REFERENCES = ["LAYOUT.md", "COMPONENTS.md", "INTERACTIONS.md", "ANIMATIONS.md", "VISUAL_GUIDE.md"];
// How much of each part of the package the extract carries. The whole of it
// rides in every builder's turn, so it is cut to what a turn
// can hold with room for the brief and the page.
const BUDGET = {
  skill: 20000,
  "DESIGN.md": 15000,
  "LAYOUT.md": 14000,
  "COMPONENTS.md": 14000,
  "INTERACTIONS.md": 7000,
  "ANIMATIONS.md": 5000,
  "VISUAL_GUIDE.md": 3000,
  tokens: 6000,
};
export const EXTRACT_LIMIT = 90000;

const ansi = (text) => String(text).replace(/\x1b\[[0-9;]*m/g, "");

// Runs the CLI in its own temporary home, so its copy of the skill for Claude
// Code never lands anywhere that outlives the job. Nothing here times it: a
// crawl runs for as long as it takes, and stops early only when `signal` says
// the job is gone -- the request it answers was closed.
export async function runSkillUI(url, out, name, { emit = () => {}, bin = path.join(process.cwd(), "node_modules", ".bin", "skillui"), signal } = {}) {
  if (signal?.aborted) throw new Error("The design research request was closed before SkillUI Ultra started");
  emit("skillui", { mode: "ultra", screens: SCREENS });
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "skillui-home-"));
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(bin, ["--url", url, "--mode", "ultra", "--screens", String(SCREENS), "--format", "both", "--name", name, "--out", out], {
        env: { ...process.env, HOME: home },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let tail = "";
      let closed = false;
      for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { tail = (tail + chunk).slice(-4000); });
      const stop = () => {
        closed = true;
        child.kill("SIGKILL");
      };
      signal?.addEventListener("abort", stop, { once: true });
      child.on("error", (error) => {
        signal?.removeEventListener("abort", stop);
        reject(error);
      });
      child.on("close", (code) => {
        signal?.removeEventListener("abort", stop);
        const said = ansi(tail);
        if (closed) reject(new Error("The design research request was closed, so SkillUI Ultra was stopped"));
        // Without Playwright SkillUI carries on in its static mode and says
        // so; that is not an ultra extraction.
        else if (code === 0 && /Playwright not (?:installed|found)|without ultra features/i.test(said)) {
          reject(new Error("SkillUI Ultra could not start Chromium, so the design was not extracted"));
        } else if (code === 0) resolve();
        else reject(new Error(`SkillUI Ultra failed (${code ?? "stopped"}): ${said.replace(/\s+/g, " ").trim().slice(-300)}`));
      });
    });
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
  return await readPackage(out);
}

const readText = (file) => fs.readFile(file, "utf8").catch(() => "");
function parseJson(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

// The package SkillUI wrote under `out`, read back. It fails unless the ultra
// outputs are all there: the skill, the design tokens, the layout reference,
// at least one captured page, and the `.skill` archive itself.
export async function readPackage(out) {
  const folders = (await fs.readdir(out, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isDirectory() && entry.name.endsWith("-design"));
  let skillDir = null;
  for (const folder of folders) {
    const candidate = path.join(out, folder.name);
    if ((await readText(path.join(candidate, "SKILL.md"))).trim()) {
      skillDir = candidate;
      break;
    }
  }
  if (!skillDir) throw new Error("SkillUI Ultra wrote no design package");
  const read = (relative) => readText(path.join(skillDir, relative));
  const pkg = {
    skillDir,
    skillMd: await read("SKILL.md"),
    claudeMd: await read("CLAUDE.md"),
    designMd: (await read("references/DESIGN.md")) || (await read("DESIGN.md")),
    refs: Object.fromEntries(await Promise.all(REFERENCES.map(async (name) => [name, await read(`references/${name}`)]))),
    tokens: {
      colors: parseJson(await read("tokens/colors.json")),
      spacing: parseJson(await read("tokens/spacing.json")),
      typography: parseJson(await read("tokens/typography.json")),
    },
    screens: (await fs.readdir(path.join(skillDir, "screens", "pages")).catch(() => [])).filter((name) => /\.(png|jpe?g|webp)$/i.test(name)).length,
    skillFile: null,
  };
  const archive = (await fs.readdir(skillDir)).find((name) => name.endsWith(".skill"));
  pkg.skillFile = archive ? path.join(skillDir, archive) : null;
  const missing = [
    !pkg.designMd.trim() && "DESIGN.md",
    !pkg.refs["LAYOUT.md"].trim() && "LAYOUT.md",
    !pkg.screens && "page screenshots",
    !pkg.skillFile && "the .skill package",
  ].filter(Boolean);
  if (missing.length) throw new Error(`SkillUI Ultra produced no usable design reference (missing ${missing.join(", ")})`);
  return pkg;
}

// A line naming a font from anywhere but Fontshare, or a bundled font file:
// DESIGN_GOD's Type section chooses the families, so none of these reach a
// builder.
const FOREIGN_FONT = /^.*(?:fonts\.googleapis\.com|fonts\.gstatic\.com|google ?fonts|\.woff2?\b|fonts\/[^\s)]+\.(?:ttf|otf)).*$/gim;
// Screenshots are files in the package; a turn cannot open them, so their
// image embeds are left out and their captions kept.
const IMAGE = /!\[([^\]]*)\]\([^)]*\)/g;

function tidy(text, limit) {
  const clean = String(text).replace(FOREIGN_FONT, "").replace(IMAGE, "[$1]").replace(/\n{3,}/g, "\n\n").trim();
  return clean.length > limit ? `${clean.slice(0, limit)}\n[… cut to fit]` : clean;
}

// The extract every builder reads: what the reference decides and
// what it does not, the pages the discovery agent chose, and the package's
// own text. SKILL.md embeds its references again at the end; that copy is
// left off, since each reference follows on its own.
export function extractPrompt({ source, routes, pkg }) {
  const skill = pkg.skillMd.split(/\n#\s+Full Reference Files\b/)[0];
  const tokens = JSON.stringify({ colors: pkg.tokens.colors, spacing: pkg.tokens.spacing?.scale ?? null, typography: pkg.tokens.typography?.scale ?? null });
  const parts = [
    `SKILLUI ULTRA DESIGN REFERENCE: ${source}`,
    `Extracted by SkillUI in ultra mode, ${pkg.screens} ${pkg.screens === 1 ? "screen" : "screens"}: the reference site's tokens, type, spacing, components, layout, interactions and motion, screen by screen. Every page is built to it.`,
    "",
    "WHAT IT DECIDES",
    "- The design: on every page, the order and composition of the sections, the header and its menu, the footer, and their layout, spacing, sizes, type scale, colours, surfaces, components, states and motion, at phone and desktop widths.",
    "- Where FORGE_MD or DESIGN_GOD leaves a choice open -- how a new page is designed, the palette, the layout, the nav's shape -- this reference makes it.",
    "",
    "WHAT IT DOES NOT DECIDE",
    "- The words, the pictures, the logo, the business's name and the font families. Write every word from the brief, ask for every picture through forge-image at the aspect of the reference's image slot, and never link to, load or copy anything from the reference's host.",
    "- DESIGN_GOD's Type, Icons, Anti-slop and floor rules win over it: type comes from Fontshare, icons from Phosphor or Lucide, a light surface is #ffffff.",
    "",
    `PAGES: the page discovery agent chose these, and the site has exactly these, home first: ${routes.map((route) => route.path).join(", ")}.`,
    ...routes.map((route) => `- ${route.path}: the reference's ${route.url}`),
    "",
    "SKILL.md",
    tidy(skill, BUDGET.skill),
    "",
    "DESIGN.md",
    tidy(pkg.designMd, BUDGET["DESIGN.md"]),
    ...REFERENCES.flatMap((name) => (pkg.refs[name]?.trim() ? ["", name, tidy(pkg.refs[name], BUDGET[name])] : [])),
    "",
    "TOKENS",
    tidy(tokens, BUDGET.tokens),
  ];
  const text = parts.join("\n");
  return text.length > EXTRACT_LIMIT ? `${text.slice(0, EXTRACT_LIMIT)}\n[… cut to fit]` : text;
}

// ---------------------------------------------------------------------------
// The foundation: the tokens as CSS custom properties
// ---------------------------------------------------------------------------

const SAFE_VALUE = /^[#a-z0-9.,%()\s/-]+$/i;
const COLOUR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$|^(?:rgb|rgba|hsl|hsla)\([0-9.,%\s/]+\)$/i;
const slug = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);

function luminance(hex) {
  const value = hex.replace("#", "");
  const full = value.length <= 4 ? value.slice(0, 3).split("").map((c) => c + c).join("") : value.slice(0, 6);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// DESIGN_GOD: a light surface is #ffffff, never a cream or a warm grey.
function surface(value) {
  return /^#[0-9a-f]{3,8}$/i.test(value) && luminance(value) > 0.8 ? "#ffffff" : value;
}

const ROLES = {
  background: "--color-background",
  surface: "--color-surface",
  "text-primary": "--color-text",
  "text-muted": "--color-text-muted",
  accent: "--color-accent",
  border: "--color-border",
};

export function foundationCss({ source, tokens }) {
  const declared = [];
  const add = (name, value) => {
    const text = String(value ?? "").trim();
    if (text && SAFE_VALUE.test(text) && !declared.some(([other]) => other === name)) declared.push([name, text]);
  };
  const colours = tokens?.colors ?? {};
  for (const [role, name] of Object.entries(ROLES)) {
    const value = colours.core?.[role]?.value;
    if (typeof value === "string" && COLOUR.test(value.trim())) add(name, role === "background" || role === "surface" ? surface(value.trim()) : value.trim());
  }
  for (const [key, token] of Object.entries(colours.status ?? {})) {
    if (typeof token?.value === "string" && COLOUR.test(token.value.trim())) add(`--color-${slug(key)}`, token.value.trim());
  }
  // SkillUI names a colour it could not name after its hex, as color-313131.
  for (const [key, token] of Object.entries(colours.extended ?? {}).slice(0, 12)) {
    const name = slug(key).replace(/^color-/, "");
    if (typeof token?.value === "string" && COLOUR.test(token.value.trim()) && name) add(`--color-${name}`, token.value.trim());
  }
  const spacing = tokens?.spacing ?? {};
  if (typeof spacing.base?.value === "string") add("--space-base", spacing.base.value);
  for (const [key, step] of Object.entries(spacing.scale ?? {})) {
    if (typeof step?.value === "string") add(`--space-${slug(key)}`, step.value);
  }
  for (const [role, style] of Object.entries(tokens?.typography?.scale ?? {}).slice(0, 12)) {
    const name = slug(role);
    if (!name) continue;
    add(`--text-${name}`, style?.fontSize);
    add(`--weight-${name}`, style?.fontWeight);
    add(`--leading-${name}`, style?.lineHeight);
  }
  if (!declared.length) return "";
  return [
    `/* SkillUI Ultra tokens from ${String(source).replace(/\*\//g, "")}. Light surfaces are #ffffff (DESIGN_GOD). */`,
    ":root{",
    ...declared.map(([name, value]) => `  ${name}:${value};`),
    "}",
  ].join("\n");
}
