// Best-effort text out of a PDF, in the default Convex runtime: no Node, no
// dependency. A PDF's text lives in content streams as `(…) Tj` and `[…] TJ`
// operators, usually Flate-compressed. This walks the streams, inflates the
// ones it can, and collects those operators. It is not a renderer: it gets the
// words out of an ordinary text PDF and gives up cleanly on anything else
// (scans with no text layer, unusual encodings, encrypted files), because the
// caller's fallback is to tell the user the file could not be read.

const STREAM = /stream\r?\n?/g;

function latin1(bytes: Uint8Array) {
  let out = "";
  // Chunked so a large file cannot blow the argument limit of String.fromCharCode.
  for (let index = 0; index < bytes.length; index += 8192) {
    out += String.fromCharCode(...bytes.subarray(index, index + 8192));
  }
  return out;
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (typeof DecompressionStream === "undefined") return null;
  for (const format of ["deflate", "deflate-raw"] as const) {
    try {
      const stream = new Blob([bytes as unknown as BlobPart])
        .stream()
        .pipeThrough(new DecompressionStream(format));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch {
      /* Try the other framing, then give up on this stream. */
    }
  }
  return null;
}

// The strings inside one content stream, in the order they are drawn.
function textFromContent(content: string) {
  let out = "";
  let index = 0;
  while (index < content.length) {
    const char = content[index];
    if (char === "(") {
      let depth = 1;
      let literal = "";
      index += 1;
      while (index < content.length && depth > 0) {
        const current = content[index];
        if (current === "\\") {
          const next = content[index + 1] ?? "";
          const escapes: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" };
          if (next >= "0" && next <= "7") {
            const octal = content.slice(index + 1, index + 4).match(/^[0-7]{1,3}/)?.[0] ?? "";
            literal += String.fromCharCode(parseInt(octal, 8));
            index += 1 + octal.length;
            continue;
          }
          literal += escapes[next] ?? next;
          index += 2;
          continue;
        }
        if (current === "(") depth += 1;
        if (current === ")") {
          depth -= 1;
          if (depth === 0) break;
        }
        literal += current;
        index += 1;
      }
      out += literal;
      index += 1;
      continue;
    }
    // A move to a new line or a new text object is a break between words.
    if (/^(T[dD*jJ]|ET)/.test(content.slice(index, index + 2))) {
      const operator = content.slice(index, index + 2);
      if (operator !== "Tj" && operator !== "TJ") out += "\n";
      index += 2;
      continue;
    }
    index += 1;
  }
  return out;
}

export async function pdfText(buffer: ArrayBuffer, limit: number): Promise<string> {
  const bytes = new Uint8Array(buffer);
  const raw = latin1(bytes);
  if (/\/Encrypt\b/.test(raw)) return "";
  let text = "";
  STREAM.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = STREAM.exec(raw)) !== null && text.length < limit) {
    const start = match.index + match[0].length;
    const end = raw.indexOf("endstream", start);
    if (end < 0) break;
    const header = raw.slice(Math.max(0, match.index - 400), match.index);
    const slice = bytes.subarray(start, end);
    const body = /\/FlateDecode\b/.test(header) ? await inflate(slice) : slice;
    STREAM.lastIndex = end;
    if (!body) continue;
    const content = latin1(body);
    // Only content streams hold drawing operators; images and fonts do not.
    if (!/\bT[jJ]\b/.test(content)) continue;
    text += `${textFromContent(content)}\n`;
  }
  return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, limit);
}
