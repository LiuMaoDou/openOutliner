import { afterEach, describe, expect, it, vi } from "vitest";
import { translateToEnglish } from "../src/backend/server/translation.js";

const settings = { base: "http://127.0.0.1:9000/v1/", model: "translation-model", key: "test-key" };

afterEach(() => vi.unstubAllGlobals());

describe("English outline translation", () => {
  it("sends only the supplied title to the configured Chat Completions provider", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      choices: [{ message: { content: "  **Confirm the meeting time.**  " }, finish_reason: "stop" }]
    }));
    vi.stubGlobal("fetch", fetcher);
    const text = "**请确认会议时间。**";

    await expect(translateToEnglish({ text }, settings)).resolves.toBe("**Confirm the meeting time.**");

    const [url, request] = fetcher.mock.calls[0];
    expect(String(url)).toBe("http://127.0.0.1:9000/v1/chat/completions");
    expect(request).toMatchObject({
      method: "POST",
      redirect: "error",
      headers: { Authorization: "Bearer test-key" }
    });
    const body = JSON.parse(String(request?.body));
    expect(body.model).toBe(settings.model);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[1]).toEqual({ role: "user", content: text });
  });

  it("requires a nonempty title and a configured provider", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    await expect(translateToEnglish({ text: " " }, settings)).rejects.toMatchObject({ statusCode: 400 });
    await expect(translateToEnglish({ text: "你好" }, { ...settings, key: undefined })).rejects.toMatchObject({ statusCode: 503 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reports credential failures without including the provider's raw response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("private gateway diagnostics", { status: 401 })));

    await expect(translateToEnglish({ text: "你好" }, settings)).rejects.toMatchObject({
      statusCode: 502,
      message: "The translation provider rejected the configured API key."
    });
  });

  it("rejects incomplete translations", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      choices: [{ message: { content: "An incomplete" }, finish_reason: "length" }]
    })));

    await expect(translateToEnglish({ text: "你好" }, settings)).rejects.toMatchObject({
      statusCode: 502,
      message: "The translation provider did not return a complete translation."
    });
  });
});
