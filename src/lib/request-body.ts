/** Read request bodies with a real byte limit, even when Content-Length is absent. */
export class PayloadTooLargeError extends Error {}

function limitedBody(request: Request, maxBytes: number): ReadableStream<Uint8Array> {
  if (!request.body) throw new Error("Missing request body.");
  let received = 0;
  return request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > maxBytes) throw new PayloadTooLargeError("Request body is too large.");
      controller.enqueue(chunk);
    },
  }));
}

export async function formDataWithinLimit(request: Request, maxBytes: number): Promise<FormData> {
  const contentType = request.headers.get("content-type");
  if (!contentType?.toLowerCase().startsWith("multipart/form-data;")) {
    throw new Error("Expected a multipart form.");
  }
  return new Response(limitedBody(request, maxBytes), {
    headers: { "Content-Type": contentType },
  }).formData();
}

export async function textWithinLimit(request: Request, maxBytes: number): Promise<string> {
  return new Response(limitedBody(request, maxBytes)).text();
}
