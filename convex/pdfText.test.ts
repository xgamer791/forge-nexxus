/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { pdfText } from "./pdfText";

// A minimal PDF with one uncompressed content stream, which is what the
// extractor walks. Real files are usually Flate-compressed; that path needs
// DecompressionStream and is exercised by the runtime rather than here.
function pdf(content: string) {
  return new TextEncoder().encode(
    `%PDF-1.4\n1 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\ntrailer\n%%EOF\n`,
  ).buffer as ArrayBuffer;
}

describe("pdfText", () => {
  test("pulls the drawn strings out in order", async () => {
    const text = await pdfText(pdf("BT /F1 24 Tf (Hearth & Grain) Tj 0 -28 Td (Sourdough daily) Tj ET"), 1000);
    expect(text).toContain("Hearth & Grain");
    expect(text).toContain("Sourdough daily");
    expect(text.indexOf("Hearth")).toBeLessThan(text.indexOf("Sourdough"));
  });

  test("reads escapes and bracketed runs", async () => {
    const text = await pdfText(pdf(String.raw`BT [(Open 7\055days) -200 (a week)] TJ ET`), 1000);
    expect(text).toContain("Open 7-days");
    expect(text).toContain("a week");
  });

  test("a file with no text layer comes back empty rather than failing", async () => {
    expect(await pdfText(pdf("q 612 0 0 792 0 0 cm /Im1 Do Q"), 1000)).toBe("");
  });

  test("an encrypted file is left alone", async () => {
    const buffer = new TextEncoder().encode("%PDF-1.4\n/Encrypt 2 0 R\nstream\nBT (hi) Tj ET\nendstream\n")
      .buffer as ArrayBuffer;
    expect(await pdfText(buffer, 1000)).toBe("");
  });

  test("nothing is returned past the limit", async () => {
    const long = `BT ${Array.from({ length: 40 }, (_, index) => `(line ${index} of text) Tj`).join(" ")} ET`;
    expect((await pdfText(pdf(long), 50)).length).toBeLessThanOrEqual(50);
  });

  test("a file that is not a PDF at all is not an error", async () => {
    expect(await pdfText(new TextEncoder().encode("just some text").buffer as ArrayBuffer, 100)).toBe("");
  });

  // What a real PDF looks like: the content stream is zlib-compressed.
  test("a Flate-compressed stream is inflated and read", async () => {
    const content = "BT /F1 12 Tf (Compressed menu) Tj 0 -14 Td (Focaccia, 4.50) Tj ET";
    const compressed = new Uint8Array(
      await new Response(
        new Blob([new TextEncoder().encode(content)]).stream().pipeThrough(new CompressionStream("deflate")),
      ).arrayBuffer(),
    );
    const head = new TextEncoder().encode(
      `%PDF-1.4\n1 0 obj\n<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`,
    );
    const tail = new TextEncoder().encode("\nendstream\nendobj\n%%EOF\n");
    const file = new Uint8Array(head.length + compressed.length + tail.length);
    file.set(head, 0);
    file.set(compressed, head.length);
    file.set(tail, head.length + compressed.length);

    const text = await pdfText(file.buffer as ArrayBuffer, 1000);
    expect(text).toContain("Compressed menu");
    expect(text).toContain("Focaccia, 4.50");
  });
});
