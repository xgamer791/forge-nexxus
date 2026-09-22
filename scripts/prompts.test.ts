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
    // The contract does not restate the type rule: design instruction has one
    // home, and repeating it there is how two homes start disagreeing.
    expect(contract).not.toContain("Satoshi or Switzer");
    expect(stack).not.toMatch(/at most two (Google Fonts )?families/i);
  });

  test("layout and color live in DESIGN_GOD: no cards, no accent text, full width", () => {
    expect(DESIGN_GOD).toContain("No card-style layouts");
    expect(DESIGN_GOD).toContain("No accent color on text");
    expect(DESIGN_GOD).toContain("Always use full page width layouts");
    expect(DESIGN_GOD).toContain("even a SaaS brief does not get the card kit");
    expect(FED).not.toContain("No card-style layouts");
    expect(FORGE_MD).not.toContain("No card-style layouts");
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
    expect(DESIGN_GOD).toContain("Never pair two families");
    expect(DESIGN_GOD).toContain("Where this file and FED disagree, follow this file");
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
    expect(DESIGN_GOD).toContain("Mobile-first and responsive from 320px");
    expect(DESIGN_GOD).toContain("a nav that stays usable on a phone without JavaScript");
    expect(FORGE_MD).toContain("What every page owes, whatever shape it takes");
    expect(contract).not.toContain("Mobile-first and responsive from 320px");
  });

  test("navigation is designed, and DESIGN_GOD is where that is said", () => {
    expect(DESIGN_GOD).toContain("## Navigation");
    expect(DESIGN_GOD).toContain("A bar with the name on the left and links on the right is one answer, not the answer");
    expect(DESIGN_GOD).toContain("at least 44px");
  });

  test("a phone always gets a header bar and a Menu dropdown, never the desktop row", () => {
    // Every build came back with the wide nav wrapped onto a phone, because
    // the floor said to "let it wrap or scroll sideways" and a dropdown was
    // only owed past however many links the agent decided a row could carry.
    expect(DESIGN_GOD).toContain("On a phone: a header bar and a Menu button, on every build");
    expect(DESIGN_GOD).toContain("However few links there are, they never show as a row on a phone");
    expect(DESIGN_GOD).not.toMatch(/wrap or scroll sideways/);
    expect(DESIGN_GOD).not.toMatch(/More links than a phone can carry/);
    // The phone nav has to work without a script, because a published site
    // runs none: one checkbox and its label, phone-first, revealed wide.
    expect(DESIGN_GOD).toContain('<input class="nav-toggle" type="checkbox" id="nav-toggle">');
    expect(DESIGN_GOD).toContain('<label class="nav-button" for="nav-toggle">');
    expect(DESIGN_GOD).toContain(".nav-toggle:checked ~ .site-nav{display:block}");
    expect(DESIGN_GOD).toContain("@media (min-width:768px)");
    // Nothing can close the menu after a tap, so it must scroll away.
    expect(DESIGN_GOD).toContain("On a phone the header is neither fixed nor sticky");
  });

  test("the phone floor names what a phone layout has to hold", () => {
    expect(DESIGN_GOD).toContain("Nothing scrolls sideways");
    expect(DESIGN_GOD).toContain("Text and controls keep 16–24px from the edge of the screen");
    expect(DESIGN_GOD).toContain("Every split, grid and row of columns becomes one column");
    expect(DESIGN_GOD).toContain("Body text is 16–18px and never smaller");
  });

  test("the palette is taken from the business, not from a ban list", () => {
    expect(DESIGN_GOD).toContain("## Colour");
    expect(DESIGN_GOD).toContain("Take the palette from the business");
    expect(DESIGN_GOD).toContain("Decide light or dark from the subject");
    expect(DESIGN_GOD).toContain("Two sites on the same family must not read the same");
    // FED names the default looks. DESIGN_GOD says what to do with that list,
    // rather than FED being edited to remove it.
    expect(DESIGN_GOD).toContain("never a menu to choose from");
    expect(FED).toContain("warm cream background");
  });

  test("forgeMd gives the skeleton to the skill", () => {
    expect(FORGE_MD).toContain("the skeleton is the skill's to invent for this business");
    expect(FORGE_MD).not.toMatch(/decide those two things/);
  });
});
