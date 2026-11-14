import { describe, expect, it } from "vitest";
import { outlineGridHeight, resolveOutlineGridStep } from "../src/web/outlineGrid";

describe("ruled outline geometry", () => {
  it.each([[0, 32], [20, 32], [32, 32], [32.001, 32], [32.1, 64], [63.9, 64], [64, 64], [97, 128]])(
    "snaps natural height %s without accumulating fractional offsets", (height, expected) => {
      expect(outlineGridHeight(height, 32)).toBe(expected);
    }
  );
  it("shrinks from multiple rows and supports touch-size grid units", () => {
    expect([126, 84, 42].map(height => outlineGridHeight(height, 42))).toEqual([126, 84, 42]);
    expect(outlineGridHeight(43, 42)).toBe(84);
  });
  it.each([0, -1, NaN, Infinity])("rejects an invalid grid step %s", step => {
    expect(() => outlineGridHeight(32, step)).toThrow(RangeError);
  });
  it.each([NaN, Infinity, -10])("keeps an empty or invalid content height %s safe", height => {
    expect(outlineGridHeight(height, 32)).toBe(32);
  });
  it("reads the CSS unit and has a deterministic pre-layout fallback", () => {
    expect(resolveOutlineGridStep(" 42px ")).toBe(42);
    for (const value of ["", "auto", "-1px", "0px", "Infinity"]) expect(resolveOutlineGridStep(value)).toBe(32);
  });
});
