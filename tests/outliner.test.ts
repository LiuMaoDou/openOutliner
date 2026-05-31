import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type OpenOutlinerDb } from "../src/backend/db/database.js";
import { exportMarkdown, importMarkdown } from "../src/backend/importExport/markdown.js";
import { exportOpml, importOpml } from "../src/backend/importExport/opml.js";
import { OutlinerService } from "../src/backend/services/outliner.js";

let tempDir = "";
let db: OpenOutlinerDb;
let service: OutlinerService;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "openoutliner-test-"));
  db = openDatabase(join(tempDir, "test.sqlite"));
  service = new OutlinerService(db);
});

afterEach(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("OutlinerService", () => {
  it("creates and moves nodes while preserving sibling order", () => {
    const workspace = service.createWorkspace("Test");
    const alpha = service.createNode({ parentId: workspace.rootNodeId, title: "Alpha" });
    const beta = service.createNode({ parentId: workspace.rootNodeId, title: "Beta" });
    const gamma = service.createNode({ parentId: workspace.rootNodeId, title: "Gamma" });

    service.moveNode(gamma.id, workspace.rootNodeId, 0);
    service.moveNode(beta.id, alpha.id, 0);

    expect(service.listChildren(workspace.rootNodeId).map(node => node.title)).toEqual(["Gamma", "Alpha"]);
    expect(service.listChildren(alpha.id).map(node => node.title)).toEqual(["Beta"]);
  });

  it("attaches tags and field values to tree nodes", () => {
    const workspace = service.createWorkspace("Fields");
    const node = service.createNode({ parentId: workspace.rootNodeId, title: "Project" });
    const tag = service.setNodeTag(node.id, "project");
    const field = service.createFieldDefinition({
      workspaceId: workspace.id,
      tagId: tag.id,
      name: "Status",
      type: "select",
      options: "todo,doing,done"
    });

    service.setFieldValue(node.id, field.id, "doing");
    const tree = service.getTree(workspace.rootNodeId);

    expect(tree.children[0].tags[0].name).toBe("project");
    expect(tree.children[0].fieldValues[0].value).toBe("doing");
  });
});

describe("import/export", () => {
  it("round-trips Markdown hierarchy", () => {
    const workspace = service.createWorkspace("Markdown");

    importMarkdown(service, {
      workspaceId: workspace.id,
      content: ["- Alpha", "  - Beta", "- [x] Gamma"].join("\n")
    });

    const exported = exportMarkdown(service, workspace.id);

    expect(exported).toContain("- Alpha");
    expect(exported).toContain("  - Beta");
    expect(exported).toContain("- [x] Gamma");
  });

  it("imports and exports OPML hierarchy", () => {
    const workspace = service.createWorkspace("OPML");

    importOpml(service, {
      workspaceId: workspace.id,
      content:
        '<opml version="2.0"><body><outline text="Alpha"><outline text="Beta" /></outline></body></opml>'
    });

    const root = service.getTree(workspace.rootNodeId);
    const exported = exportOpml(service, workspace.id);

    expect(root.children[0].children[0].title).toBe("Beta");
    expect(exported).toContain('text="Alpha"');
    expect(exported).toContain('text="Beta"');
  });
});
