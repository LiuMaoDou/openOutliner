import { decodeString } from "micromark-util-decode-string";

export interface TitleHastNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: TitleHastNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

/** Map the AST leaf's rendered UTF-16 boundaries back to the exact Markdown source.
 * Parsing owns emphasis/links/nesting. Only text-token decoding happens here.
 */
export function sourceTextOffsets(raw: string, rendered: string, start: number, code = false): number[] | null {
  if (raw === rendered) return Array.from({ length: rendered.length + 1 }, (_, i) => start + i);
  let from = 0, to = raw.length;
  if (code) {
    const delimiter = raw.match(/^`+/)?.[0];
    if (!delimiter || !raw.endsWith(delimiter)) return null;
    from = delimiter.length; to -= delimiter.length;
  }
  const chars: Array<{ char: string; start: number; end: number }> = [];
  for (let i = from; i < to;) {
    const candidate = raw.slice(i, to);
    const token = !code ? candidate.match(/^(?:\\[!-/:-@\[-`{-~]|&(?:#(?:\d{1,7}|x[\da-f]{1,6})|[\da-z]{1,31});)/i)?.[0] : undefined;
    const lineEnding = candidate.match(/^\r\n?|^\n/)?.[0];
    const source = token ?? lineEnding ?? raw[i];
    const value = token ? decodeString(token) : lineEnding ? (code ? " " : "\n") : source;
    for (let j = 0; j < value.length; j++) chars.push({
      char: value[j], start: start + i + (value === source ? j : 0),
      end: start + i + (value === source ? j + 1 : source.length)
    });
    i += source.length;
  }
  let visible = chars;
  if (code && chars[0]?.char === " " && chars.at(-1)?.char === " " && chars.some(char => char.char !== " ")) {
    visible = chars.slice(1, -1);
  }
  if (!code) {
    // mdast-util-to-hast trims indentation/trailing spaces at soft line breaks.
    const text = chars.map(char => char.char).join("");
    const omitted = new Set<number>();
    for (const match of text.matchAll(/[\t ]+(?=\n)|(?<=\n)[\t ]+/g)) {
      for (let i = match.index!; i < match.index! + match[0].length; i++) omitted.add(i);
    }
    visible = chars.filter((_, index) => !omitted.has(index));
  }
  if (visible.map(char => char.char).join("") !== rendered) return null;
  return [...visible.map(char => char.start), visible.at(-1)?.end ?? start + from];
}

function textNode(value: string, offsets?: number[] | null): TitleHastNode {
  const child = { type: "text", value };
  return offsets ? { type: "element", tagName: "span", properties: { dataSourceOffsets: offsets.join(",") }, children: [child] } : child;
}

function inlineNodes(value: string, offsets?: number[] | null): TitleHastNode[] {
  const nodes: TitleHastNode[] = [];
  let cursor = 0;
  const text = (start: number, end: number) => textNode(value.slice(start, end), offsets?.slice(start, end + 1));
  while (cursor < value.length) {
    const colors = /\{\{color:(red|orange|yellow|green|blue|purple|gray)\}\}/g;
    colors.lastIndex = cursor;
    let color = colors.exec(value);
    while (color && value.indexOf("{{/color}}", color.index + color[0].length) < 0) color = colors.exec(value);
    const highlight = value.indexOf("==", cursor), endHighlight = highlight < 0 ? -1 : value.indexOf("==", highlight + 2);
    const nextColor = color?.index ?? Infinity, nextHighlight = endHighlight < 0 ? Infinity : highlight;
    const next = Math.min(nextColor, nextHighlight);
    if (!Number.isFinite(next)) { nodes.push(text(cursor, value.length)); break; }
    if (next > cursor) nodes.push(text(cursor, next));
    if (next === nextColor && color) {
      const start = color.index + color[0].length, end = value.indexOf("{{/color}}", start);
      nodes.push({ type: "element", tagName: "span", properties: { className: [`markdownTextColor-${color[1]}`] },
        children: inlineNodes(value.slice(start, end), offsets?.slice(start, end + 1)) });
      cursor = end + "{{/color}}".length;
    } else {
      nodes.push({ type: "element", tagName: "mark", properties: {},
        children: inlineNodes(value.slice(highlight + 2, endHighlight), offsets?.slice(highlight + 2, endHighlight + 1)) });
      cursor = endHighlight + 2;
    }
  }
  return nodes;
}

/** Attach source positions before sanitization; no HTML from the title is trusted. */
export function rehypeTitleFormatting() {
  return (tree: TitleHastNode, file: { value: unknown }) => {
    const source = String(file.value);
    const visit = (parent: TitleHastNode, code = false) => {
      if (!parent.children) return;
      const literal = code || parent.tagName === "code" || parent.tagName === "pre";
      parent.children = parent.children.flatMap(child => {
        if (child.type !== "text") { visit(child, literal); return [child]; }
        const start = child.position?.start.offset, end = child.position?.end.offset;
        const value = child.value ?? "";
        const offsets = start === undefined || end === undefined ? null : sourceTextOffsets(source.slice(start, end), value, start, literal);
        return literal ? [textNode(value, offsets)] : inlineNodes(value, offsets);
      });
    };
    visit(tree);
  };
}

/** A mapping is attached only to a leaf span; never guess by stripping Markdown. */
export function sourceOffsetForText(node: Node, offset: number): number | null {
  const span = node.parentElement?.closest<HTMLElement>("[data-source-offsets]");
  if (!span || span.childNodes.length !== 1 || span.firstChild !== node) return null;
  const offsets = span.dataset.sourceOffsets?.split(",").map(Number);
  if (!offsets || offsets.length !== (node.textContent?.length ?? 0) + 1 || offsets.some(value => !Number.isSafeInteger(value))) return null;
  return offsets[Math.max(0, Math.min(offset, offsets.length - 1))];
}
