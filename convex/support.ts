import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { publishedUrlFor } from "./sites";

// Build reports for Forge support. When a build fails -- or a reply stopped
// part way and the build recovered -- the building agent's log for that run is
// emailed to the support inbox as soon as the run ends, so a stall is looked at
// when it happens rather than when a member writes in.
//
// A report carries what the debugger kept: the ending, and every step of the
// run with where the reply had got to, what it had produced and what the
// provider said last. It also names the member and the site, because support
// is who follows up. It never carries a key, a prompt, the model's thinking or
// the page: none of those are in the log to begin with.
//
// Mail goes out through Resend, the provider sign-in links already use.
// `SUPPORT_EMAIL` changes where reports go, `SUPPORT_EMAIL_FROM` who they come
// from (falling back to the sign-in sender), and `SUPPORT_REPORTS=0` stops
// them. With no Resend key on the deployment nothing is queued at all.
export const SUPPORT_EMAIL = "support@forgenexxus.com";
const RESEND_URL = "https://api.resend.com/emails";
const DEFAULT_SENDER = "Forge Nexxus <onboarding@resend.dev>";

export function supportAddress() {
  return process.env.SUPPORT_EMAIL?.trim() || SUPPORT_EMAIL;
}
function resendKey() {
  return process.env.SUPPORT_RESEND_KEY?.trim() || process.env.AUTH_RESEND_KEY?.trim() || "";
}
function sender() {
  return process.env.SUPPORT_EMAIL_FROM?.trim() || process.env.AUTH_EMAIL_FROM?.trim() || DEFAULT_SENDER;
}
export function reportsOn() {
  return Boolean(resendKey()) && !/^(0|off|false|no)$/i.test(process.env.SUPPORT_REPORTS?.trim() ?? "");
}

// Which endings are worth a report: a build that failed for any reason the
// member did not choose, and any build -- failed, cancelled or finished -- in
// which a reply stopped on the way.
const MEMBER_ENDED = /cancelled|no longer active|discarded by rebuild/i;
const STOP_PHASES = new Set(["provider_stop", "provider_retry", "provider_resume", "watchdog"]);
export function wantsReport(run: { status: string; error?: string }, events: { phase: string }[]) {
  const stopped = events.some((event) => STOP_PHASES.has(event.phase));
  if (run.status === "failed") return stopped || !MEMBER_ENDED.test(run.error ?? "");
  return run.status === "complete" && stopped;
}

// Called as a run gets its ending. The report is sent from its own action, so
// a slow or refused email can never hold up or fail the build it describes.
export async function queueReport(ctx: MutationCtx, runId: Id<"buildRuns">) {
  if (!reportsOn()) return;
  const run = await ctx.db.get(runId);
  if (!run) return;
  const events = await ctx.db.query("buildEvents").withIndex("by_run", (q) => q.eq("runId", runId)).collect();
  if (!wantsReport(run, events)) return;
  await ctx.scheduler.runAfter(0, internal.support.sendReport, { runId });
}

// ——— The report ————————————————————————————————————————————————————————

