// @vitest-environment node
// The prompt stack the building agent reads. These live outside convex/ so the
// Convex test glob never tries to load a module that reads the filesystem.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { DESIGN_GOD } from "../convex/designgod";
import { FED } from "../convex/fed";
import { FORGE_MD } from "../convex/forgeMd";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const generate = read("convex/generate.ts");
const onboarding = read("convex/onboarding.ts");
// What the build turn actually sends: the three prompt files and the
// build contract inside systemPrompt().
const contract = generate.slice(
  generate.indexOf("You are Forge, the website-building agent"),
  generate.indexOf("Never ask the user questions or append"),
);
const stack = `${FORGE_MD}\n${DESIGN_GOD}\n${FED}\n${contract}`;
const houseRulesOnly = FORGE_MD.slice(0, FORGE_MD.indexOf("## Design quality (mandatory)"));

describe("the agent reads three prompt files on every text turn", () => {
  test("house rules, custom design and FED are wired together", () => {
    expect(contract.length).toBeGreaterThan(500);
    expect(FORGE_MD).toContain("standing instructions for the website agent");
    expect(FORGE_MD).toContain("All design work must follow FED and DESIGN_GOD");
    expect(FED).toContain("Approach this as the design lead at a design studio");
    expect(DESIGN_GOD).toContain("# Design God — custom design requirements");
    expect(generate).toContain("content: FORGE_MD");
    expect(generate).toContain("content: DESIGN_GOD");
    expect(generate).toContain("content: FED");
    expect(onboarding).toContain("content: FORGE_MD");
    expect(onboarding).toContain("content: DESIGN_GOD");
    expect(onboarding).toContain("content: FED");
    expect(generate).not.toMatch(/FRONTEND_DESIGN/);
    expect(generate).not.toMatch(/frontendDesign/);
  });
});

describe("one instruction, in one place", () => {
  test("the stack stays small enough to leave room for the site", () => {
    expect(stack.length).toBeLessThan(35000);
  });

  test("type lives in DESIGN_GOD: Satoshi or Switzer from Fontshare", () => {
    expect(DESIGN_GOD).toContain("One typeface for the entire build");
    expect(DESIGN_GOD).toContain("Use **Satoshi** or **Switzer** from Fontshare only");
    expect(DESIGN_GOD).toContain("https://www.fontshare.com/fonts/satoshi");
    expect(DESIGN_GOD).toContain("https://www.fontshare.com/fonts/switzer");
    expect(DESIGN_GOD).toContain("No more than one font per site");
    expect(FORGE_MD).not.toMatch(/There is no preferred family/);
    expect(FORGE_MD).not.toMatch(/Fontshare and Google Fonts are both available/);
    expect(FORGE_MD).not.toContain("https://www.fontshare.com/fonts/satoshi");
    expect(FED).not.toContain("https://www.fontshare.com/fonts/satoshi");
    expect(contract).toContain("one typeface for the whole site");
    expect(contract).toContain("Satoshi or Switzer");
    expect(stack).not.toMatch(/at most two (Google Fonts )?families/i);
  });

  test("the site covers the job the brief names, including selling", () => {
    expect(FORGE_MD).toContain("What the site must cover");
    expect(FORGE_MD).toContain("a products section is required");
    expect(contract).toContain("A business that sells products gets a products section");
    expect(onboarding).toContain("Build a section for every job the brief says the site has to do");
    expect(stack).not.toMatch(/do not imply that bookings, payments, accounts or form delivery work/i);
    expect(stack).not.toMatch(/Do not imply unconnected commerce/i);
    expect(onboarding).not.toMatch(/Do not imply unconnected commerce/i);
  });

  test("what is not wired up is never shown as working", () => {
    expect(contract).toContain("Never render a cart, a checkout, a payment form");
    expect(FORGE_MD).toContain("Never invent a price");
  });
});

