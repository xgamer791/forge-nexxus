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
const onboardingQuestions = read("convex/onboardingQuestions.ts");
const images = read("convex/images.ts");
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

  test("type lives in DESIGN_GOD, and every family comes from Fontshare", () => {
    expect(DESIGN_GOD).toContain("## Type");
    expect(DESIGN_GOD).toContain("https://www.fontshare.com/");
    expect(DESIGN_GOD).toContain("Google Fonts and every other source are not permitted");
    expect(DESIGN_GOD).toContain("Satoshi and Switzer are good starting points, not requirements");
    expect(DESIGN_GOD).toContain("the Type section");
    expect(DESIGN_GOD).not.toContain("One typeface for the entire build");
    expect(DESIGN_GOD).not.toContain("Fontshare and Google Fonts are both available");
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

  test("commerce, accounts, forms and integrations are unrestricted", () => {
    expect(contract).toContain("carts, checkout, payments, bookings, authentication and form submission");
    expect(onboardingQuestions).toContain("Build every feature and integration the brief calls for");
    for (const source of [generate, onboarding, onboardingQuestions]) {
      expect(source).not.toMatch(/Never render a cart|Do not pretend payments|Never invent (?:business facts|missing business facts)|SAFETY —/i);
    }
  });

  test("every requested picture is attempted without a build or edit cap", () => {
    expect(generate).toContain("There is no per-build or per-edit image limit");
    expect(generate).not.toMatch(/BUILD_IMAGE_LIMIT|EDIT_IMAGE_LIMIT|imageLimit/);
    expect(images).not.toMatch(/index\s*<\s*limit/);
  });
});

describe("the brief collects what a shop needs", () => {
  test("the last question asks for the catalogue without limiting generated pricing", async () => {
    const { QUESTIONS, FINAL_STEP } = await import("../convex/onboardingQuestions");
    const catalogue = QUESTIONS[FINAL_STEP];
    expect(catalogue.id).toBe("catalogue");
    expect(catalogue.title).toBe("What do you sell, and what does it cost?");
    expect(FINAL_STEP).toBe(QUESTIONS.length - 1);
    expect(QUESTIONS[0].id).toBe("name");
    expect(QUESTIONS[1].id).toBe("offer");
    expect(QUESTIONS[9].id).toBe("content");
    expect(catalogue.hint).toContain("Add prices or any other details you want featured");
  });

  test("no step index is hardcoded", () => {
    const client = read("docs/onboarding.js");
    expect(read("convex/onboarding.ts")).not.toMatch(/step [!=]== 9|, 9\)/);
    expect(client).not.toMatch(/step [!=]== 9/);
    expect(client).toContain("lastStep()");
  });
});

describe("the preview runs the generated site without iframe restrictions", () => {
  test("both app surfaces omit the sandbox attribute", () => {
    for (const path of ["docs/index.html", "wordpress/page-app.php"]) {
      const surface = read(path);
      expect(surface).toContain('data-preview-frame referrerpolicy="no-referrer"');
      expect(surface).not.toMatch(/data-preview-frame[^>]*\bsandbox=/);
    }
  });
});

describe("nothing claims to know which model is running", () => {
  test("house rules name no model or vendor", () => {
    expect(houseRulesOnly).not.toMatch(/deepseek|gemini|openai|anthropic|\bGPT\b|\bClaude\b|nano banana/i);
  });

  test("the contract reads the label off the turn's own route", () => {
    expect(contract).toContain("this turn runs on ${chatRoute(purpose).label}");
    expect(contract).not.toMatch(/\$\{chatRoute\(\)\.label\}/);
    expect(generate).toContain('function systemPrompt(purpose: "chat" | "build")');
  });

  test("a custom domain is not promised to every paid member", () => {
    expect(contract).toContain("not every plan carries");
    expect(contract).not.toMatch(/Paid users .*may connect their own custom domain/);
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
    expect(DESIGN_GOD).toContain("Let the content decide the shape");
    expect(FORGE_MD).toContain("Nothing here prescribes an opening, a layout, a palette or a type treatment");
  });

  test("the quality floor is still stated outright, where design and behaviour live", () => {
    // Design instruction is DESIGN_GOD's, behaviour is FORGE_MD's, and the
    // contract keeps neither: it says what this platform can store and serve.
    expect(DESIGN_GOD).toContain("Semantic landmarks");
    expect(DESIGN_GOD).toContain("it is accessible");
    expect(DESIGN_GOD).toContain("design the narrow layout first");
    expect(FORGE_MD).toContain("What every page owes, whatever shape it takes");
    expect(contract).not.toContain("Semantic landmarks");
  });

  test("navigation is designed, and DESIGN_GOD is where that is said", () => {
    expect(DESIGN_GOD).toContain("## Navigation");
    expect(DESIGN_GOD).toContain("a bar with the name on the left and links on the right is one answer, not the answer");
    expect(DESIGN_GOD).toContain("at least 44px");
  });

  test("the reply can still name cloned header, menu and footer originals", () => {
    // The reply format that carries the declaration is the contract's to say.
    expect(contract).toContain("then a \\`\\`\\`clones block, then the shell");
    expect(contract).toContain("Header: Site name, https://its-address");
    expect(contract).toContain("Dropdown menu: Site name, https://its-address");
    expect(contract).toContain("Footer: Site name, https://its-address");
    expect(DESIGN_GOD).not.toContain("https://www.awwwards.com/");
    expect(DESIGN_GOD).not.toContain("## Header, menu and footer");
  });

  test("every icon, including a hamburger, comes from Phosphor or Lucide", () => {
    expect(DESIGN_GOD).toContain("## Icons");
    expect(DESIGN_GOD).toContain("https://phosphoricons.com/");
    expect(DESIGN_GOD).toContain("https://lucide.dev/icons/");
    expect(DESIGN_GOD).toContain("That includes a hamburger menu");
    expect(DESIGN_GOD).toContain("the Icons section");
  });

  test("a phone menu is not locked to a checkbox or the word Menu", () => {
    expect(DESIGN_GOD).toContain("JavaScript is available, so the menu is not a checkbox and it does not have to say Menu.");
    expect(DESIGN_GOD).not.toMatch(/runs no scripts/);
    expect(DESIGN_GOD).not.toContain("a Menu button that opens a dropdown is the reliable default below 768px wide");
    expect(DESIGN_GOD).not.toContain('<input class="nav-toggle" type="checkbox" id="nav-toggle">');
    expect(DESIGN_GOD).not.toContain('<label class="nav-button" for="nav-toggle">');
    expect(DESIGN_GOD).not.toContain(".nav-toggle:checked ~ .site-nav{display:block}");
    expect(DESIGN_GOD).not.toContain("better not fixed or sticky");
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

  test("forgeMd leaves visual design to the design sources", () => {
    expect(FORGE_MD).toContain("Nothing here decides how anything looks");
    expect(FORGE_MD).toContain("Nothing here prescribes an opening, a layout, a palette or a type treatment");
  });
});
