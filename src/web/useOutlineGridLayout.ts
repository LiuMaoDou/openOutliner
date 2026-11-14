import { useLayoutEffect, useState, type RefObject } from "react";
import { DEFAULT_OUTLINE_GRID_STEP, layoutRuledNode, resolveOutlineGridStep } from "./outlineGrid";

export interface OutlineGridMetrics { step: number; revision: number }

/** Invalidate virtual measurements on width, breakpoint or font changes, not on scroll. */
export function useOutlineGridMetrics(
  listRef: RefObject<HTMLDivElement | null>, enabled: boolean, workspaceId: string
): OutlineGridMetrics {
  const [metrics, setMetrics] = useState<OutlineGridMetrics>({ step: DEFAULT_OUTLINE_GRID_STEP, revision: 0 });
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!enabled || !list) return;
    let width = -1;
    let lastStep = -1;
    let disposed = false;
    let frame = 0;
    const measure = (force = false) => {
      if (disposed) return;
      const nextWidth = list.getBoundingClientRect().width;
      const step = resolveOutlineGridStep(getComputedStyle(list).getPropertyValue("--outline-grid-step"));
      if (!force && Math.abs(nextWidth - width) < 0.01 && step === lastStep) return;
      width = nextWidth;
      lastStep = step;
      setMetrics(current => ({ step, revision: current.revision + 1 }));
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => measure());
    };
    const fontsChanged = () => measure(true);
    measure();
    const observer = new ResizeObserver(schedule);
    observer.observe(list);
    window.addEventListener("resize", schedule);
    document.fonts.addEventListener("loadingdone", fontsChanged);
    void document.fonts.ready.then(() => { if (!disposed) measure(true); });
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      document.fonts.removeEventListener("loadingdone", fontsChanged);
    };
  }, [enabled, listRef, workspaceId]);
  return metrics;
}

/** Only mounted rows are observed; no document-wide scans or per-scroll measurements. */
export function useRuledNodeLayout(
  rowRef: RefObject<HTMLDivElement | null>, metrics: OutlineGridMetrics, title: string, tags: unknown
): void {
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    let frame = 0;
    const measure = () => layoutRuledNode(row, metrics.step);
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    measure();
    const observer = new ResizeObserver(schedule);
    observer.observe(row);
    for (const child of row.querySelectorAll(".nodeTitleCell, .nodeTitlePreview, .nodeTags")) observer.observe(child);
    // Focus changes which title representation participates in layout. Never remount the editor.
    row.addEventListener("focusin", schedule);
    row.addEventListener("focusout", schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      row.removeEventListener("focusin", schedule);
      row.removeEventListener("focusout", schedule);
    };
  }, [metrics.step, rowRef]);
  useLayoutEffect(() => {
    if (rowRef.current) layoutRuledNode(rowRef.current, metrics.step);
  }, [metrics, rowRef, title, tags]);
}
