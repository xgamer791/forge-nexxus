// @vitest-environment node
// The prompt stack the building agent reads. These live outside convex/ so the
// Convex test glob never tries to load a module that reads the filesystem.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { FORGE_MD } from "../convex/forgeMd";
import { FRONTEND_DESIGN } from "../convex/frontendDesign";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const generate = read("convex/generate.ts");
const onboarding = read("convex/onboarding.ts");
// What the build turn actually sends: forge.md, the design skill, and the
// build contract inside systemPrompt().
const contract = generate.slice(
  generate.indexOf("You are Forge, the website-building agent"),
  generate.indexOf("Never ask the user questions or append"),
);

describe("the embedded prompts match their source files", () => {
  // Convex cannot read the filesystem, so these markdown files are embedded as
  // strings. Editing one and not the other ships a prompt nobody reviewed.
  test("forge.md and the frontend-design skill are embedded verbatim", () => {
    expect(contract.length).toBeGreaterThan(500);
    expect(FORGE_MD).toBe(read("forge.md"));
    expect(FRONTEND_DESIGN).toBe(read("frontend-design.md"));
  });
});

describe("one instruction, in one place", () => {
  const stack = `${FORGE_MD}\n${FRONTEND_DESIGN}\n${contract}`;

  // Every character here is read before the brief on every build, by a model
  // with a finite budget for instructions. forge.md used to restate the design
  // skill for 300 lines, which crowded out the site it was meant to produce.
  test("the stack stays small enough to leave room for the site", () => {
    expect(stack.length).toBeLessThan(24000);
  });

  // The build contract, the house rules and the skill each said something
  // different about typefaces, and the contract's "Google Fonts are the only
  // external stylesheet" made forge.md's Fontshare defaults unloadable.
  test("type is decided once: one family, from either permitted host", () => {
    expect(FORGE_MD).toContain("One typeface for the entire build");
    expect(contract).toContain("one typeface for the whole site");
    expect(stack).not.toMatch(/at most two (Google Fonts )?families/i);
    expect(contract).toContain("Google Fonts and Fontshare are the only external stylesheets");
    for (const face of ["Satoshi", "Switzer"]) expect(FORGE_MD).toContain(face);
  });

  // A member who says they sell products was given a brochure: the brief asked
  // for a shop and three separate instructions refused to build one.
  test("the site covers the job the brief names, including selling", () => {
    expect(FORGE_MD).toContain("What the site must cover");
    expect(FORGE_MD).toContain("a products section is required");
    expect(contract).toContain("A business that sells products gets a products section");
    expect(onboarding).toContain("Build a section for every job the brief says the site has to do");
    // The blanket refusals that outranked the brief.
    expect(stack).not.toMatch(/do not imply that bookings, payments, accounts or form delivery work/i);
    expect(stack).not.toMatch(/Do not imply unconnected commerce/i);
    expect(onboarding).not.toMatch(/Do not imply unconnected commerce/i);
  });

  // Honest, though: the storefront is built, the checkout is not faked.
  test("what is not wired up is never shown as working", () => {
    expect(contract).toContain("Never render a cart, a checkout, a payment form");
    expect(FORGE_MD).toContain("Never invent a price");
  });
});
