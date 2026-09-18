/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { classify, MAX_PENDING } from "./attachments";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");
const fresh = () => convexTest(schema, modules);

async function member(t: ReturnType<typeof fresh>) {
  const userId = await t.run(async (ctx) => await ctx.db.insert("users", { email: "m@example.com" }));
  const as = t.withIdentity({ subject: userId });
  const { conversationId, siteId } = await as.mutation(api.sites.create, { name: "Bakery" });
  return { as, userId, conversationId, siteId };
}

// The bytes normally arrive through the upload URL; a test puts them straight
// into storage and hands `attach` the id, which is the same thing the browser
// ends up doing.
async function store(t: ReturnType<typeof fresh>, body: BlobPart, type: string) {
  return await t.run(async (ctx) => await ctx.storage.store(new Blob([body], { type })));
}

describe("what Forge accepts", () => {
  test("images, text and PDFs are sorted; anything else is refused", () => {
    expect(classify("image/png", "logo.png")).toBe("image");
    expect(classify("image/heic", "IMG_0042.HEIC")).toBe("image");
    expect(classify("text/markdown", "brand.md")).toBe("text");
    expect(classify("application/pdf", "menu.pdf")).toBe("text");
    // SVG is markup, so it is read rather than looked at.
    expect(classify("image/svg+xml", "mark.svg")).toBe("text");
    // Browsers often send nothing useful; the name decides.
    expect(classify("", "notes.txt")).toBe("text");
    expect(classify("application/octet-stream", "photo.jpg")).toBe("image");
    expect(classify("application/zip", "assets.zip")).toBeNull();
    expect(classify("video/mp4", "clip.mp4")).toBeNull();
  });
});

