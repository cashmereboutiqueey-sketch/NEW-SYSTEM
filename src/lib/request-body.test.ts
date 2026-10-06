import { describe, expect, it } from "vitest";
import { formDataWithinLimit, PayloadTooLargeError, textWithinLimit } from "./request-body";

describe("request body limits", () => {
  it("accepts a multipart form within the byte limit", async () => {
    const form = new FormData();
    form.set("file", new File(["image bytes"], "test.jpg"));
    const request = new Request("http://localhost/upload", { method: "POST", body: form });
    expect((await formDataWithinLimit(request, 1024)).get("file")).toBeInstanceOf(File);
  });

  it("rejects an oversized multipart body without Content-Length", async () => {
    const form = new FormData();
    form.set("file", new File(["x".repeat(2048)], "test.jpg"));
    const request = new Request("http://localhost/upload", { method: "POST", body: form });
    expect(request.headers.get("content-length")).toBeNull();
    await expect(formDataWithinLimit(request, 1024)).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  it("rejects an oversized webhook body without Content-Length", async () => {
    const request = new Request("http://localhost/webhook", {
      method: "POST",
      body: "x".repeat(2048),
    });
    await expect(textWithinLimit(request, 1024)).rejects.toBeInstanceOf(PayloadTooLargeError);
  });
});
