import { describe, it, expect, afterAll } from "vitest";
import { readFile } from "node:fs/promises";
import {
  storeImage,
  isStoredName,
  imageUrl,
  imagePath,
  removeStoredFile,
  ImageError,
  UPLOAD_DIR,
} from "./images";

/**
 * Storing a product photograph.
 *
 * The interesting part is not saving a file, it is refusing the ones that are
 * not what they claim. A browser will send `image/jpeg` for anything, and a
 * file that is served back later with a content type somebody else's browser
 * tries to interpret is how an image upload becomes a way to run code.
 */

const stored: string[] = [];

/** A real, minimal file of each kind — magic bytes and enough padding. */
function bytesFor(kind: "jpg" | "png" | "webp" | "text", salt = 0): File {
  const pad = new Uint8Array(64).fill(salt);

  if (kind === "jpg") {
    return file([0xff, 0xd8, 0xff, 0xe0, ...pad], "photo.jpg", "image/jpeg");
  }
  if (kind === "png") {
    return file([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...pad], "photo.png", "image/png");
  }
  if (kind === "webp") {
    const riff = [0x52, 0x49, 0x46, 0x46]; // RIFF
    const size = [0, 0, 0, 0];
    const webp = [0x57, 0x45, 0x42, 0x50]; // WEBP
    return file([...riff, ...size, ...webp, ...pad], "photo.webp", "image/webp");
  }
  return file([...Buffer.from("this is not an image at all, it is a script")], "photo.jpg", "image/jpeg");
}

function file(bytes: number[], name: string, type: string): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

async function keep(promise: Promise<string>): Promise<string> {
  const name = await promise;
  stored.push(name);
  return name;
}

afterAll(async () => {
  for (const name of stored) await removeStoredFile(name);
});

describe("what gets accepted", () => {
  it("takes a JPEG", async () => {
    const name = await keep(storeImage(bytesFor("jpg")));
    expect(name).toMatch(/^[a-f0-9]{16}\.jpg$/);
  });

  it("takes a PNG", async () => {
    const name = await keep(storeImage(bytesFor("png")));
    expect(name).toMatch(/^[a-f0-9]{16}\.png$/);
  });

  it("takes a WebP", async () => {
    const name = await keep(storeImage(bytesFor("webp")));
    expect(name).toMatch(/^[a-f0-9]{16}\.webp$/);
  });

  it("writes the bytes it was given", async () => {
    const source = bytesFor("png", 7);
    const expected = new Uint8Array(await source.arrayBuffer());
    const name = await keep(storeImage(source));

    const written = new Uint8Array(await readFile(imagePath(name)));
    expect(Buffer.from(written).equals(Buffer.from(expected))).toBe(true);
  });
});

describe("what gets refused", () => {
  it("refuses a file that only claims to be an image", async () => {
    // The declared type says image/jpeg. The bytes say otherwise, and the
    // bytes are what a browser will act on later.
    await expect(storeImage(bytesFor("text"))).rejects.toThrow(/not a JPEG, PNG or WebP/i);
  });

  it("refuses an empty file", async () => {
    await expect(storeImage(file([], "nothing.jpg", "image/jpeg"))).rejects.toThrow(
      ImageError,
    );
  });

  it("refuses anything over five megabytes", async () => {
    const huge = new Uint8Array(5 * 1024 * 1024 + 1);
    huge.set([0xff, 0xd8, 0xff, 0xe0]);
    const big = new File([huge], "big.jpg", { type: "image/jpeg" });

    await expect(storeImage(big)).rejects.toThrow(/limit is 5MB/i);
  });

  it("refuses a file too short to identify", async () => {
    await expect(storeImage(file([0xff, 0xd8], "tiny.jpg", "image/jpeg"))).rejects.toThrow(
      ImageError,
    );
  });
});

describe("the same photo twice", () => {
  it("is stored once", async () => {
    const first = await keep(storeImage(bytesFor("jpg", 3)));
    const second = await storeImage(bytesFor("jpg", 3));

    // Named by content, so an identical upload is already on disk.
    expect(second).toBe(first);
  });

  it("gives different photos different names", async () => {
    const a = await keep(storeImage(bytesFor("jpg", 11)));
    const b = await keep(storeImage(bytesFor("jpg", 12)));
    expect(a).not.toBe(b);
  });
});

describe("names cannot be used to escape", () => {
  it("accepts only the shape it writes", () => {
    expect(isStoredName("0123456789abcdef.jpg")).toBe(true);
    expect(isStoredName("0123456789abcdef.png")).toBe(true);
    expect(isStoredName("0123456789abcdef.webp")).toBe(true);
  });

  it("rejects every way of walking out of the folder", () => {
    for (const bad of [
      "../../../etc/passwd",
      "..%2f..%2fetc%2fpasswd",
      "/etc/passwd",
      "C:\\Windows\\win.ini",
      "0123456789abcdef.jpg/../../secret",
      "0123456789abcdef.exe",
      "0123456789abcdef.svg",
      "0123456789ABCDEF.jpg",
      "short.jpg",
      "",
      ".env",
    ]) {
      expect(isStoredName(bad)).toBe(false);
      expect(imageUrl(bad)).toBeNull();
    }
  });

  it("refuses to build a path for a name it did not write", () => {
    expect(() => imagePath("../../.env")).toThrow(ImageError);
  });

  it("keeps every file it does write inside the upload folder", async () => {
    const name = await keep(storeImage(bytesFor("png", 21)));
    expect(imagePath(name).startsWith(UPLOAD_DIR)).toBe(true);
  });

  it("has no url for a missing photo, so callers need no special case", () => {
    expect(imageUrl(null)).toBeNull();
    expect(imageUrl(undefined)).toBeNull();
  });
});
