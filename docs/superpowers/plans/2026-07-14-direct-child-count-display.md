# Direct Child Count Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Display a muted `N 个子项` label beside outline items that have direct children.

**Architecture:** Derive the label from the existing normalized tree node's `childIds.length` in the outline row. Render it only when the count is positive and style it with the app's existing muted color token, requiring no API or state-shape changes.

**Tech Stack:** React 19, TypeScript, Vite, Vitest, CSS.

## Global Constraints

- Count direct children only; exclude all descendants.
- Render no label for nodes whose direct-child count is `0`.
- Use the exact Chinese copy `N 个子项` and a muted visual treatment.
- Keep the change local to the web UI; do not add API fields or persistence.

---

## File Structure

- Modify: `src/web/App.tsx` — expose a small label helper and render the label in `OutlineRow`.
- Modify: `src/web/styles.css` — add the muted count label styling adjacent to the title and tags.
- Modify: `tests/outliner.test.ts` — cover label creation for a positive direct-child count and omission for zero.

### Task 1: Derive and Render the Direct-Child Label

**Files:**
- Modify: `tests/outliner.test.ts:13-20, after workspace folder collapse tests`
- Modify: `src/web/App.tsx:around OutlineRow rendering`
- Modify: `src/web/styles.css:around .nodeTags`

**Interfaces:**
- Consumes: `FlatNodeData.childIds: string[]` from `src/web/flatTree.ts`.
- Produces: `getChildCountLabel(childCount: number): string | null` from `src/web/App.tsx`.

- [ ] **Step 1: Write the failing test**

```ts
describe("direct child count label", () => {
  it("returns a label only for nodes with direct children", () => {
    expect(getChildCountLabel(3)).toBe("3 个子项");
    expect(getChildCountLabel(0)).toBeNull();
  });
});
```

Add `getChildCountLabel` to the existing imports from `../src/web/App.js`.

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk npm test -- tests/outliner.test.ts`

Expected: FAIL because `getChildCountLabel` is not exported from `src/web/App.tsx`.

- [ ] **Step 3: Write minimal implementation**

```ts
export function getChildCountLabel(childCount: number): string | null {
  return childCount > 0 ? `${childCount} 个子项` : null;
}
```

Inside `OutlineRow`, derive `const childCountLabel = getChildCountLabel(node.childIds.length)` and render it before `.nodeTags`:

```tsx
{childCountLabel ? <span className="nodeChildCount">{childCountLabel}</span> : null}
```

Add styling that preserves the row layout and makes the text muted:

```css
.nodeChildCount {
  color: var(--muted-foreground);
  font-size: 0.76rem;
  white-space: nowrap;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `rtk npm test -- tests/outliner.test.ts`

Expected: PASS, including the new direct-child count label case.

- [ ] **Step 5: Run full validation**

Run: `rtk npm test && rtk npm run typecheck`

Expected: both commands exit with code `0`.

- [ ] **Step 6: Review and commit**

Run: `rtk git diff --check && rtk git diff -- src/web/App.tsx src/web/styles.css tests/outliner.test.ts`

Then:

```bash
rtk git add src/web/App.tsx src/web/styles.css tests/outliner.test.ts
rtk git commit -m "feat: show direct child counts"
```
