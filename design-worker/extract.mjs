// SkillUI Ultra extract. The design system is whatever the CLI writes —
// CLAUDE.md, SKILL.md, DESIGN.md and the token files. Nothing here invents a
// token, a color or a component.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { MAX_PAGES } from "./discover.mjs";

export const FORMAT = "skillui-ultra-v1";
export const SKILLUI_SCREENS = MAX_PAGES;

const FILE_CAP = 80000;

function cap(text) {
  const value = String(text ?? "");
  return value.length > FILE_CAP ? `${value.slice(0, FILE_CAP)}\n\n[truncated]` : value;
}

async function readText(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return "";
  }
}

async function findRoot(dir) {
  const pending = [dir];
  while (pending.length) {
    const current = pending.shift();
    const names = await fs.readdir(current, { withFileTypes: true });
    if (names.some((entry) => entry.isFile() && entry.name === "CLAUDE.md")) return current;
    for (const entry of names) {
      if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== "fonts") pending.push(path.join(current, entry.name));
    }
  }
  return null;
}

async function readTokens(root) {
  const tokens = {};
  for (const name of ["colors", "spacing", "typography"]) {
    const file = path.join(root, "tokens", `${name}.json`);
    try {
      tokens[name] = JSON.parse(await fs.readFile(file, "utf8"));
    } catch {
      tokens[name] = null;
    }
  }
  return tokens;
}

// Reads a SkillUI output folder. Fails closed when the three documents the
// build is supposed to consume are not there.
export async function readExtract(dir) {
  const root = await findRoot(dir);
  if (!root) throw new Error("SkillUI Ultra did not write CLAUDE.md");
  const claude = await readText(path.join(root, "CLAUDE.md"));
  const skill = await readText(path.join(root, "SKILL.md"));
  const design = await readText(path.join(root, "DESIGN.md"));
  if (!claude.trim() || !skill.trim() || !design.trim()) {
    throw new Error("SkillUI Ultra did not write CLAUDE.md, SKILL.md and DESIGN.md");
  }
  return { root, claude, skill, design, tokens: await readTokens(root) };
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`SkillUI Ultra failed (${code}): ${stderr.trim().slice(0, 300) || "no output"}`));
    });
  });
}

// `skillui --url <ref> --mode ultra --screens 5 --format both`. Screens never
// go above the five-page cap. The CLI's own Chromium is separate from the
// discovery browser, which the caller closes first.
export async function runSkillui(url, outDir, { screens = SKILLUI_SCREENS } = {}) {
  const count = Math.min(Math.max(Number(screens) || SKILLUI_SCREENS, 1), SKILLUI_SCREENS);
  await fs.mkdir(outDir, { recursive: true });
  await run("skillui", [
    "--url", url,
    "--mode", "ultra",
    "--screens", String(count),
    "--format", "both",
    "--out", outDir,
    "--name", "reference",
  ], outDir);
  return readExtract(outDir);
}

export function assemblePrompt(extract, routes) {
  const paths = routes.map((route) => route.path);
  const lines = [
    "SKILLUI ULTRA DESIGN EXTRACT",
    "This design system was extracted by SkillUI Ultra. Use it. Do not invent colors, type sizes, spacing, components or layout that the extract does not contain.",
    "Words and photographs are original: write every word from the brief and ask for pictures with forge-image. Never link to or copy an asset from the reference host.",
    "DESIGN_GOD still chooses the font families from Fontshare. Sizes, weights and the rest of the extract's type scale still apply.",
    "",
    "PAGE CREW",
    "Each page is built on its own, by this crew, and is not complete until every auditor agrees it matches this extract:",
    "- Header: 1 build agent and 1 real-time auditor.",
    "- Body: 2 build agents and 2 real-time auditors.",
    "- Footer: 1 build agent and 1 real-time auditor.",
    "Write a header, a body and a footer on every page. A page the auditors do not agree on is not saved.",
    "",
    `ROUTES: build exactly these pages and no others: ${paths.join(", ")}. At most ${MAX_PAGES}.`,
    "",
    "CLAUDE.md",
    cap(extract.claude),
    "",
    "SKILL.md",
    cap(extract.skill),
    "",
    "DESIGN.md",
    cap(extract.design),
    "",
    "TOKENS",
    cap(JSON.stringify(extract.tokens ?? {}, null, 2)),
  ];
  for (const route of routes) {
    lines.push("", `ROUTE ${route.path}`, "Match the SkillUI Ultra extract above for this page. Do not add a page the discovery list does not have.");
  }
  return lines.join("\n");
}

export function referencePackage(extract, routes, source) {
  return {
    format: FORMAT,
    source,
    capturedAt: new Date().toISOString(),
    screens: SKILLUI_SCREENS,
    routes: routes.map((route) => ({ path: route.path, url: route.url })),
    claude: cap(extract.claude),
    skill: cap(extract.skill),
    design: cap(extract.design),
    tokens: extract.tokens ?? {},
    crew: {
      header: { builders: 1, auditors: 1 },
      body: { builders: 2, auditors: 2 },
      footer: { builders: 1, auditors: 1 },
    },
  };
}
