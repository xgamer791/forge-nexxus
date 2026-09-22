// A reply read as it streams, so that what decides a stall is the stream
// itself and never a length of time.
//
// A reply is moving while tokens arrive -- thinking or page -- however long it
// has been running. It has stopped only when the stream says so:
//
//   dropped         the connection closed before the reply finished
//   provider_error  the provider put an error in the stream
//   looping         the model is sending tokens but repeating itself, saying
//                   the same passage of its thinking over and over
//
// A provider that is still queueing the request keeps the connection open with
// keep-alive comments. That is a connection that is alive and a reply that has
// not started, so it is counted, not called a stall.
//
// Nothing here keeps the text. The reply goes back to the caller, the thinking
// is held only long enough to see whether it repeats, and what the build's log
// gets is counts and phases.

export type StreamPhase = "waiting" | "thinking" | "writing" | "finished";
export type StopReason = "dropped" | "provider_error" | "looping" | "out_of_time";

export type StreamStats = {
  phase: StreamPhase;
  reasoningChars: number;
  contentChars: number;
  chunks: number;
  keepAlives: number;
  bytes: number;
  // From the request to the first token of any kind, and to the first
  // character of the page.
  firstTokenMs?: number;
  firstContentMs?: number;
  // When the last token arrived. Evidence for the log -- how long the reply had
  // been quiet when it stopped -- and never what decides that it stopped.
  lastTokenAt?: number;
  finishReason?: string;
  completionTokens?: number;
  reasoningTokens?: number;
  // What the provider, or the connection, said last, scrubbed and one line.
  providerError?: string;
  loopRepeats?: number;
  sawDone: boolean;
};

export class StreamStopped extends Error {
  constructor(
    readonly reason: StopReason,
    readonly stats: StreamStats,
    // The page as far as it got, so a reply that stopped part way through
    // writing can be picked up where it stopped rather than started again.
    readonly content: string,
  ) {
    super(`The reply stopped: ${reason}`);
    this.name = "StreamStopped";
  }
}

export type Milestone = { kind: "thinking" | "writing"; first: boolean; stats: StreamStats };

// How often a moving reply is written into the build's log, by how much it has
// produced rather than by the clock: a line when it starts thinking, one per
// this much thinking, a line when it starts the page, one per this much page.
export const THINKING_STEP = 40000;
export const WRITING_STEP = 8000;

// The model is going round in circles when the passage it has just thought is
// one it has only just thought, several times over. A window this long does
// not repeat by accident, and thinking -- unlike a page, where a repeated card
// or icon is ordinary -- has no reason to say the same 600 characters four
// times in a row. Only the recent stretch is searched: a loop is tight, and a
// passage that comes back once in a long while, like a draft reworked, is not
// one.
export const LOOP_WINDOW = 600;
export const LOOP_REPEATS = 4;
const LOOP_CHECK_EVERY = 3000;

export function repeatsOfTail(text: string, window = LOOP_WINDOW, repeats = LOOP_REPEATS) {
  if (text.length < window * 2) return 0;
  const recent = text.slice(-window * repeats * 2);
  const tail = recent.slice(-window);
  let count = 0;
  for (let from = recent.indexOf(tail); from !== -1; from = recent.indexOf(tail, from + window)) count += 1;
  return count;
}

export function isEventStream(response: Response) {
  return /text\/event-stream/i.test(response.headers.get("content-type") ?? "") && response.body !== null;
}

