// @vitest-environment node
import { describe, expect, test } from "vitest";
import { crc32, zipFiles } from "./zip.js";

// The archive is read back by its own structure -- the signatures, the two
// tables of contents and the offsets that join them -- which is what any unzip
// tool does. If this holds, the tool opens it.
function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const endAt = bytes.length - 22;
  expect(view.getUint32(endAt, true)).toBe(0x06054b50);
  const count = view.getUint16(endAt + 10, true);
  const centralSize = view.getUint32(endAt + 12, true);
  const centralAt = view.getUint32(endAt + 16, true);
  expect(centralAt + centralSize).toBe(endAt);
  const entries = [];
  let at = centralAt;
  for (let i = 0; i < count; i += 1) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    const flags = view.getUint16(at + 8, true);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const localAt = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    // The local header agrees with the central one and the data follows it.
    expect(view.getUint32(localAt, true)).toBe(0x04034b50);
    expect(view.getUint32(localAt + 14, true)).toBe(crc);
    const localNameLength = view.getUint16(localAt + 26, true);
    const dataAt = localAt + 30 + localNameLength;
    const data = bytes.subarray(dataAt, dataAt + size);
    expect(crc32(data)).toBe(crc);
    entries.push({ name, utf8: Boolean(flags & 0x0800), data: decoder.decode(data) });
    at += 46 + nameLength;
  }
  return entries;
}

describe("zipFiles", () => {
  test("crc32 matches the published check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  test("every file comes back, by name, whole, in order", () => {
    const files = [
      { name: "index.html", data: "<!doctype html><h1>Home</h1>" },
      { name: "about.html", data: "<!doctype html><h1>Our story — café</h1>" },
      { name: "shop/shirts.html", data: new TextEncoder().encode("<p>bytes in, bytes out</p>") },
    ];
    const entries = readZip(zipFiles(files, new Date(2026, 8, 22, 10, 30, 0)));
    expect(entries.map((entry) => entry.name)).toEqual(["index.html", "about.html", "shop/shirts.html"]);
    expect(entries[0].data).toBe(files[0].data);
    expect(entries[1].data).toBe(files[1].data);
    expect(entries[2].data).toBe("<p>bytes in, bytes out</p>");
    expect(entries.every((entry) => entry.utf8)).toBe(true);
  });

  test("an archive of nothing is still an archive", () => {
    expect(readZip(zipFiles([]))).toEqual([]);
  });
});