describe("the brief collects what a shop needs", () => {
  test("the last question asks for the catalogue, and prices come only from it", async () => {
    const { QUESTIONS, FINAL_STEP } = await import("../convex/onboardingQuestions");
    const catalogue = QUESTIONS[FINAL_STEP];
    expect(catalogue.id).toBe("catalogue");
    expect(catalogue.title).toBe("What do you sell, and what does it cost?");
    expect(FINAL_STEP).toBe(QUESTIONS.length - 1);
    expect(QUESTIONS[0].id).toBe("name");
    expect(QUESTIONS[1].id).toBe("offer");
    expect(QUESTIONS[9].id).toBe("content");
    expect(FORGE_MD).toContain("What do you sell, and what does it cost?");
  });

  test("no step index is hardcoded", () => {
    const client = read("docs/onboarding.js");
    expect(read("convex/onboarding.ts")).not.toMatch(/step [!=]== 9|, 9\)/);
    expect(client).not.toMatch(/step [!=]== 9/);
    expect(client).toContain("lastStep()");
  });
});

describe("nothing claims to know which model is running", () => {
  test("house rules name no model or vendor", () => {
    expect(houseRulesOnly).not.toMatch(/deepseek|gemini|openai|anthropic|\bGPT\b|\bClaude\b|nano banana/i);
  });

  test("the contract reads the label off the turn's own route", () => {
    expect(contract).toContain("this turn runs on ${chatRoute(purpose).label}");
    expect(contract).not.toMatch(/\$\{chatRoute\(\)\.label\}/);
    expect(generate).toContain('function systemPrompt(imageLimit: number, purpose: "chat" | "build")');
  });

  test("a custom domain is not promised to every paid member", () => {
    expect(FORGE_MD).toContain("not every paid plan carries");
    expect(FORGE_MD).not.toMatch(/Paid users .*may connect their own custom domain/);
  });
});

describe("FED fits the reply Forge is allowed to give", () => {
  test("it never invites a question, a narrated plan, or a memory Forge lacks", () => {
    expect(FED).not.toMatch(/confirm with the client|as a proposal/i);
    expect(FED).not.toMatch(/say what you changed and why/i);
    expect(FED).not.toMatch(/information in your memory|jot down notes/i);
    expect(FED).toContain("you never put the question to the member");
    expect(FED).toContain("Do this silently");
  });

  test("it does not offer a typeface pairing DESIGN_GOD forbids", () => {
    expect(FED).not.toMatch(/use one family or two/i);
    expect(FED).toContain("Forge uses one family for the whole site");
  });

  test("the vendored frontend-design skill has no Forge Fonts addendum", () => {
    const skill = read(".claude/skills/frontend-design/SKILL.md");
    expect(skill).toContain("use one family or two");
    expect(skill).toContain("Let each written element do exactly one job.");
    expect(skill).not.toContain("## Fonts");
    expect(skill).not.toContain("https://www.fontshare.com/fonts/satoshi");
  });
});

describe("the contract sets a floor, not a mould", () => {
  test("no fixed running order survives in the build rules", () => {
    expect(contract).not.toMatch(/a header with the name and a nav/i);
    expect(contract).not.toMatch(/appears in the hero, again after the offer/i);
    expect(contract).not.toMatch(/then a closing call to action/i);
    expect(contract).toContain("The page's shape is yours to decide from this business");
    expect(contract).toContain("Two businesses must not come out with the same skeleton");
  });

  test("the quality floor is still stated outright", () => {
    expect(contract).toContain("What every page owes, whatever shape it takes");
    expect(contract).toContain("Semantic landmarks");
    expect(contract).toContain("Mobile-first and responsive from 320px");
    expect(contract).toContain("Cover every job the brief says the site has to do");
    expect(contract).toContain("a products section");
  });

  test("forgeMd gives the skeleton to the skill", () => {
    expect(FORGE_MD).toContain("the skeleton is the skill's to invent for this business");
    expect(FORGE_MD).not.toMatch(/decide those two things/);
  });
});
