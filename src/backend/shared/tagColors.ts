export const morandiTagColors = [
  "#A66F6F",
  "#A97B65",
  "#A68D63",
  "#8C8A68",
  "#788B72",
  "#6F8C7C",
  "#678B89",
  "#6E8797",
  "#71809A",
  "#797A9A",
  "#927892",
  "#A67885"
] as const;
const legacyTagColors = new Set(["#266dd3", "#2a9d8f", "#c2410c", "#7c3aed", "#0f766e", "#be123c"]);

export function tagColorForName(value: string): string {
  const normalized = value.trim().replace(/^#/, "");
  return morandiTagColors[(hash(normalized) >>> 0) % morandiTagColors.length];
}

export function resolveTagColor(tag: { name: string; color: string }): string {
  return legacyTagColors.has(tag.color.toLowerCase()) ? tagColorForName(tag.name) : tag.color;
}

function hash(value: string): number {
  let result = 5381;
  for (let index = 0; index < value.length; index += 1) {
    result = Math.imul(result, 33) ^ value.charCodeAt(index);
  }
  result ^= result >>> 16;
  result = Math.imul(result, 0x85ebca6b);
  result ^= result >>> 13;
  return result;
}

