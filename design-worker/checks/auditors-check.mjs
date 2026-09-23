import { test } from "node:test";
import assert from "node:assert/strict";
import { auditPage, auditSite, colorTokens } from "../auditors.mjs";
import { chooseRoutes, MAX_PAGES } from "../discover.mjs";
import { assemblePrompt, FORMAT, SKILLUI_SCREENS } from "../extract.mjs";

const extract = {
  format: FORMAT,
  source: "https://harbor.example/",
  design: "Primary #112233. Header, sections, footer.",
  claude: "Use the extracted tokens.",
  skill: "Match the reference.",
  tokens: { colors: { ink: "#112233" } },
  routes: [{ path: "/" }, { path: "/menu" }],
};

const page = (extra = "") =>
  `<header><nav><a href="/menu">Menu</a></nav></header><main><section><h1>Harbor</h1>${extra}</section></main><footer><p>Harbor</p></footer>`;

test("discovery keeps the home page and at most five routes", () => {
  const links = ["/menu", "/about", "/visit", "/events", "/private", "/sixth", "/privacy", "https://other.example/nope"];
  const routes = chooseRoutes("https://harbor.example/", links.map((href) => new URL(href, "https://harbor.example/").href));
  assert.equal(routes[0].path, "/");
  assert.equal(routes.length, MAX_PAGES);
  assert.equal(routes.at(-1).path, "/events");
  assert.equal(routes.some((route) => route.path === "/private"), false);
  assert.equal(routes.some((route) => route.path === "/sixth"), false);
  assert.equal(routes.some((route) => route.path === "/privacy"), false);
});

test("SkillUI ultra is capped at five screens and the prompt quotes the extract", () => {
  assert.equal(SKILLUI_SCREENS, 5);
  const prompt = assemblePrompt(extract, [{ path: "/" }, { path: "/menu" }]);
  expectIncludes(prompt, "CLAUDE.md");
  expectIncludes(prompt, "Primary #112233");
  expectIncludes(prompt, "1 build agent and 1 real-time auditor");
  expectIncludes(prompt, "2 build agents and 2 real-time auditors");
  expectIncludes(prompt, "ROUTE /menu");
});

test("a page is complete only when header, both body auditors and the footer agree", () => {
  const agreed = auditPage(extract, { path: "/", html: page('<p style="color:#112233">Tonight</p>') });
  assert.equal(agreed.agreed, true);
  assert.equal(agreed.crew.header.builders, 1);
  assert.equal(agreed.crew.header.auditors.length, 1);
  assert.equal(agreed.crew.body.builders, 2);
  assert.equal(agreed.crew.body.auditors.length, 2);
  assert.equal(agreed.crew.footer.auditors.length, 1);

  const offToken = auditPage(extract, { path: "/", html: page("<p>No token</p>") });
  assert.equal(offToken.agreed, false);
  assert.equal(offToken.crew.body.auditors[0].agree, true);
  assert.equal(offToken.crew.body.auditors[1].agree, false);

  const noFooter = auditPage(extract, { path: "/", html: page('<p style="color:#112233">x</p>').replace(/<footer[\s\S]*<\/footer>/, "") });
  assert.equal(noFooter.agreed, false);
  assert.equal(noFooter.crew.footer.auditors[0].agree, false);
});

test("audits one page at a time and refuses a sixth page or a page that was not discovered", () => {
  const html = page('<p style="color:#112233">Tonight</p>');
  const one = auditSite(extract, [{ path: "/", html }]);
  assert.equal(one.passed, true);
  const stranger = auditSite(extract, [{ path: "/secret", html }]);
  assert.equal(stranger.passed, false);
  const six = auditSite(extract, Array.from({ length: 6 }, () => ({ path: "/", html })));
  assert.equal(six.passed, false);
  assert.match(six.fixes[0], /at most 5/);
});

test("an extract with no color tokens cannot pass the body auditors", () => {
  assert.deepEqual(colorTokens({ design: "no colors here", tokens: {} }), []);
  const bare = auditPage({ ...extract, design: "No colors here.", tokens: {} }, { path: "/", html: page() });
  assert.equal(bare.crew.body.auditors[1].agree, false);
});

function expectIncludes(text, needle) {
  assert.equal(text.includes(needle), true, needle);
}
