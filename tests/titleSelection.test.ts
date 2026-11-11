import { describe, expect, it } from "vitest";
import { getNodeSelectionRange, getTitleDragSelectionMode } from "../src/web/App.js";

describe("title pointer drag selection", () => {
  it("keeps single-row text selection even for a long horizontal or wrapped-line drag", () => {
    expect(getTitleDragSelectionMode("text", "a", "a", 120)).toBe("text");
    expect(getTitleDragSelectionMode("text", "a", undefined, 120)).toBe("text");
  });

  it("switches to multi-row mode only after the pointer enters a different row", () => {
    expect(getTitleDragSelectionMode("text", "a", "b", 4)).toBe("text");
    expect(getTitleDragSelectionMode("text", "a", "b", 5)).toBe("nodes");
  });

  it("does not revert to text mode once multi-row selection has started", () => {
    expect(getTitleDragSelectionMode("nodes", "a", "a", 10)).toBe("nodes");
    expect(getTitleDragSelectionMode("nodes", "a", undefined, 200)).toBe("nodes");
  });

  it("preserves inclusive, ordered ranges for forward and reverse multi-row drags", () => {
    const ids = ["a", "b", "c", "d"];
    expect(getNodeSelectionRange(ids, "a", "c")).toEqual(["a", "b", "c"]);
    expect(getNodeSelectionRange(ids, "d", "b")).toEqual(["b", "c", "d"]);
  });

  it("does not accidentally select an unrelated or non-visible target", () => {
    expect(getNodeSelectionRange(["a", "b", "c"], "a", "hidden")).toEqual([]);
    expect(getNodeSelectionRange(["a", "b", "c"], "a", "a")).toEqual(["a"]);
  });
});