describe("attaching", () => {
  test("a member attaches a photo and the composer sees it", async () => {
    const t = fresh();
    const { as, conversationId } = await member(t);
    const storageId = await store(t, "png-bytes", "image/png");
    await as.mutation(api.attachments.attach, {
      conversationId,
      storageId,
      name: "  storefront.png  ",
      mimeType: "image/png",
      size: 2048,
    });
    const listed = await as.query(api.attachments.list, { conversationId });
    expect(listed).toHaveLength(1);
    expect(listed[0].name).toBe("storefront.png");
    expect(listed[0].kind).toBe("image");
    expect(listed[0].url).toBeTruthy();
    expect(listed[0].messageId).toBeUndefined();
    // The storage id is the server's business, not the browser's.
    expect("storageId" in listed[0]).toBe(false);
  });

  test("a file Forge cannot use is refused before a byte is uploaded", async () => {
    const t = fresh();
    const { as, conversationId } = await member(t);
    await expect(
      as.mutation(api.attachments.uploadUrl, {
        conversationId,
        name: "assets.zip",
        mimeType: "application/zip",
        size: 10,
      }),
    ).rejects.toThrow("images, text files and PDFs");
    // And the recording step refuses it too, whatever the client tries.
    const storageId = await store(t, "zip-bytes", "application/zip");
    await expect(
      as.mutation(api.attachments.attach, {
        conversationId,
        storageId,
        name: "assets.zip",
        mimeType: "application/zip",
        size: 10,
      }),
    ).rejects.toThrow("images, text files and PDFs");
  });

  test("a file over the size limit is refused before it is uploaded", async () => {
    const t = fresh();
    const { as, conversationId } = await member(t);
    await expect(
      as.mutation(api.attachments.uploadUrl, {
        conversationId,
        name: "huge.png",
        mimeType: "image/png",
        size: 11 * 1024 * 1024,
      }),
    ).rejects.toThrow("larger than 10 MB");
  });

  test("a guest gets no upload URL", async () => {
    const t = fresh();
    const { conversationId } = await member(t);
    const guestId = await t.run(async (ctx) => await ctx.db.insert("users", { isAnonymous: true }));
    await expect(
      t.withIdentity({ subject: guestId }).mutation(api.attachments.uploadUrl, {
        conversationId,
        name: "guest.png",
        mimeType: "image/png",
        size: 10,
      }),
    ).rejects.toThrow("Sign in to build");
  });

  test("only so many files can wait for one prompt", async () => {
    const t = fresh();
    const { as, conversationId } = await member(t);
    for (let index = 0; index < MAX_PENDING; index += 1) {
      const storageId = await store(t, `bytes-${index}`, "image/png");
      await as.mutation(api.attachments.attach, {
        conversationId,
        storageId,
        name: `photo-${index}.png`,
        mimeType: "image/png",
        size: 100,
      });
    }
    const extra = await store(t, "one-more", "image/png");
    await expect(
      as.mutation(api.attachments.attach, {
        conversationId,
        storageId: extra,
        name: "extra.png",
        mimeType: "image/png",
        size: 100,
      }),
    ).rejects.toThrow(`${MAX_PENDING} files at a time`);
  });

  test("nobody attaches to someone else's thread, and nobody else sees it", async () => {
    const t = fresh();
    const { as, conversationId } = await member(t);
    const strangerId = await t.run(
      async (ctx) => await ctx.db.insert("users", { email: "other@example.com" }),
    );
    const stranger = t.withIdentity({ subject: strangerId });
    const storageId = await store(t, "png", "image/png");
    await expect(
      stranger.mutation(api.attachments.attach, {
        conversationId,
        storageId,
        name: "sneak.png",
        mimeType: "image/png",
        size: 10,
      }),
    ).rejects.toThrow("Conversation not found");
    const mine = await store(t, "png", "image/png");
    await as.mutation(api.attachments.attach, {
      conversationId,
      storageId: mine,
      name: "mine.png",
      mimeType: "image/png",
      size: 10,
    });
    expect(await stranger.query(api.attachments.list, { conversationId })).toEqual([]);
  });

  test("a guest cannot attach", async () => {
    const t = fresh();
    const { conversationId } = await member(t);
    const guestId = await t.run(async (ctx) => await ctx.db.insert("users", { isAnonymous: true }));
    const guest = t.withIdentity({ subject: guestId });
    const storageId = await store(t, "png", "image/png");
    await expect(
      guest.mutation(api.attachments.attach, {
        conversationId,
        storageId,
        name: "guest.png",
        mimeType: "image/png",
        size: 10,
      }),
    ).rejects.toThrow("Sign in to build");
  });
});

describe("removing", () => {
  test("a waiting file can be taken back, and its upload goes with it", async () => {
    const t = fresh();
    const { as, conversationId } = await member(t);
    const storageId = await store(t, "png", "image/png");
    const id = await as.mutation(api.attachments.attach, {
      conversationId,
      storageId,
      name: "wrong.png",
      mimeType: "image/png",
      size: 10,
    });
    await as.mutation(api.attachments.remove, { id });
    expect(await as.query(api.attachments.list, { conversationId })).toEqual([]);
    expect(await t.run(async (ctx) => await ctx.storage.getUrl(storageId))).toBeNull();
  });

  test("a file that has gone to the model stays", async () => {
    const t = fresh();
    const { as, conversationId } = await member(t);
    const storageId = await store(t, "png", "image/png");
    const id = await as.mutation(api.attachments.attach, {
      conversationId,
      storageId,
      name: "sent.png",
      mimeType: "image/png",
      size: 10,
    });
    const messageId = await t.run(
      async (ctx) => await ctx.db.insert("messages", { conversationId, role: "user", body: "use this" }),
    );
    await t.run(async (ctx) => await ctx.db.patch(id, { messageId }));
    await expect(as.mutation(api.attachments.remove, { id })).rejects.toThrow("already gone to Forge");
  });
});

