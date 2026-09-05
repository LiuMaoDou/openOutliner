import { exportMarkdown, importMarkdown } from "../importExport/markdown.js";
import { exportOpml, importOpml } from "../importExport/opml.js";
import { NotFoundError, OutlinerService, ValidationError } from "../services/outliner.js";

// The same routes run against native SQLite and the browser database.
export function dispatch(service: OutlinerService, method: string, address: string, input: any = {}): any {
  const url = new URL(address, "http://localhost");
  const path = url.pathname;
  if (method === "GET" && path === "/api/health") {
    return json( { ok: true });
    return;
  }

  if (method === "GET" && path === "/api/workspaces") {
    return json( service.listWorkspaces());
    return;
  }

  if (method === "GET" && path === "/api/workspace-folders") {
    return json( service.listWorkspaceFolders());
    return;
  }

  if (method === "POST" && path === "/api/workspace-folders") {
    const body = input;
    return json( service.createWorkspaceFolder(body.name ?? "New Folder"), 201);
    return;
  }

  const workspaceFolderMatch = path.match(/^\/api\/workspace-folders\/([^/]+)$/);
  if (method === "PATCH" && workspaceFolderMatch) {
    return json( service.updateWorkspaceFolder(workspaceFolderMatch[1], input));
    return;
  }
  if (method === "DELETE" && workspaceFolderMatch) {
    return json( service.deleteWorkspaceFolder(workspaceFolderMatch[1]));
    return;
  }

  if (method === "POST" && path === "/api/workspaces") {
    const body = input;
    return json(
      service.createWorkspace(body.name?.trim() || "Untitled Workspace", body.icon, body.folderId, body.parentWorkspaceId),
      201
    );
    return;
  }

  const workspaceTreeMatch = path.match(/^\/api\/workspaces\/([^/]+)\/tree$/);
  if (method === "GET" && workspaceTreeMatch) {
    const workspace = service.getWorkspace(workspaceTreeMatch[1]);
    return json( service.getTree(workspace.rootNodeId));
    return;
  }

  const workspaceHistoryMatch = path.match(/^\/api\/workspaces\/([^/]+)\/history$/);
  if (method === "GET" && workspaceHistoryMatch) {
    return json( service.getOutlineHistoryState(workspaceHistoryMatch[1]));
    return;
  }

  const workspaceHistoryActionMatch = path.match(/^\/api\/workspaces\/([^/]+)\/(undo|redo)$/);
  if (method === "POST" && workspaceHistoryActionMatch) {
    return json(
      workspaceHistoryActionMatch[2] === "undo"
        ? service.undoOutline(workspaceHistoryActionMatch[1])
        : service.redoOutline(workspaceHistoryActionMatch[1])
    );
    return;
  }

  const workspaceMatch = path.match(/^\/api\/workspaces\/([^/]+)$/);
  if (method === "PATCH" && workspaceMatch) {
    const body = input;
    if (body.folderId !== undefined || body.parentWorkspaceId !== undefined || body.position !== undefined) {
      const current = service.getWorkspace(workspaceMatch[1]);
      const moved = service.moveWorkspace(
        workspaceMatch[1],
        body.folderId !== undefined ? body.folderId : current.folderId,
        body.position ?? Number.MAX_SAFE_INTEGER,
        body.parentWorkspaceId !== undefined ? body.parentWorkspaceId : current.parentWorkspaceId
      );
      return json( body.name !== undefined ? service.updateWorkspace(moved.id, { name: body.name }) : moved);
      return;
    }
    return json( service.updateWorkspace(workspaceMatch[1], body));
    return;
  }
  if (method === "DELETE" && workspaceMatch) {
    return json( service.deleteWorkspace(workspaceMatch[1]));
    return;
  }

  const nodeChildrenMatch = path.match(/^\/api\/nodes\/([^/]+)\/children$/);
  if (method === "GET" && nodeChildrenMatch) {
    return json( service.listChildren(nodeChildrenMatch[1]));
    return;
  }

  const nodeMatch = path.match(/^\/api\/nodes\/([^/]+)$/);
  if (method === "GET" && nodeMatch) {
    return json( service.getNode(nodeMatch[1]));
    return;
  }
  if (method === "PATCH" && nodeMatch) {
    return json( service.updateNode(nodeMatch[1], input));
    return;
  }
  if (method === "DELETE" && nodeMatch) {
    return json( service.deleteNode(nodeMatch[1]));
    return;
  }

  if (method === "POST" && path === "/api/nodes") {
    return json( service.createNode(input), 201);
    return;
  }

  if (method === "POST" && path === "/api/nodes/delete-batch") {
    const body = input;
    return json( service.deleteNodes(body.ids ?? []));
    return;
  }

  const convertNodeToWorkspaceMatch = path.match(/^\/api\/nodes\/([^/]+)\/convert-to-workspace$/);
  if (method === "POST" && convertNodeToWorkspaceMatch) {
    const body = input;
    return json( service.convertNodeToWorkspace(convertNodeToWorkspaceMatch[1], body.name), 201);
    return;
  }

  const restoreMatch = path.match(/^\/api\/nodes\/([^/]+)\/restore$/);
  if (method === "POST" && restoreMatch) {
    return json( service.restoreNode(restoreMatch[1]));
    return;
  }

  if (method === "POST" && path === "/api/nodes/move-batch") {
    const body = input;
    return json( service.moveNodes(body.ids ?? [], body.parentId, body.position, body.expandParent));
    return;
  }

  if (method === "POST" && path === "/api/nodes/move-to-workspace") {
    const body = input;
    return json( service.moveNodesToWorkspace(body.ids ?? [], body.workspaceId));
    return;
  }

  const moveMatch = path.match(/^\/api\/nodes\/([^/]+)\/move$/);
  if (method === "POST" && moveMatch) {
    const body = input;
    return json( service.moveNode(moveMatch[1], body.parentId, body.position));
    return;
  }

  if (method === "GET" && path === "/api/search") {
    return json(
      service.searchNodes(url.searchParams.get("q") ?? "", url.searchParams.get("workspaceId") ?? undefined)
    );
    return;
  }

  if (method === "GET" && path === "/api/tags") {
    const workspaceId = requiredParam(url, "workspaceId");
    return json( service.listTags(workspaceId));
    return;
  }

  if (method === "GET" && path === "/api/tag-results") {
    return json( service.listNodesByTagName(requiredParam(url, "name")));
    return;
  }

  if (method === "GET" && path === "/api/system/tag-tree") {
    return json( service.listTaggedNodeGroups());
    return;
  }

  if (method === "POST" && path === "/api/tags") {
    const body = input;
    return json( service.createTag(body.workspaceId, body.name, body.color), 201);
    return;
  }

  const tagMatch = path.match(/^\/api\/tags\/([^/]+)$/);
  if (method === "PATCH" && tagMatch) {
    return json( service.updateTag(tagMatch[1], input));
    return;
  }
  if (method === "DELETE" && tagMatch) {
    return json( service.deleteTag(tagMatch[1]));
    return;
  }

  const nodeTagsMatch = path.match(/^\/api\/nodes\/([^/]+)\/tags$/);
  if (method === "POST" && nodeTagsMatch) {
    const body = input;
    return json( service.setNodeTag(nodeTagsMatch[1], body.name), 201);
    return;
  }

  const nodeTagMatch = path.match(/^\/api\/nodes\/([^/]+)\/tags\/([^/]+)$/);
  if (method === "DELETE" && nodeTagMatch) {
    service.getNode(nodeTagMatch[1]);
    service.removeNodeTag(nodeTagMatch[1], nodeTagMatch[2]);
    return json({ removed: nodeTagMatch[2] });
  }

  if (method === "GET" && path === "/api/fields") {
    return json( service.listFieldDefinitions(requiredParam(url, "workspaceId")));
    return;
  }

  if (method === "POST" && path === "/api/fields") {
    return json( service.createFieldDefinition(input), 201);
    return;
  }

  if (method === "POST" && path === "/api/field-values") {
    const body = input;
    return json( service.setFieldValue(body.nodeId, body.fieldId, body.value), 201);
    return;
  }

  if (method === "POST" && path === "/api/import/markdown") {
    const body = input;
    return json( importMarkdown(service, body));
    return;
  }

  if (method === "GET" && path === "/api/export/markdown") {
    return exportMarkdown(service, url.searchParams.get("workspaceId") ?? undefined);
    return;
  }

  if (method === "POST" && path === "/api/import/opml") {
    const body = input;
    return json( importOpml(service, body));
    return;
  }

  if (method === "GET" && path === "/api/export/opml") {
    return exportOpml(service, url.searchParams.get("workspaceId") ?? undefined);
    return;
  }

  throw new NotFoundError(`Route not found: ${method} ${path}`);
}
function json<T>(value: T, _status?: number): T { return value; }
function requiredParam(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (!value) throw new ValidationError(`Missing required query param: ${name}`);
  return value;
}

