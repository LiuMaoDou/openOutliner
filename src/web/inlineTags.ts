import type { Tag } from "./api";
import { resolveTagColor, tagColorForName } from "../backend/shared/tagColors";

export interface InlineTagTrigger {
  start: number;
  end: number;
  query: string;
}

export interface InlineTagOption {
  name: string;
  color: string;
  create: boolean;
}

const tagCharacter = /[\p{L}\p{M}\p{N}_/-]/u;

export function findInlineTag(value: string, selectionStart: number, selectionEnd = selectionStart): InlineTagTrigger | null {
  if (selectionStart !== selectionEnd) return null;
  const prefix = value.slice(0, selectionStart);
  const match = /(?:^|[\s(\[{（【])#([\p{L}\p{M}\p{N}_/-]*)$/u.exec(prefix);
  if (!match) return null;
  const start = selectionStart - match[1].length - 1;
  const before = value.slice(0, start);
  // A hash in code or a Markdown link destination is ordinary text.
  let codeDelimiter = 0;
  for (const ticks of before.match(/`+/g) ?? []) {
    if (!codeDelimiter) codeDelimiter = ticks.length;
    else if (ticks.length === codeDelimiter) codeDelimiter = 0;
  }
  if (codeDelimiter || /!?\[[^\]\n]*\]\([^\)\n]*$/.test(before)) return null;
  let end = selectionStart;
  while (end < value.length) {
    const character = String.fromCodePoint(value.codePointAt(end)!);
    if (!tagCharacter.test(character)) break;
    end += character.length;
  }
  return { start, end, query: match[1] };
}

export function inlineTagOptions(tags: readonly Tag[], query: string): InlineTagOption[] {
  const normalized = query.toLocaleLowerCase();
  const byName = new Map<string, Tag>();
  for (const tag of tags) if (!byName.has(tag.name)) byName.set(tag.name, tag);
  const matches = [...byName.values()]
    .filter(tag => tag.name.toLocaleLowerCase().includes(normalized))
    .sort((left, right) => {
      const leftName = left.name.toLocaleLowerCase();
      const rightName = right.name.toLocaleLowerCase();
      return Number(rightName === normalized) - Number(leftName === normalized)
        || Number(rightName.startsWith(normalized)) - Number(leftName.startsWith(normalized))
        || left.name.localeCompare(right.name);
    })
    .map(tag => ({ name: tag.name, color: resolveTagColor(tag), create: false }));
  if (query && !matches.some(tag => tag.name.toLocaleLowerCase() === normalized)) {
    matches.unshift({ name: query, color: tagColorForName(query), create: true });
  }
  return matches.slice(0, 8);
}

export function consumeInlineTag(value: string, trigger: InlineTagTrigger) {
  let { start, end } = trigger;
  // Remove only the separator made redundant by consuming this token.
  if (value[start - 1] === " " && (end === value.length || value[end] === " ")) start--;
  else if (start === 0 && value[end] === " ") end++;
  return {
    value: value.slice(0, start) + value.slice(end),
    selectionStart: start,
    removed: value.slice(start, end)
  };
}
