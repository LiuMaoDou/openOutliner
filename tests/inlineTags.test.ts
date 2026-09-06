import { describe, expect, it } from "vitest";
import { consumeInlineTag, findInlineTag, inlineTagOptions } from "../src/web/inlineTags";
import type { Tag } from "../src/web/api";

describe("inline hashtag commands", () => {
  it("opens on a bare hash and supports Chinese, accents and nested tag names", () => {
    for (const query of ["", "计划", "cafe\u0301", "work/project-1"]) {
      const title = `Outline #${query}`;
      expect(findInlineTag(title, title.length)).toEqual({ start: 8, end: title.length, query });
    }
  });

  it("ignores Markdown headings, code, escaped hashes, links and nonempty selections", () => {
    for (const title of ["# Heading", "##heading", "C#", "https://site.test/#anchor", "[link](#anchor", "![image](#asset", "\\#literal", "`#code", "```ts\n#code"]) {
      expect(findInlineTag(title, title.length), title).toBeNull();
    }
    expect(findInlineTag("#selected", 0, 9)).toBeNull();
    expect(findInlineTag("`code` #tag", 11)?.query).toBe("tag");
  });

  it("consumes the whole active token without disturbing adjacent prose or other hashes", () => {
    for (const [title, caret, expected] of [
      ["Task #work", 10, "Task"],
      ["Task #work tomorrow", 10, "Task tomorrow"],
      ["#work Task", 5, "Task"],
      ["Task (#work)", 11, "Task ()"],
      ["#first text #second tail", 18, "#first text tail"]
    ] as const) {
      const trigger = findInlineTag(title, caret)!;
      expect(trigger, title).not.toBeNull();
      expect(consumeInlineTag(title, trigger).value, title).toBe(expected);
    }
    const trigger = findInlineTag("Task #planning next", 8)!;
    expect(trigger.query).toBe("pl");
    expect(consumeInlineTag("Task #planning next", trigger).value).toBe("Task next");
  });

  it("deduplicates cross-workspace suggestions, preserves custom colors, and offers creation", () => {
    const tags: Tag[] = [
      { id: "a", workspaceId: "one", name: "planning", color: "#123456", createdAt: "" },
      { id: "b", workspaceId: "two", name: "planning", color: "#123456", createdAt: "" },
      { id: "c", workspaceId: "two", name: "Read later", color: "#abcdef", createdAt: "" }
    ];
    expect(inlineTagOptions(tags, "").map(option => option.name)).toEqual(["planning", "Read later"]);
    expect(inlineTagOptions(tags, "planning")).toEqual([{ name: "planning", color: "#123456", create: false }]);
    expect(inlineTagOptions(tags, "plan")[0]).toMatchObject({ name: "plan", create: true });
    expect(inlineTagOptions(tags, "read").some(option => option.name === "Read later")).toBe(true);
    expect(inlineTagOptions(tags, "PLANNING")).toHaveLength(1);
  });
});
