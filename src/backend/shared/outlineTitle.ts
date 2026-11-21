// A blank line makes this a Markdown block while preserving literal titles like "---".
const DIVIDER_SUFFIX = "\n\n---";

export function splitOutlineTitle(title: string): { text: string; hasDivider: boolean } {
  const hasDivider = title.endsWith(DIVIDER_SUFFIX);
  return { text: hasDivider ? title.slice(0, -DIVIDER_SUFFIX.length) : title, hasDivider };
}

export function formatOutlineTitle(text: string, hasDivider: boolean): string {
  return hasDivider ? text + DIVIDER_SUFFIX : text;
}

export function outlineTitleLabel(title: string): string {
  return splitOutlineTitle(title).text || "Untitled";
}

export function splitOutlineLines(title: string): string[] {
  return splitOutlineTitle(title).text.split(/\r\n?|\n/).map(line => line.trim()).filter(Boolean);
}

export function canAddOutlineDivider(title: string, body: string, hasChildren: boolean): boolean {
  const { text, hasDivider } = splitOutlineTitle(title);
  return !hasDivider && !text.trim() && !body.trim() && !hasChildren;
}
