import { readFile } from "node:fs/promises";
import { requireUser } from "@/lib/auth";
import { isStoredName, imagePath, CONTENT_TYPE } from "@/lib/images";

/**
 * Serving a product photograph.
 *
 * Behind the session like every other screen. The pictures themselves are not
 * sensitive, but which garments a business sells and how many it has is, and
 * an open image endpoint is an easy way to enumerate a catalogue.
 *
 * The name is checked against the stored-name shape before it reaches the
 * filesystem. Because stored names are hashes of file contents, no name a
 * person could type is valid, which is a stronger guarantee than filtering
 * for `..`.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  await requireUser();

  const { name } = await params;
  if (!isStoredName(name)) {
    return new Response("Not found", { status: 404 });
  }

  try {
    const bytes = await readFile(imagePath(name));
    const ext = name.split(".").pop()!;

    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": CONTENT_TYPE[ext] ?? "application/octet-stream",
        // The name is a hash of the contents, so the file behind it can never
        // change. It is safe to cache for as long as the browser likes.
        "Cache-Control": "private, max-age=31536000, immutable",
        // Belt and braces: never let a browser reinterpret these bytes.
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
