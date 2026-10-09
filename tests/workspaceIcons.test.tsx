import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FolderTree } from "lucide-react";
import { iconNames } from "lucide-react/dynamic";
import { expect, it } from "vitest";
import { WorkspaceIcon, workspaceIconNames } from "../src/web/workspaceIcons";

it("bundles every supported workspace icon, including legacy aliases", () => {
  expect(new Set(workspaceIconNames)).toEqual(new Set(iconNames));
  for (const name of iconNames) {
    expect(renderToStaticMarkup(createElement(WorkspaceIcon, { name }))).toContain("<svg");
  }
});

it("renders previously uncached icons synchronously with distinct SVG paths", () => {
  const rendered = ["file-badge", "rectangle-ellipsis", "view"].map(name =>
    renderToStaticMarkup(createElement(WorkspaceIcon, { name, size: 15, strokeWidth: 2.2 }))
  );
  expect(new Set(rendered).size).toBe(3);
  for (const svg of rendered) {
    expect(svg).not.toContain("lucide-folder-tree");
    expect(svg).toContain('width="15"');
    expect(svg).toContain('stroke-width="2.2"');
  }
});

it("preserves aliases and uses the default only for unknown icon names", () => {
  const render = (name: string) => renderToStaticMarkup(createElement(WorkspaceIcon, { name }));
  expect(render("fingerprint")).toBe(render("fingerprint-pattern"));
  expect(render("axis-3-d")).toBe(render("axis-3d"));
  expect(render("file-x-2")).toBe(render("file-x-corner"));
  expect(render("unknown-workspace-icon")).toBe(renderToStaticMarkup(createElement(FolderTree)));
});
