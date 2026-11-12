import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type OpenOutlinerDb } from "../src/backend/db/database.js";
import { OutlinerService, ValidationError } from "../src/backend/services/outliner.js";
import { dispatch } from "../src/backend/shared/dispatch.js";
import { snapshot } from "../src/backend/shared/sync.js";

let db: OpenOutlinerDb;
let service: OutlinerService;
beforeEach(() => { db = openDatabase(":memory:"); service = new OutlinerService(db); });
afterEach(() => { vi.restoreAllMocks(); db.close(); });

describe("atomic workspace PATCH via the real dispatcher and service", () => {
  it("rejects an empty name before moving or reordering any workspace", () => {
    const workspace = service.createWorkspace("Source");
    const folder = service.createWorkspaceFolder("Destination");
    service.createWorkspace("Sibling", undefined, folder.id);
    const before = snapshot(db);
    expect(() => dispatch(service, "PATCH", `/api/workspaces/${workspace.id}`, {
      name: "   ", folderId: folder.id, position: 0
    })).toThrow(ValidationError);
    expect(snapshot(db)).toEqual(before);
  });

  it("rolls back the actual service's move if the subsequent rename fails", () => {
    const workspace = service.createWorkspace("Source");
    const folder = service.createWorkspaceFolder("Destination");
    service.createWorkspace("Sibling", undefined, folder.id);
    const before = snapshot(db);
    vi.spyOn(service, "updateWorkspace").mockImplementationOnce(() => { throw new Error("injected rename failure"); });
    expect(() => dispatch(service, "PATCH", `/api/workspaces/${workspace.id}`, {
      name: "New", folderId: folder.id, position: 0
    })).toThrow("injected rename failure");
    expect(snapshot(db)).toEqual(before);
  });

  it("commits a successful move, rename and root title change together", () => {
    const workspace = service.createWorkspace("Source");
    const folder = service.createWorkspaceFolder("Destination");
    const result = dispatch(service, "PATCH", `/api/workspaces/${workspace.id}`, {
      name: "  Renamed  ", folderId: folder.id, position: 0
    });
    expect(result).toMatchObject({ name: "Renamed", folderId: folder.id, position: 0 });
    expect(service.getNode(workspace.rootNodeId).title).toBe("Renamed");
  });

  it.each([null, [], { name: 5 }, { position: -1 }, { position: 1.5 }, { folderId: 8 }])(
    "maps invalid input %j to a validation error without writing", input => {
      const workspace = service.createWorkspace("Source");
      const before = snapshot(db);
      expect(() => dispatch(service, "PATCH", `/api/workspaces/${workspace.id}`, input)).toThrow(ValidationError);
      expect(snapshot(db)).toEqual(before);
    }
  );
});
