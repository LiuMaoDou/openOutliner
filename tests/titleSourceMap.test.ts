import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { rehypeTitleFormatting, sourceTextOffsets, type TitleHastNode } from "../src/web/titleSourceMap";
const schema = { ...defaultSchema, tagNames: [...defaultSchema.tagNames!, "span", "mark"], attributes: {
  ...defaultSchema.attributes, span: [["dataSourceOffsets", /^[0-9,]+$/], ["className", /^markdownTextColor-/]]
} };
function leaves(source: string) {
  const result: Array<{text: string; offsets: number[]}> = [];
  const inspect = () => (tree: TitleHastNode) => {
    const walk = (node: TitleHastNode) => {
      if (node.properties?.dataSourceOffsets) result.push({text: node.children?.[0]?.value ?? "", offsets: String(node.properties.dataSourceOffsets).split(",").map(Number)});
      node.children?.forEach(walk);
    }; walk(tree);
  };
  const literalHtml = () => (tree: TitleHastNode) => {
    const visit = (node: TitleHastNode) => { if (node.type === "html") node.type = "text"; node.children?.forEach(visit); }; visit(tree);
  };
  renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm, literalHtml], rehypePlugins: [rehypeTitleFormatting, [rehypeSanitize, schema], inspect], children: source }));
  return result;
}
describe("source coordinates through the actual Markdown pipeline", () => {
  it.each([
    ["Hello world", "world", 6], ["**Hello** world", "world", 10], ["**Hello** world", "Hello", 2],
    ["See [docs](https://example.com) next", "next", 32], ["See [docs](https://example.com) next", "docs", 5],
    ["{{color:red}}Title{{/color}} tail", "tail", 29], ["{{color:red}}Title{{/color}} tail", "Title", 13],
    ["==Hi== tail", "Hi", 2], ["**A *B* C** tail", "B", 5],
    ["Escaped \\*word\\* next", "word", 10], ["A &amp; B", "B", 8],
    ["`a &amp; b` end", "a", 1], ["` a b ` end", "a", 2], ["`\r\na\r\n`", "a", 3],
    ["first  \nsecond", "second", 8], ["x\n  second", "second", 4],
    ["**😀中文** tail", "中文", 4], ["<b>literal</b> tail", "literal", 3]
  ])("maps %s / %s back to source offset %i", (source, text, expected) => {
    const leaf=leaves(source).find(item => item.text.includes(text));
    expect(leaf, JSON.stringify(leaves(source))).toBeDefined();
    expect(leaf!.offsets[leaf!.text.indexOf(text)]).toBe(expected);
  });
  it("keeps named/numeric entity and surrogate-pair boundaries valid", () => {
    const leaf=leaves("A &#x1F600; &copy; Z")[0];
    expect(leaf.text).toBe("A 😀 © Z");
    expect(leaf.offsets[2]).toBe(2); expect(leaf.offsets[4]).toBe(11);
    expect(leaf.offsets[leaf.text.indexOf("Z")]).toBe(19);
  });
  it("does not interpret formatting markers inside code", () => {
    const leaf=leaves("`{{color:red}}a{{/color}} ==b==`")[0];
    expect(leaf.text).toBe("{{color:red}}a{{/color}} ==b=="); expect(leaf.offsets[0]).toBe(1);
  });
  it("does not manufacture a mapping for an unknown transformation", () => {
    expect(sourceTextOffsets("abc", "changed", 0)).toBeNull();
  });
});