const grouped = (count: number) => String(Math.round(count)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const seconds = (ms: number) => `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
const clock = (at: number) => `${new Date(at).toISOString().slice(0, 19).replace("T", " ")} UTC`;
function span(ms: number) {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  return minutes ? `${minutes}m ${String(total % 60).padStart(2, "0")}s` : `${total}s`;
}

// One event's detail as the fields a person debugging a stall reads, in the
// order they read them: where in the build it was, what the reply had got to,
// and what went wrong. Anything not set is left out.
export function describeDetail(detail: Doc<"buildEvents">["detail"]) {
  if (!detail) return "";
  const parts: string[] = [];
  if (detail.page && detail.total) parts.push(`page ${detail.page} of ${detail.total}${detail.path ? ` (${detail.path})` : ""}`);
  else if (detail.path) parts.push(`page ${detail.path}`);
  if (detail.part) parts.push(`part ${detail.part}`);
  if (detail.step) parts.push(`step ${detail.step}`);
  if (detail.stopReason) parts.push(`stopped: ${detail.stopReason}`);
  if (detail.streamPhase) parts.push(`phase ${detail.streamPhase}`);
  if (detail.reasoningChars) parts.push(`thinking ${grouped(detail.reasoningChars)} chars`);
  if (detail.replyChars) parts.push(`page ${grouped(detail.replyChars)} chars`);
  if (detail.htmlChars) parts.push(`html ${grouped(detail.htmlChars)} chars`);
  if (detail.firstTokenMs !== undefined) parts.push(`first token ${seconds(detail.firstTokenMs)}`);
  if (detail.firstContentMs !== undefined) parts.push(`page began ${seconds(detail.firstContentMs)}`);
  if (detail.sinceTokenMs !== undefined) parts.push(`last token ${seconds(detail.sinceTokenMs)} before`);
  if (detail.sinceEventMs !== undefined) parts.push(`last heard ${seconds(detail.sinceEventMs)} before`);
  if (detail.keepAlives) parts.push(`keep-alives ${detail.keepAlives}`);
  if (detail.loopRepeats) parts.push(`passage repeated ${detail.loopRepeats} times`);
  if (detail.durationMs !== undefined) parts.push(`took ${seconds(detail.durationMs)}`);
  if (detail.finishReason) parts.push(`finish ${detail.finishReason}`);
  if (detail.completionTokens !== undefined) {
    parts.push(`tokens ${grouped(detail.completionTokens)}${detail.reasoningTokens !== undefined ? ` (${grouped(detail.reasoningTokens)} thinking)` : ""}`);
  }
  if (detail.tokensAsked) parts.push(`ceiling ${grouped(detail.tokensAsked)}`);
  if (detail.httpStatus) parts.push(`HTTP ${detail.httpStatus}`);
  if (detail.imageWanted !== undefined) parts.push(`pictures ${detail.imageMade ?? 0}/${detail.imageWanted}`);
  if (detail.attempt) parts.push(`try ${detail.attempt + 1}`);
  if (detail.continuation) parts.push(`continuation ${detail.continuation}`);
  if (detail.errorClass) parts.push(`class ${detail.errorClass}`);
  if (detail.providerError) parts.push(`provider said "${detail.providerError}"`);
  if (detail.reason) parts.push(`why: "${detail.reason}"`);
  return parts.join(", ");
}

type Logged = Pick<Doc<"buildEvents">, "at" | "phase" | "level" | "label" | "detail">;

// Which agent a line of the log is from. A crew builder names itself at the
// start of its lines ("Header builder: calling the model"), and so did the
// retired design auditors; a crew line about a part is its builder's; any
// other model call is the build's one agent. Everything else is the build's
// own bookkeeping, and no agent's.
const BUILDERS: Record<string, string> = {
  header: "Header builder",
  body1: "Top-half builder",
  body2: "Bottom-half builder",
  footer: "Footer builder",
};
export function agentOf(event: Pick<Logged, "label" | "phase" | "detail">) {
  const named = event.label.match(/^([A-Z][\w-]* (?:builder|auditor))\b/)?.[1];
  if (named) return named;
  if (event.phase.startsWith("crew_") && event.detail?.part && BUILDERS[event.detail.part]) return BUILDERS[event.detail.part];
  if (event.phase.startsWith("provider_")) return "Model";
  return null;
}

// What each agent did over a run: its calls to the model and how they ended,
// what they produced, how long the longest took, and every reason one of its
// replies could not be used. Counts and reasons only, never a reply.
export type AgentSummary = {
  agent: string;
  calls: number;
  answered: number;
  stops: number;
  retries: number;
  errors: number;
  thinkingChars: number;
  replyChars: number;
  tokens: number;
  thinkingTokens: number;
  longestMs: number;
  finishReasons: string[];
  problems: string[];
};
export function agentsOf(events: Logged[]): AgentSummary[] {
  const agents = new Map<string, AgentSummary>();
  for (const event of [...events].sort((a, b) => a.at - b.at)) {
    const agent = agentOf(event);
    if (!agent) continue;
    let row = agents.get(agent);
    if (!row) {
      row = {
        agent, calls: 0, answered: 0, stops: 0, retries: 0, errors: 0, thinkingChars: 0, replyChars: 0,
        tokens: 0, thinkingTokens: 0, longestMs: 0, finishReasons: [], problems: [],
      };
      agents.set(agent, row);
    }
    const detail = event.detail ?? {};
    // A call's own totals ride the line it ended on: the answer, or the stop.
    const ended = () => {
      row!.thinkingChars += detail.reasoningChars ?? 0;
      row!.replyChars += detail.replyChars ?? 0;
      row!.tokens += detail.completionTokens ?? 0;
      row!.thinkingTokens += detail.reasoningTokens ?? 0;
      row!.longestMs = Math.max(row!.longestMs, detail.durationMs ?? 0);
      if (detail.finishReason && !row!.finishReasons.includes(detail.finishReason)) row!.finishReasons.push(detail.finishReason);
    };
    if (event.phase === "provider_request") row.calls += 1;
    else if (event.phase === "provider_response") {
      row.answered += 1;
      ended();
    } else if (event.phase === "provider_stop") {
      row.stops += 1;
      ended();
    } else if (event.phase === "provider_retry" || event.phase === "provider_room") row.retries += 1;
    else if (event.phase === "provider_error") row.errors += 1;
    else if (event.phase === "crew_unusable" && detail.reason) row.problems.push(detail.reason);
  }
  return [...agents.values()];
}

// What stopped a failed build: the last error before its ending -- the line
// that stopped it -- and the last thing that went wrong on the way there,
// which is usually why. A build that finished has neither.
const TROUBLE = new Set(["provider_error", "provider_stop", "crew_unusable", "draft_unusable"]);
export function stopOf(run: Pick<Doc<"buildRuns">, "status">, events: Logged[]) {
  if (run.status !== "failed") return { stoppedBy: null, cause: null };
  const ordered = [...events].sort((a, b) => a.at - b.at);
  const ending = ordered.findIndex((event) => event.phase === "failed");
  const before = ending === -1 ? ordered : ordered.slice(0, ending);
  const stoppedBy = [...before].reverse().find((event) => event.level === "error") ?? null;
  const upTo = stoppedBy ? before.slice(0, before.indexOf(stoppedBy) + 1) : before;
  const cause = [...upTo].reverse().find((event) => TROUBLE.has(event.phase) && event !== stoppedBy) ?? null;
  return { stoppedBy, cause };
}

function summaryLine(row: AgentSummary) {
  const said = [
    `${row.calls} ${row.calls === 1 ? "call" : "calls"}`,
    `${row.answered} answered`,
    ...(row.stops ? [`${row.stops} stopped`] : []),
    ...(row.retries ? [`${row.retries} asked again`] : []),
    ...(row.errors ? [`${row.errors} failed`] : []),
    ...(row.thinkingChars ? [`thinking ${grouped(row.thinkingChars)} chars`] : []),
    ...(row.replyChars ? [`reply ${grouped(row.replyChars)} chars`] : []),
    ...(row.tokens ? [`tokens ${grouped(row.tokens)}${row.thinkingTokens ? ` (${grouped(row.thinkingTokens)} thinking)` : ""}`] : []),
    ...(row.longestMs ? [`longest ${seconds(row.longestMs)}`] : []),
    ...(row.finishReasons.length ? [`finish ${row.finishReasons.join("/")}`] : []),
  ];
  return [`  ${row.agent}: ${said.join(", ")}`, ...row.problems.map((problem) => `    unusable: ${problem}`)];
}

export function composeReport(
  run: Doc<"buildRuns">,
  events: Doc<"buildEvents">[],
  member: { email: string | null },
  site: { name: string; slug?: string; url: string | null } | null,
) {
  const ordered = [...events].sort((a, b) => a.at - b.at);
  const stops = ordered.filter((event) => STOP_PHASES.has(event.phase));
  const failed = run.status === "failed";
  const lastStop = [...stops].reverse().find((event) => event.phase === "provider_stop" || event.phase === "watchdog");
  // What the member was told ends with what they can do about it. Support
  // wants the fault on its own, and the member's words beside it.
  const fault = (run.error ?? "The build failed.").replace(/\s*(Try (building )?again[^.]*\.|Your answers are saved\.)/g, "").trim() || "The build failed.";
  const headline = failed
    ? fault
    : `Finished after a stop: ${lastStop?.label ?? stops[0]?.label ?? "a reply stopped part way"}.`;
  const subject = `[Forge] Build ${failed ? "failed" : "recovered"}: ${headline}`.replace(/\s+/g, " ").slice(0, 160);
  const ended = run.endedAt ?? run.updatedAt;
  const source = run.source === "generate" ? "Thread build" : run.source === "rebuild" ? "Rebuild" : "Onboarding build";
  const kind = `${source}${run.requestKind ? ` (${run.requestKind})` : ""}${run.attempt ? `, attempt ${run.attempt}` : ""}`;
  const { stoppedBy, cause } = stopOf(run, ordered);
  const told = (event: Logged) => {
    const about = describeDetail(event.detail);
    return `${event.label}${about ? ` [${about}]` : ""}`;
  };
  const agents = agentsOf(ordered);
  const lines = [
    failed ? "A build failed." : "A build finished, but a reply stopped on the way.",
    "",
    "What happened",
    `  ${headline}`,
    ...(failed && run.error && run.error !== fault ? [`  The member saw: ${run.error}`] : []),
    ...(run.errorClass ? [`  Class: ${run.errorClass}`] : []),
    ...(stoppedBy ? [`  Stopped by (+${span(stoppedBy.at - run.startedAt)}): ${told(stoppedBy)}`] : []),
    ...(cause ? [`  Went wrong before it (+${span(cause.at - run.startedAt)}): ${told(cause)}`] : []),
    ...(stops.length ? [`  Stops, retries and resumes: ${stops.length}`] : []),
    ...(agents.length ? ["", "Agents", ...agents.flatMap(summaryLine)] : []),
    "",
    "Build",
    `  Run: ${run._id}`,
    `  Kind: ${kind}`,
    `  Started: ${clock(run.startedAt)}`,
    `  Ended: ${clock(ended)} (${span(ended - run.startedAt)})`,
    ...(run.providerModel ? [`  Model: ${run.providerModel}${run.providerHost ? ` on ${run.providerHost}` : ""}`] : []),
    ...(run.creditsHeld !== undefined ? [`  Credits held: ${run.creditsHeld}`] : []),
    "",
    "Member",
    `  Email: ${member.email ?? "none on the account"}`,
    `  User: ${run.userId}`,
    ...(site ? [`  Site: ${site.name}${run.siteId ? ` (${run.siteId})` : ""}`] : []),
    ...(site?.url ? [`  Address: ${site.url}`] : []),
    "",
    "Timeline",
    ...ordered.map((event) => {
      const offset = `+${span(event.at - run.startedAt)}`.padEnd(9);
      const about = describeDetail(event.detail);
      return `  ${offset}${event.phase.padEnd(19)}${event.label}${about ? `\n  ${" ".repeat(9 + 19)}${about}` : ""}`;
    }),
    "",
    "Look further",
    `  npx convex run diagnostics:trace '{"runId":"${run._id}"}'`,
    "  npx convex run diagnostics:inspectStalls",
    "  npx convex run probe:stream",
    "",
    "Sent automatically by Forge Nexxus when a build fails or a reply stops part way.",
  ];
  return { subject, text: lines.join("\n") };
}

// The report for one run, as support is sent it and `diagnostics:trace`
// reads it.
export async function reportFor(ctx: QueryCtx, run: Doc<"buildRuns">) {
  const events = await ctx.db.query("buildEvents").withIndex("by_run_at", (q) => q.eq("runId", run._id)).collect();
  const user = await ctx.db.get(run.userId);
  const site = run.siteId ? await ctx.db.get(run.siteId) : null;
  const mail = composeReport(
    run,
    events,
    { email: user && "email" in user && typeof user.email === "string" ? user.email : null },
    site ? { name: site.name, slug: site.slug, url: site.slug && site.status === "published" ? publishedUrlFor(site.slug) : null } : null,
  );
  return { ...mail, events };
}

export const report = internalQuery({
  args: { runId: v.id("buildRuns") },
  handler: async (ctx, { runId }) => {
    const run = await ctx.db.get(runId);
    if (!run) return null;
    const { subject, text } = await reportFor(ctx, run);
    return { subject, text };
  },
});

// ——— Sending ————————————————————————————————————————————————————————————

function scrub(text: string) {
  const key = resendKey();
  return (key ? text.split(key).join("[key]") : text).replace(/\s+/g, " ").trim().slice(0, 160);
}

type Sent = { ok: boolean; httpStatus?: number; said?: string };
async function sendEmail(mail: { subject: string; text: string }): Promise<Sent> {
  const key = resendKey();
  if (!key) return { ok: false, said: "No email key is set on this deployment" };
  try {
    const response = await fetch(RESEND_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ from: sender(), to: [supportAddress()], subject: mail.subject, text: mail.text }),
    });
    const body = await response.text();
    if (response.ok) return { ok: true, httpStatus: response.status };
    let said = body;
    try { said = JSON.parse(body)?.message ?? body; } catch { /* the body is the message */ }
    return { ok: false, httpStatus: response.status, said: scrub(String(said)) };
  } catch (error) {
    return { ok: false, said: scrub(error instanceof Error ? error.message : String(error)) };
  }
}

export const sendReport = internalAction({
  args: { runId: v.id("buildRuns") },
  handler: async (ctx, { runId }): Promise<void> => {
    const mail = await ctx.runQuery(internal.support.report, { runId });
    if (!mail) return;
    const sent = await sendEmail(mail);
    if (!sent.ok) console.error("Forge could not send a build report to support:", sent.httpStatus ?? "", sent.said ?? "");
    await ctx.runMutation(internal.support.noteReport, { runId, ...sent });
  },
});

// The run's own log says whether support was told, and if not, why not.
export const noteReport = internalMutation({
  args: { runId: v.id("buildRuns"), ok: v.boolean(), httpStatus: v.optional(v.number()), said: v.optional(v.string()) },
  handler: async (ctx, { runId, ok, httpStatus, said }) => {
    const run = await ctx.db.get(runId);
    if (!run) return;
    await ctx.db.insert("buildEvents", {
      userId: run.userId,
      runId,
      at: Date.now(),
      phase: "support_report",
      level: ok ? "info" : "warn",
      label: ok ? `Sent the build report to ${supportAddress()}` : "The build report to support could not be sent",
      detail: { httpStatus, providerError: said, errorClass: ok ? undefined : "support_email" },
    });
  },
});

// One test report, for whoever sets this up: `npx convex run support:test`.
// It goes to the same address from the same sender a real report uses, and
// says what the email provider answered.
export const test = internalAction({
  args: {},
  handler: async (): Promise<Sent & { to: string; from: string }> => {
    const sent = await sendEmail({
      subject: "[Forge] Build reports are on",
      text: [
        "This is a test from Forge Nexxus.",
        "",
        "From now on, whenever a build fails or a reply stops part way, the building agent's log for that run is sent here automatically.",
        "",
        "Look further",
        "  npx convex run diagnostics:inspectStalls",
        "  npx convex run probe:stream",
      ].join("\n"),
    });
    return { ...sent, to: supportAddress(), from: sender() };
  },
});
