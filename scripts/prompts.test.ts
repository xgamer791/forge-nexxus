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
  // with a finite budget for instructions. Design quality now inlines the
  // frontend-design skill (still also injected as FRONTEND_DESIGN).
  test("the stack stays small enough to leave room for the site", () => {
    expect(stack.length).toBeLessThan(33000);
  });

  // The build contract, the house rules and the skill each said something
  // different about typefaces, and the contract's "Google Fonts are the only
  // external stylesheet" made forge.md's Fontshare defaults unloadable.
  test("type is decided once: one family, from either permitted host", () => {
    expect(FORGE_MD).toContain("One typeface for the entire build");
    expect(contract).toContain("one typeface for the whole site");
    expect(stack).not.toMatch(/at most two (Google Fonts )?families/i);
    expect(contract).toContain("Google Fonts and Fontshare are the only external stylesheets");
  });

  // A member who says they sell products was given a brochure: the brief asked
  // for a shop and three separate instructions refused to build one.
  test("the site covers the job the brief names, including selling", () => {
    expect(FORGE_MD).toContain("What the site must cover");
    expect(FORGE_MD).toContain("a products section is required");
    expect(contract).toContain("A business that sells products gets a products section");
    expect(onboarding).toContain("Build a section for every job the brief says the site has to do");
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

describe("the brief collects what a shop needs", () => {
  // A products section cannot be built from nothing. The ten original
  // questions never asked what the business sells or what it costs, and the
  // agent is forbidden to invent either.
  test("the last question asks for the catalogue, and prices come only from it", async () => {
    const { QUESTIONS, FINAL_STEP } = await import("../convex/onboardingQuestions");
    const catalogue = QUESTIONS[FINAL_STEP];
    expect(catalogue.id).toBe("catalogue");
    expect(catalogue.title).toBe("What do you sell, and what does it cost?");
    expect(FINAL_STEP).toBe(QUESTIONS.length - 1);
    // Appended, never inserted: answers are stored by position, so moving an
    // existing question relabels every brief already saved.
    expect(QUESTIONS[0].id).toBe("name");
    expect(QUESTIONS[1].id).toBe("offer");
    expect(QUESTIONS[9].id).toBe("content");
    expect(FORGE_MD).toContain("What do you sell, and what does it cost?");
  });

  // Nine and ten were written into the flow in four places; adding a question
  // used to strand Build on the second-to-last one.
  test("no step index is hardcoded", () => {
    const client = read("docs/onboarding.js");
    expect(read("convex/onboarding.ts")).not.toMatch(/step [!=]== 9|, 9\)/);
    expect(client).not.toMatch(/step [!=]== 9/);
    expect(client).toContain("lastStep()");
  });
});

describe("nothing claims to know which model is running", () => {
  // The models are deployment settings: AI_MODEL, AI_BUILD_MODEL and
  // AI_IMAGE_MODEL all move them, and they have moved twice already. Each
  // time, a forge.md that named the old vendor left the agent under orders to
  // deny what it was while the build contract, in the same turn, named it
  // correctly. So forge.md names none of them and reads the label instead.
  test("forge.md names no model or vendor", () => {
    // Design quality inlines the frontend-design skill, which names Anthropic
    // and Claude as an aesthetic tell — not as the model on this turn.
    const houseRules = FORGE_MD.replace(
      /## Design quality \(mandatory\)[\s\S]*?(?=## Typography \(house rule\))/,
      "",
    );
    expect(houseRules).not.toMatch(/deepseek|gemini|openai|anthropic|\bGPT\b|\bClaude\b|nano banana/i);
  });

  // The contract interpolates the label instead, and for a build it has to be
  // the build model's — chatRoute() with no argument answers for chat.
  test("the contract reads the label off the turn's own route", () => {
    expect(contract).toContain("this turn runs on ${chatRoute(purpose).label}");
    expect(contract).not.toMatch(/\$\{chatRoute\(\)\.label\}/);
    expect(generate).toContain('function systemPrompt(imageLimit: number, purpose: "chat" | "build")');
  });

  // Starter publishes to a Forge address but carries no custom domains, so an
  // agent that promised one was promising an upgrade.
  test("a custom domain is not promised to every paid member", () => {
    expect(FORGE_MD).toContain("not every paid plan carries");
    expect(FORGE_MD).not.toMatch(/Paid users .*may connect their own custom domain/);
  });
});

describe("the injected skill fits the reply Forge is allowed to give", () => {
  const skill = read("frontend-design.md");

  // The skill was written for a designer in conversation with a client. Forge
  // may not ask the member anything and its reply is one sentence and a page,
  // so the sentences that invited a question or a narrated plan pulled against
  // forge.md and BUILD_ORDER on every single turn.
  test("it never invites a question, a narrated plan, or a memory Forge lacks", () => {
    expect(skill).not.toMatch(/confirm with the client|as a proposal/i);
    expect(skill).not.toMatch(/say what you changed and why/i);
    expect(skill).not.toMatch(/information in your memory|jot down notes/i);
    expect(skill).toContain("you never put the question to the member");
    expect(skill).toContain("Do this silently");
  });

  // Type is the house rule's, so the skill no longer offers a second family.
  test("it does not offer a typeface pairing the house rule forbids", () => {
    expect(skill).not.toMatch(/use one family or two/i);
    expect(skill).toContain("Forge uses one family for the whole site");
  });
});

describe("the contract sets a floor, not a mould", () => {
  // Every Forge site came out with the same bones — header, nav, hero saying
  // what/who/one-action, sections, closing CTA, footer, the same CTA words
  // three times — because the contract dictated that running order and, by
  // forge.md's own precedence, outranked the skill it was injected beside.
  // Swapping the model changed the prose inside the boxes and nothing else.
  test("no fixed running order survives in the build rules", () => {
    expect(contract).not.toMatch(/a header with the name and a nav/i);
    expect(contract).not.toMatch(/appears in the hero, again after the offer/i);
    expect(contract).not.toMatch(/then a closing call to action/i);
    expect(contract).toContain("The page's shape is yours to decide from this business");
    expect(contract).toContain("Two businesses must not come out with the same skeleton");
  });

  // The floor is the part that must not move: what a page owes whatever shape
  // the skill gives it.
  test("the quality floor is still stated outright", () => {
    expect(contract).toContain("What every page owes, whatever shape it takes");
    expect(contract).toContain("Semantic landmarks");
    expect(contract).toContain("Mobile-first and responsive from 320px");
    expect(contract).toContain("Cover every job the brief says the site has to do");
    expect(contract).toContain("a products section");
  });

  // And forge.md hands shape to the skill rather than keeping it.
  test("forge.md gives the skeleton to the skill", () => {
    expect(FORGE_MD).toContain("the skeleton is the skill's to invent for this business");
    expect(FORGE_MD).not.toMatch(/decide those two things/);
  });

  // The two files were once the same document, so the build turn spent ~5k
  // tokens saying the skill twice and the house rules it defers to — the
  // catalogue, one typeface, what the site must cover — were in neither.
  test("forge.md and the skill are two different documents", () => {
    expect(FORGE_MD).not.toBe(FRONTEND_DESIGN);
    expect(FORGE_MD).toContain("Approach this as the design lead at a design studio");
    expect(FRONTEND_DESIGN).toContain("Approach this as the design lead at a design studio");
    expect(FORGE_MD).toContain("Forge — standing instructions for the website agent");
  });
});
