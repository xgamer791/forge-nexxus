// @vitest-environment node
// The prompt stack the building agent reads. These live outside convex/ so the
// Convex test glob never tries to load a module that reads the filesystem.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { FED, FORGE_MD } from "../convex/agentRules";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const generate = read("convex/generate.ts");
const onboarding = read("convex/onboarding.ts");
const officialSkill = read(".claude/skills/frontend-design/SKILL.md");
// What the build turn actually sends: FORGE_MD (house rules), FED (official
// frontend-design skill), and the build contract inside systemPrompt().
const contract = generate.slice(
  generate.indexOf("You are Forge, the website-building agent"),
  generate.indexOf("Never ask the user questions or append"),
);
const stack = `${FORGE_MD}\n${FED}\n${contract}`;

describe("FORGE_MD and FED always travel together", () => {
  test("FED is the official frontend-design skill, verbatim", () => {
    expect(FED).toBe(officialSkill);
  });

  test("house rules live in FORGE_MD and the official skill lives in FED", () => {
    expect(contract.length).toBeGreaterThan(500);
    expect(FORGE_MD).toContain("standing instructions for the website agent");
    expect(FORGE_MD).not.toContain("All design work must follow the frontend-design skill");
    expect(FORGE_MD).not.toContain("Approach this as the design lead at a design studio");
    expect(FORGE_MD).not.toMatch(/frontend-design skill/i);
    expect(FED).toContain("Approach this as the design lead at a design studio");
    expect(generate).toContain("standingSystemMessages()");
    expect(generate).not.toMatch(/content: FORGE_MD/);
    expect(generate).not.toMatch(/FRONTEND_DESIGN/);
    expect(generate).not.toMatch(/frontendDesign/);
    expect(onboarding).toContain("standingSystemMessages()");
    expect(onboarding).not.toMatch(/content: FORGE_MD/);
    expect(generate).not.toMatch(/from \"\.\/forgeMd\"/);
    expect(generate).not.toMatch(/from \"\.\/fed\"/);
    expect(onboarding).not.toMatch(/from \"\.\/forgeMd\"/);
    expect(onboarding).not.toMatch(/from \"\.\/fed\"/);
  });
});

describe("one instruction, in one place", () => {
  test("the stack stays small enough to leave room for the site", () => {
    expect(stack.length).toBeLessThan(35000);
  });

  test("type is decided in the contract, not in FORGE_MD", () => {
    expect(FORGE_MD).not.toContain("One typeface for the entire build");
    expect(FORGE_MD).not.toMatch(/typeface|typography|Fontshare/i);
    expect(contract).toContain("one typeface for the whole site");
    expect(stack).not.toMatch(/at most two (Google Fonts )?families/i);
    expect(contract).toContain("Google Fonts and Fontshare are the only external stylesheets");
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
    expect(FORGE_MD).not.toMatch(/deepseek|gemini|openai|anthropic|\bGPT\b|\bClaude\b|nano banana/i);
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

describe("FORGE_MD carries no design-method rules", () => {
  test("the rewritten frontend-design skill is gone", () => {
    expect(FORGE_MD).not.toMatch(/confirm with the client|as a proposal/i);
    expect(FORGE_MD).not.toMatch(/say what you changed and why/i);
    expect(FORGE_MD).not.toMatch(/information in your memory|jot down notes/i);
    expect(FORGE_MD).not.toContain("you never put the question to the member");
    expect(FORGE_MD).not.toContain("Do this silently");
    expect(FORGE_MD).not.toMatch(/use one family or two/i);
    expect(FORGE_MD).not.toContain("Forge uses one family for the whole site");
    expect(FORGE_MD).not.toContain("## Design quality");
    expect(FORGE_MD).not.toContain("# Frontend Design");
  });

  test("a rebuild must still look new when the answers stay the same", () => {
    expect(FORGE_MD).toContain("Rebuild means a different design");
    expect(FORGE_MD).toContain("The same business facts do not require the same visual answer");
    expect(FORGE_MD).toContain("A rebuild rejects the preceding design, not the onboarding answers");
    expect(FORGE_MD).toContain("Do not reproduce a familiar site kit");
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
});
