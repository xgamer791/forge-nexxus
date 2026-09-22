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
    expect(FORGE_MD).toContain("standing rules for the website agent");
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

  test("type lives in DESIGN_GOD, as guidance: Satoshi and Switzer are a start, not a rule", () => {
    expect(DESIGN_GOD).toContain("## Type");
    expect(DESIGN_GOD).toContain("Fontshare and Google Fonts are both available");
    expect(DESIGN_GOD).toContain("Satoshi and Switzer from Fontshare are good starting points, not requirements");
    expect(DESIGN_GOD).not.toContain("One typeface for the entire build");
    expect(DESIGN_GOD).not.toContain("from Fontshare only");
    expect(FORGE_MD).not.toContain("https://www.fontshare.com/fonts/satoshi");
    // The contract does not restate type: design instruction has one home.
    expect(contract).not.toContain("Satoshi");
  });

  test("layout lives in DESIGN_GOD, and the content decides its shape", () => {
    expect(DESIGN_GOD).toContain("## Layout");
    expect(DESIGN_GOD).toContain("Let the content decide the shape");
    for (const ban of ["No card-style layouts", "No accent color on text", "Always use full page width layouts"]) {
      expect(DESIGN_GOD).not.toContain(ban);
    }
    expect(FORGE_MD).not.toMatch(/\bcards?\b/);
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

describe("FED is the frontend-design skill, and is never edited", () => {
  // FED used to be edited to fit Forge — a line removed here, a Forge
  // sentence added there — and every edit was a fork of a file that keeps
  // being updated upstream. It is carried verbatim now. Where it says
  // something Forge does differently, DESIGN_GOD says so and wins, which is
  // the only place that override belongs.
  test("it is byte-for-byte the vendored skill", () => {
    const skill = read(".claude/skills/frontend-design/SKILL.md");
    const template = read("convex/fed.ts").match(/export const FED = `([\s\S]*)`;\s*$/);
    expect(template).not.toBeNull();
    const carried = template![1].replace(/\\`/g, "`").replace(/\\\$\{/g, "${");
    expect(carried.trim()).toBe(skill.trim());
  });

  test("what Forge does differently is said in DESIGN_GOD, not edited into FED", () => {
    // The skill offers a typeface pairing and names the looks AI design falls
    // into. Both stay in it; DESIGN_GOD is what overrides them.
    expect(FED).toMatch(/use one family or two/i);
    expect(DESIGN_GOD).toContain("One family is often enough; two works when they are clearly different");
    // Anti-slop is the part of DESIGN_GOD that outranks FED.
    expect(DESIGN_GOD).toContain("Where one of them and anything else you have been told disagree, including FED, this section wins");
    expect(DESIGN_GOD).toContain("never a menu to choose from");
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

  test("the quality floor is still stated outright, where design and behaviour live", () => {
    // Design instruction is DESIGN_GOD's, behaviour is FORGE_MD's, and the
    // contract keeps neither: it says what this platform can store and serve.
    expect(DESIGN_GOD).toContain("Semantic landmarks");
    expect(DESIGN_GOD).toContain("it can be navigated without a script");
    expect(DESIGN_GOD).toContain("design the narrow layout first");
    expect(FORGE_MD).toContain("What every page owes, whatever shape it takes");
    expect(contract).not.toContain("Semantic landmarks");
  });

  test("navigation is designed, and DESIGN_GOD is where that is said", () => {
    expect(DESIGN_GOD).toContain("## Navigation");
    expect(DESIGN_GOD).toContain("a bar with the name on the left and links on the right is one answer, not the answer");
    expect(DESIGN_GOD).toContain("at least 44px");
  });

  test("a phone menu works without a script, and the Menu dropdown is the default", () => {
    expect(DESIGN_GOD).toContain("A published site runs no scripts");
    expect(DESIGN_GOD).toContain("a Menu button that opens a dropdown is the reliable default below 768px wide");
    expect(DESIGN_GOD).not.toMatch(/wrap or scroll sideways/);
    // The checkbox pattern is kept as a working reference.
    expect(DESIGN_GOD).toContain('<input class="nav-toggle" type="checkbox" id="nav-toggle">');
    expect(DESIGN_GOD).toContain('<label class="nav-button" for="nav-toggle">');
    expect(DESIGN_GOD).toContain(".nav-toggle:checked ~ .site-nav{display:block}");
    expect(DESIGN_GOD).toContain("@media (min-width:768px)");
    expect(DESIGN_GOD).toContain("better not fixed or sticky");
  });

  test("the floor that makes a page work stays, and is not optional", () => {
    expect(DESIGN_GOD).toContain("These make a page work, and they are not optional");
    expect(DESIGN_GOD).toContain("Nothing scrolls sideways");
    expect(DESIGN_GOD).toContain("Body text is at least 16px");
    expect(DESIGN_GOD).toContain("It is accessible");
  });

  test("the palette is taken from the business, and a light page is white", () => {
    expect(DESIGN_GOD).toContain("## Colour");
    expect(DESIGN_GOD).toContain("Take the palette from the business");
    expect(DESIGN_GOD).toContain("Decide light or dark from the subject");
    expect(DESIGN_GOD).toContain("Two sites set in the same family should still not read the same");
    expect(DESIGN_GOD).toContain("never a menu to choose from");
    // The white rule is anti-slop, which stays strict.
    const antiSlop = DESIGN_GOD.slice(DESIGN_GOD.indexOf("## Anti-slop"), DESIGN_GOD.indexOf("## The floor every page meets"));
    expect(antiSlop).toContain("**Light means white.**");
    expect(antiSlop).toContain("**These are rules, not suggestions.**");
    expect(FED).toContain("warm cream background");
  });

  test("forgeMd gives the skeleton to the skill", () => {
    expect(FORGE_MD).toContain("the skeleton is the skill's to invent for this business");
    expect(FORGE_MD).not.toMatch(/decide those two things/);
  });
});
