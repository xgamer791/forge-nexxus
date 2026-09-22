// ——— TEMPORARY: FED only ————————————————————————————————————————————
// While the owner tests how the agent works on its own, it is sent two things
// and nothing else Forge wrote: FED, the frontend-design skill, and the
// onboarding answers (the questions and what the member said), beside the
// member's own words in the thread.
//
// Held back, not deleted (grep `fed-only block`): FORGE_MD, DESIGN_GOD, the
// platform contract, the one-page note, memory, the current site on an edit,
// the TALK note, the brief's builder instructions and strategy, the
// strategist, the onboarding and rebuild orders, and every retry and
// continuation nudge. The server still refuses a build a member cannot afford.
//
// To lift it: `npx convex env set AGENT_DIRECTION on`, which needs no deploy.
// To remove it: delete this file and the blocks that call it.
export function fedOnly() {
  return process.env.AGENT_DIRECTION?.trim().toLowerCase() !== "on";
}
// ——— end fed-only block ————————————————————————————————————————————