describe("reading a file", () => {
  test("a text file's contents are pulled out for the model", async () => {
    const t = fresh();
    const { as, conversationId } = await member(t);
    const storageId = await store(t, "# Brand\nUse warm neutrals.\n", "text/markdown");
    const id = await as.mutation(api.attachments.attach, {
      conversationId,
      storageId,
      name: "brand.md",
      mimeType: "text/markdown",
      size: 30,
    });
    await t.finishAllScheduledFunctions(() => {});
    const row = await t.run(async (ctx) => await ctx.db.get(id));
    expect(row?.text).toContain("Use warm neutrals.");
    const listed = await as.query(api.attachments.list, { conversationId });
    expect(listed[0].readable).toBe(true);
  });

  test("a file with nothing to read says so instead of failing", async () => {
    const t = fresh();
    const { as, conversationId } = await member(t);
    const storageId = await store(t, "   \n  ", "text/plain");
    const id = await as.mutation(api.attachments.attach, {
      conversationId,
      storageId,
      name: "empty.txt",
      mimeType: "text/plain",
      size: 6,
    });
    await t.finishAllScheduledFunctions(() => {});
    const row = await t.run(async (ctx) => await ctx.db.get(id));
    expect(row?.text).toBeUndefined();
    expect(row?.textError).toBe("No text could be read from this file.");
  });

  test("an upload that vanished before it was read is reported, not thrown", async () => {
    const t = fresh();
    const { as, conversationId } = await member(t);
    const storageId = await store(t, "gone soon", "text/plain");
    const id = await as.mutation(api.attachments.attach, {
      conversationId,
      storageId,
      name: "gone.txt",
      mimeType: "text/plain",
      size: 9,
    });
    await t.run(async (ctx) => await ctx.storage.delete(storageId));
    await t.action(internal.attachments.read, { id });
    const row = await t.run(async (ctx) => await ctx.db.get(id));
    expect(row?.textError).toBe("This file could not be read.");
  });
});

describe("clearing up", () => {
  test("deleting the site takes its files and their uploads", async () => {
    const t = fresh();
    const { as, conversationId, siteId } = await member(t);
    const storageId = await store(t, "png", "image/png");
    await as.mutation(api.attachments.attach, {
      conversationId,
      storageId,
      name: "gone.png",
      mimeType: "image/png",
      size: 10,
    });
    await as.mutation(api.sites.remove, { id: siteId as Id<"sites"> });
    expect(await t.run(async (ctx) => await ctx.db.query("attachments").collect())).toEqual([]);
    expect(await t.run(async (ctx) => await ctx.storage.getUrl(storageId))).toBeNull();
  });

  test("an upload nobody recorded is swept once it is old enough", async () => {
    const t = fresh();
    const { as, conversationId } = await member(t);
    const kept = await store(t, "png", "image/png");
    await as.mutation(api.attachments.attach, {
      conversationId,
      storageId: kept,
      name: "kept.png",
      mimeType: "image/png",
      size: 10,
    });
    const abandoned = await store(t, "abandoned", "image/png");
    // A sweep of everything older than now leaves today's uploads alone.
    expect(await t.mutation(internal.attachments.sweep, {})).toBe(0);
    expect(await t.run(async (ctx) => await ctx.storage.getUrl(abandoned))).toBeTruthy();
    // Past the cutoff, the upload nothing recorded goes and the recorded one stays.
    expect(await t.mutation(internal.attachments.sweep, { before: Date.now() + 1000 })).toBe(1);
    expect(await t.run(async (ctx) => await ctx.storage.getUrl(abandoned))).toBeNull();
    expect(await t.run(async (ctx) => await ctx.storage.getUrl(kept))).toBeTruthy();
  });

  test("deleting the account takes them too", async () => {
    const t = fresh();
    const { as, conversationId } = await member(t);
    const storageId = await store(t, "png", "image/png");
    await as.mutation(api.attachments.attach, {
      conversationId,
      storageId,
      name: "gone.png",
      mimeType: "image/png",
      size: 10,
    });
    await as.mutation(api.users.deleteAccount, {});
    expect(await t.run(async (ctx) => await ctx.db.query("attachments").collect())).toEqual([]);
    expect(await t.run(async (ctx) => await ctx.storage.getUrl(storageId))).toBeNull();
  });
});
