import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

  it("updates and deletes workspaces", () => {
    const workspace = service.createWorkspace("Draft", "rocket");
    const renamed = service.updateWorkspace(workspace.id, { name: "Personal" });

    expect(workspace.icon).toBe("rocket");
    expect(renamed.name).toBe("Personal");
    expect(renamed.icon).toBe("rocket");
    expect(service.getNode(workspace.rootNodeId).title).toBe("Personal");

    service.deleteWorkspace(workspace.id);

    expect(service.listWorkspaces()).toEqual([]);
  });

  it("updates and deletes tags", () => {
    const workspace = service.createWorkspace("Tags");
    const node = service.createNode({ parentId: workspace.rootNodeId, title: "Tagged" });
    const tag = service.setNodeTag(node.id, "project");
    const renamed = service.updateTag(tag.id, { name: "area" });

    expect(renamed.name).toBe("area");
    expect(service.getTree(workspace.rootNodeId).children[0].tags[0].name).toBe("area");

    service.deleteTag(tag.id);

    expect(service.getTree(workspace.rootNodeId).children[0].tags).toEqual([]);
  });

  it("migrates older workspaces with default icons", () => {
    const dbPath = join(tempDir, "old.sqlite");
    const oldDb = new DatabaseSync(dbPath);
    oldDb.exec(`
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_node_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO workspaces (id, name, root_node_id, created_at, updated_at)
      VALUES ('workspace', 'Old', 'root', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    `);
    oldDb.close();

    const migratedDb = openDatabase(dbPath);
    try {
      const migratedService = new OutlinerService(migratedDb);
      expect(migratedService.listWorkspaces()[0].icon).toBe("folder-tree");
    } finally {
      migratedDb.close();
    }
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

  it("imports OPML into a new workspace and skips empty wrapper outlines", () => {
    const result = importOpml(service, {
      content: [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<opml version="2.0">',
        "<head><title>Study</title></head>",
        "<body>",
        '<outline text="万卷书" done="false">',
        '<outline text="了凡四训" done="false"/>',
        '<outline text="数学之美" done="false"/>',
        "</outline>",
        '<outline text="O R&apos;eilly" done="false"/>',
        '<outline text="AI" done="false">',
        '<outline text="" done="false">',
        '<outline text="AI变现" done="false">',
        '<outline text="OpenOutliner" done="false"/>',
        "</outline>",
        "</outline>",
        "</outline>",
        '<outline text="" done="false"/>',
        "</body>",
        "</opml>"
      ].join("")
    });

    const workspace = service.getWorkspace(result.workspaceId);
    const tree = service.getTree(workspace.rootNodeId);
    const ai = tree.children.find(node => node.title === "AI");

    expect(workspace.name).toBe("Study");
    expect(result.imported).toBe(7);
    expect(tree.children.map(node => node.title)).toEqual(["万卷书", "O R'eilly", "AI"]);
    expect(ai?.children[0].title).toBe("AI变现");
    expect(ai?.children[0].children[0].title).toBe("OpenOutliner");
  });
});
