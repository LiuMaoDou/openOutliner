import { expect, it } from "vitest";
import { hasAppUpdate, requestUpdateActivation } from "../src/web/appUpdates";
it("compares running/remote builds without confusing development with production", () => {
  expect(hasAppUpdate("index-old.js","index-new.js",false)).toBe(true);
  expect(hasAppUpdate("index-old.js","index-old.js",false)).toBe(false);
  expect(hasAppUpdate("development","index-new.js",false)).toBe(false);
  expect(hasAppUpdate("index-old.js",null,true)).toBe(true);
});
it("activates only after a positive worker acknowledgement", async () => {
  const worker={postMessage: (_:unknown,ports:Transferable[]) => (ports[0] as MessagePort).postMessage({ok:true})};
  await expect(requestUpdateActivation(worker)).resolves.toBeUndefined();
});
it("propagates multi-window refusal instead of reloading", async () => {
  const worker={postMessage: (_:unknown,ports:Transferable[]) => (ports[0] as MessagePort).postMessage({ok:false,error:"请关闭其他标签页"})};
  await expect(requestUpdateActivation(worker)).rejects.toThrow("其他标签页");
});
it("does not hang forever on workers from an older release", async () => {
  await expect(requestUpdateActivation({postMessage:()=>{}},10)).rejects.toThrow(/超时/);
});
