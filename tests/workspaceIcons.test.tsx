import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { WorkspaceTreeIcon } from "../src/web/workspaceIcons";

it.each([
  [false, false, "file-text"],
  [false, true, "file-text"],
  [true, false, "folder-open"],
  [true, true, "folder-closed"]
])("renders the workspace icon for children=%s and collapsed=%s", (hasChildren, collapsed, icon) => {
  const markup = renderToStaticMarkup(createElement(WorkspaceTreeIcon, { hasChildren, collapsed }));
  expect(markup).toContain(`lucide-${icon}`);
  expect(markup).toContain('aria-hidden="true"');
});
