import { afterEach, describe, expect, it, vi } from "vitest";
import { saveLocalFile } from "../src/web/saveFile.js";

afterEach(() => vi.unstubAllGlobals());
describe("local file export", () => {
  it("awaits native acknowledgement and never downloads again after a native failure", async () => {
    const blob = new Blob(["offline backup"], { type: "application/json" });
    const native = vi.fn(async () => {});
    const browser = vi.fn();
    vi.stubGlobal("window", { openOutlinerAndroidSave: native });
    vi.stubGlobal("document", { createElement: browser });
    await saveLocalFile(blob, "openoutliner-test.json");
    expect(native).toHaveBeenCalledWith(blob, "openoutliner-test.json");
    expect(browser).not.toHaveBeenCalled();
    native.mockRejectedValueOnce(new Error("cancelled"));
    await expect(saveLocalFile(blob, "openoutliner-test.json")).rejects.toThrow("cancelled");
    expect(browser).not.toHaveBeenCalled();
  });
});
