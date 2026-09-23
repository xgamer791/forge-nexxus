/// <reference types="vite/client" />
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, test } from "vitest";

// Design direction belongs to FORGE_MD and the files it carries. Everything
// else that reaches the model is a platform contract: the reply format, what
// can be stored and served, the image markers, and the mechanics of a retry.
//
// This is how `rebuildDesign.ts` grew from a duplicate check into the thing
// that decided how every rebuilt page looked, and how a sentence about layout
// ended up in the strategist. A new prompt in a new file now fails here rather
// than quietly becoming another voice in the build.
const here = new URL("./", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, here), "utf8");
const modules = readdirSync(new URL(".", here))
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts"));

// Who may *write* a system message, and what each one is allowed to be for.
// `forgeMd.ts` is not here: it writes nothing, it supplies the text these
// three wrap, which is what makes it the single place design lives.
const WRITERS = {
  "generate.ts": "the platform contract: reply format, shell and pages, what a published page can run, image markers",
  "onboarding.ts": "build/retry mechanics and the saved brief",
  "memory.ts": "what Forge remembers, carried as untrusted content",
};

describe("only the sanctioned files steer the agent", () => {
  test("no module outside the allowed set writes a system message", () => {
    const writers = modules.filter((name) => /role:\s*"system"/.test(read(name)));
    expect(writers.sort()).toEqual(Object.keys(WRITERS).sort());
  });

  test("the design direction is carried from the three files and nowhere else", () => {
    expect(read("forgeMd.ts")).toMatch(/export const FORGE_MD =/);
    expect(read("designgod.ts")).toMatch(/export const DESIGN_GOD =/);
    expect(read("fed.ts")).toMatch(/export const FED =/);
    // Both build paths hand the model all three and no other design source.
    for (const name of ["generate.ts", "onboarding.ts"]) {
      const src = read(name);
      expect(src).toMatch(/import \{ FORGE_MD \} from "\.\/forgeMd"/);
      expect(src).toMatch(/import \{ DESIGN_GOD \} from "\.\/designgod"/);
      expect(src).toMatch(/import \{ FED \} from "\.\/fed"/);
    }
  });

  test("all three reach every text turn, the rebuild included", () => {
    const generate = read("generate.ts");
    // buildMessages is what a thread turn and beginOnboarding (onboarding and
    // rebuild alike) both assemble, so carrying them here carries them to all.
    const assembled = generate.slice(generate.indexOf("function buildMessages"));
    for (const name of ["FORGE_MD", "DESIGN_GOD", "FED"]) {
      expect(assembled).toMatch(new RegExp(`role: "system", content: ${name}`));
    }
    expect((generate.match(/buildMessages\(/g) ?? []).length).toBeGreaterThanOrEqual(3);
    // The strategist runs before a rebuild and gets the same direction.
    const strategist = read("onboarding.ts");
    const call = strategist.slice(strategist.indexOf("private website strategist") - 600);
    for (const name of ["FORGE_MD", "DESIGN_GOD", "FED"]) {
      expect(call).toContain(`content: ${name}`);
    }
  });

  test("fed.ts is the frontend-design skill verbatim, not a paraphrase of it", () => {
    const fed = read("fed.ts");
    // One statement, no commentary: the skill is carried, never edited.
    expect(fed.startsWith("export const FED = `")).toBe(true);
    expect(fed.trimEnd().endsWith("`;")).toBe(true);
    expect(fed).toContain("name: frontend-design");
  });

  test("the build contract stays a contract, not a design brief", () => {
    const generate = read("generate.ts");
    const contract = generate.slice(
      generate.indexOf("function systemPrompt"),
      generate.indexOf("// What the thread shows while the request runs"),
    );
    // Room for the format, the platform constraints, the image markers and the
    // address/plan behaviour; not for a second opinion on how a page should
    // look.
    expect(contract.length).toBeLessThan(6000);
    // Words that decide appearance rather than describe the platform. Each one
    // was in this function before the design files took the job back.
    for (const word of [
      "palette", "typeface", "hierarchy", "skeleton", "mobile-first",
      "landmarks", "lorem ipsum", "spacing", "corner treatment", "art direction",
    ]) {
      expect(contract.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });

  test("nothing tells the strategist to avoid page structure", () => {
    expect(read("onboarding.ts")).not.toMatch(/say nothing about page structure/i);
  });

  test("the deleted rebuild art direction has not come back", () => {
    expect(modules).not.toContain("rebuildDesign.ts");
    for (const name of modules) {
      expect(read(name)).not.toMatch(/REBUILD ART DIRECTION/);
    }
  });

  test("forgeMd.ts holds what a site is made of, and stays that short", () => {
    const forge = read("forgeMd.ts");
    // What a site is made of: a rebuild is a new design, and a link into the
    // site is a page. Both are structure, which is this file's to say; how any
    // of it looks is the design files'.
    expect(forge).toMatch(/Rebuild means a different design/);
    expect(forge).toMatch(/Every link into the site is its own page/);
    // Behaviour is this file's: what a site is made of, and what a page has to
    // cover whatever shape the design gives it.
    expect(forge).toMatch(/What every page owes, whatever shape it takes/);
    // It carried the whole design skill once. If it grows back past a few
    // rules, design has two homes again and they will disagree. The room here
    // is for behaviour; design instruction belongs in designgod.ts.
    const text = forge.slice(forge.indexOf('FORGE_MD = "'));
    expect(text.length).toBeLessThan(1900);
    // It may name a palette or a type treatment only to say not to carry one
    // forward, which is behaviour. What it must never do is choose one.
    for (const instruction of ["Satoshi", "clamp(", "custom properties", "Mobile-first"]) {
      expect(forge).not.toContain(instruction);
    }
  });

  test("memory never becomes a fourth design voice", () => {
    const memory = read("memory.ts");
    // What the reflection is told to keep. Aesthetics belong to the design
    // files; a memory carrying them would outlive and contradict them.
    expect(memory).toMatch(/Never keep how a site should look/);
    for (const word of ["colours, fonts, tone", "no stock photos"]) {
      expect(memory).not.toContain(word);
    }
    // And the note the model reads says the same thing from the other side.
    expect(memory).toMatch(/never for how a site should look/);
  });
});
