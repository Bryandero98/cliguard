import { ChangeType } from "../core/types";
import { buildWebhookPayload, postWebhook } from "../core/webhook";

describe("buildWebhookPayload", () => {
  it("carries only type/path/message per change, plus entry/repo/commit", () => {
    const payload = buildWebhookPayload("./bin/cli.js", [
      {
        type: ChangeType.BREAKING,
        path: "root -> option[--target]",
        message: 'Option "--target" was removed.',
        removal: true,
      },
    ]);

    expect(payload.entry).toBe("./bin/cli.js");
    expect(payload.changes).toEqual([
      {
        type: ChangeType.BREAKING,
        path: "root -> option[--target]",
        message: 'Option "--target" was removed.',
      },
    ]);
    // Internal-only DiffResult field, never sent on the wire.
    expect(payload.changes[0]).not.toHaveProperty("removal");
  });

  it("returns repo/commit as strings when run inside this git repo", () => {
    const payload = buildWebhookPayload("./bin/cli.js", []);
    expect(typeof payload.commit === "string" || payload.commit === null).toBe(true);
    expect(typeof payload.repo === "string" || payload.repo === null).toBe(true);
  });
});

describe("postWebhook", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("POSTs the payload as JSON to the given URL", async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    global.fetch = fetchMock as unknown as typeof fetch;

    const payload = buildWebhookPayload("./bin/cli.js", []);
    await postWebhook("https://example.com/hook", payload);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/hook",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
    );
  });

  it("throws a clear error on a non-2xx response", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 500 } as Response) as unknown as typeof fetch;

    await expect(
      postWebhook("https://example.com/hook", buildWebhookPayload("./bin/cli.js", [])),
    ).rejects.toThrow("status 500");
  });

  it("throws a clear error when the network request itself fails", async () => {
    global.fetch = jest
      .fn()
      .mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof fetch;

    await expect(
      postWebhook("https://example.com/hook", buildWebhookPayload("./bin/cli.js", [])),
    ).rejects.toThrow("ECONNREFUSED");
  });
});
