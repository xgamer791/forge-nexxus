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
  "generate.ts": "the platform contract: reply format, one document, no JavaScript, image markers",
  "onboarding.ts": "build/retry mechanics and the saved brief",
  "memory.ts": "what Forge remembers, carried as untrusted content",
};

describe("only the sanctioned files steer the agent", () => {
  test("no module outside the allowed set writes a system message", () => {
    const writers = modules.filter((name) => /role:\s*"system"/.test(read(name)));
    expect(writers.sort()).toEqual(Object.keys(WRITERS).sort());
  });

  test("the design direction is carried from forgeMd.ts, not written anywhere else", () => {
    expect(read("forgeMd.ts")).toMatch(/export const FORGE_MD =/);
    // Both build paths hand the model that file and no other design source.
    for (const name of ["generate.ts", "onboarding.ts"]) {
      expect(read(name)).toMatch(/import \{ FORGE_MD \} from "\.\/forgeMd"/);
    }
  });

  test("the build contract stays a contract, not a design brief", () => {
    const generate = read("generate.ts");
    const contract = generate.slice(
      generate.indexOf("function systemPrompt"),
      generate.indexOf("// What the thread shows while the request runs"),
    );
    // Room for the format, the platform constraints, the image markers and the
    // two guardrails that are not design (addresses/plans, safety); not for a
    // second opinion on how a page should look.
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

  test("forgeMd.ts holds the rebuild rule and no other direction", () => {
    const forge = read("forgeMd.ts");
    expect(forge).toMatch(/Rebuild means a different design/);
    // It carried the whole design skill once. If it grows back past a rule,
    // design has two homes again and they will disagree.
    const text = forge.slice(forge.indexOf('FORGE_MD = "'));
    expect(text.length).toBeLessThan(1500);
  });
});
