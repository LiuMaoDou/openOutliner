/** Shared geometry for the ruled outline. Values are CSS pixels, not device pixels. */
export const DEFAULT_OUTLINE_GRID_STEP = 32;

export function resolveOutlineGridStep(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_OUTLINE_GRID_STEP;
}

export function outlineGridHeight(height: number, step: number): number {
  if (!Number.isFinite(step) || step <= 0) throw new RangeError("Grid step must be positive and finite");
  if (!Number.isFinite(height) || height <= 0) return step;
  // Ignore only numerical layout noise, never a visible fraction of a row.
  return Math.max(1, Math.ceil((height - 0.01) / step)) * step;
}

export function resizeRuledTitle(input: HTMLTextAreaElement): boolean {
  if (!input.closest(".outlineList--ruled")) return false;
  const step = resolveOutlineGridStep(getComputedStyle(input).getPropertyValue("--outline-grid-step"));
  input.style.height = "auto";
  input.style.height = `${outlineGridHeight(input.scrollHeight, step)}px`;
  return true;
}

/** Measure natural children, not the row's previous minimum, so shrinking works. */
export function layoutRuledNode(row: HTMLElement, step: number): void {
  if (!row.closest(".outlineList--ruled")) return;
  const input = row.querySelector<HTMLTextAreaElement>(".nodeTitle");
  if (input && document.activeElement === input) resizeRuledTitle(input);
  const top = row.getBoundingClientRect().top;
  let naturalHeight = step;
  for (const child of row.children) {
    if (!(child instanceof HTMLElement)) continue;
    const style = getComputedStyle(child);
    if (style.display === "none" || style.position === "absolute" || style.position === "fixed") continue;
    naturalHeight = Math.max(naturalHeight, child.getBoundingClientRect().bottom - top + (Number.parseFloat(style.marginBottom) || 0));
  }
  const height = `${outlineGridHeight(naturalHeight, step)}px`;
  if (row.style.getPropertyValue("--outline-row-min-height") !== height) {
    row.style.setProperty("--outline-row-min-height", height);
  }
}
