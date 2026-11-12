import { describe, expect, it } from "vitest";
import { decodeRecovery, encodeRecovery, MAX_RECOVERY_BYTES } from "../src/web/recoveryFile";
describe("recovery capacity round trip", () => {
  it("restores a successful export larger than the old 32 MiB limit", async () => {
    const value={format:"openoutliner-recovery-v1",local:{title:"x".repeat(33 * 1024 * 1024)}, editorDrafts:[{value:"草稿😀"}]};
    const blob=encodeRecovery(value);
    expect(blob.size).toBeGreaterThan(32*1024*1024); expect(blob.size).toBeLessThan(MAX_RECOVERY_BYTES);
    expect(await decodeRecovery(blob)).toEqual(value);
  }, 15000);
  it("uses UTF-8 bytes rather than JavaScript string length", async () => {
    const value={text:"汉字😀"}; const blob=encodeRecovery(value);
    expect(blob.size).toBeGreaterThan(JSON.stringify(value).length);
    expect(await decodeRecovery(blob,blob.size)).toEqual(value);
    expect(()=>encodeRecovery(value,blob.size-1)).toThrow(/超过/);
    await expect(decodeRecovery(blob,blob.size-1)).rejects.toThrow(/超过/);
  });
  it("rejects malformed data before any database write", async () => {
    await expect(decodeRecovery(new Blob(['{bad']))).rejects.toThrow(/JSON/);
    await expect(decodeRecovery(new Blob([new Uint8Array([0xff])]))).rejects.toThrow(/UTF-8/);
  });
});