export async function readStream(
  body: ReadableStream<Uint8Array>,
  options: {
    started: number;
    // Why the read was cut short, when the caller cut it: the build's own
    // time running out is the only reason it does.
    cutShort: () => StopReason | null;
    scrub: (text: string) => string;
    onMilestone?: (milestone: Milestone) => Promise<void> | void;
  },
): Promise<{ content: string; stats: StreamStats }> {
  const stats: StreamStats = { phase: "waiting", reasoningChars: 0, contentChars: 0, chunks: 0, keepAlives: 0, bytes: 0, sawDone: false };
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let content = "";
  let thinking = "";
  let buffered = "";
  let data: string[] = [];
  let nextThinkingNote = THINKING_STEP;
  let nextWritingNote = WRITING_STEP;
  let nextLoopCheck = LOOP_WINDOW * LOOP_REPEATS;
  const stop = async (reason: StopReason): Promise<never> => {
    try { await reader.cancel(); } catch { /* already closed */ }
    throw new StreamStopped(reason, { ...stats }, content);
  };
  const note = async (milestone: Milestone) => {
    try { await options.onMilestone?.(milestone); } catch { /* the log never stops a reply */ }
  };

  async function dispatch(payload: string) {
    if (payload === "[DONE]") { stats.sawDone = true; return; }
    let chunk: {
      error?: { message?: unknown } | string;
      choices?: { delta?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown }; finish_reason?: unknown }[];
      usage?: { completion_tokens?: unknown; completion_tokens_details?: { reasoning_tokens?: unknown } };
    };
    try { chunk = JSON.parse(payload); } catch { return; }
    stats.chunks += 1;
    if (chunk.error) {
      const said = typeof chunk.error === "string" ? chunk.error : chunk.error.message;
      stats.providerError = options.scrub(String(said ?? "The provider sent an error")).slice(0, 160);
      await stop("provider_error");
    }
    const choice = chunk.choices?.[0];
    const delta = choice?.delta;
    const thought = typeof delta?.reasoning_content === "string" ? delta.reasoning_content
      : typeof delta?.reasoning === "string" ? delta.reasoning : "";
    const said = typeof delta?.content === "string" ? delta.content : "";
    const now = Date.now();
    if (thought) {
      thinking += thought;
      stats.reasoningChars += thought.length;
      stats.lastTokenAt = now;
      if (stats.firstTokenMs === undefined) stats.firstTokenMs = now - options.started;
      if (stats.phase === "waiting") {
        stats.phase = "thinking";
        await note({ kind: "thinking", first: true, stats: { ...stats } });
      }
      if (stats.reasoningChars >= nextThinkingNote) {
        nextThinkingNote = (Math.floor(stats.reasoningChars / THINKING_STEP) + 1) * THINKING_STEP;
        await note({ kind: "thinking", first: false, stats: { ...stats } });
      }
      if (thinking.length >= nextLoopCheck) {
        nextLoopCheck = thinking.length + LOOP_CHECK_EVERY;
        const repeats = repeatsOfTail(thinking);
        if (repeats >= LOOP_REPEATS) {
          stats.loopRepeats = repeats;
          await stop("looping");
        }
      }
    }
    if (said) {
      content += said;
      stats.contentChars += said.length;
      stats.lastTokenAt = now;
      if (stats.firstTokenMs === undefined) stats.firstTokenMs = now - options.started;
      if (stats.firstContentMs === undefined) stats.firstContentMs = now - options.started;
      if (stats.phase !== "writing") {
        stats.phase = "writing";
        await note({ kind: "writing", first: true, stats: { ...stats } });
      }
      if (stats.contentChars >= nextWritingNote) {
        nextWritingNote = (Math.floor(stats.contentChars / WRITING_STEP) + 1) * WRITING_STEP;
        await note({ kind: "writing", first: false, stats: { ...stats } });
      }
    }
    if (typeof choice?.finish_reason === "string") stats.finishReason = choice.finish_reason;
    const usage = chunk.usage;
    if (usage) {
      if (typeof usage.completion_tokens === "number") stats.completionTokens = usage.completion_tokens;
      const reasoning = usage.completion_tokens_details?.reasoning_tokens;
      if (typeof reasoning === "number") stats.reasoningTokens = reasoning;
    }
  }

  // One line of the event stream. A blank line ends an event; a line that
  // opens with a colon is a comment, which is what a keep-alive is.
  async function line(text: string) {
    if (text === "") {
      if (data.length) { const payload = data.join("\n"); data = []; await dispatch(payload); }
      return;
    }
    if (text.startsWith(":")) { stats.keepAlives += 1; return; }
    if (text.startsWith("data:")) data.push(text.slice(5).trim());
  }

  for (;;) {
    let next: ReadableStreamReadResult<Uint8Array>;
    try {
      next = await reader.read();
    } catch (error) {
      const why = options.cutShort();
      if (!why) stats.providerError = options.scrub(error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 160);
      throw new StreamStopped(why ?? "dropped", { ...stats }, content);
    }
    if (next.done) break;
    stats.bytes += next.value.byteLength;
    buffered += decoder.decode(next.value, { stream: true });
    let cut = buffered.indexOf("\n");
    while (cut !== -1) {
      await line(buffered.slice(0, cut).replace(/\r$/, ""));
      buffered = buffered.slice(cut + 1);
      cut = buffered.indexOf("\n");
    }
  }
  buffered += decoder.decode();
  if (buffered) await line(buffered.replace(/\r$/, ""));
  await line("");
  // The connection closed. A reply that said it was finished -- a finish
  // reason, or the stream's own end marker -- finished; one that did not was
  // cut off wherever it had got to.
  if (!stats.finishReason && !stats.sawDone) throw new StreamStopped("dropped", { ...stats }, content);
  stats.phase = "finished";
  return { content, stats };
}
