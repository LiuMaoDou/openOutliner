import { exportMarkdown, importMarkdown } from "../importExport/markdown.js";
import { exportOpml, importOpml } from "../importExport/opml.js";
import { NotFoundError, OutlinerService, ValidationError } from "../services/outliner.js";

// The same routes run against native SQLite and the browser database.
export function dispatch(service: OutlinerService, method: string, address: string, input: any = {}): any {
  const url = new URL(address, "http://localhost");
  const path = url.pathname;
  if (method === "GET" && path === "/api/health") {
    return { ok: true };
  }

  if (method === "GET" && path === "/api/workspaces") {
    return service.listWorkspaces();
  }

  if (method === "GET" && path === "/api/due-reminders") {
    return service.listDueReminderNodes(url.searchParams.get("cutoff") ?? "");
  }

  if (method === "GET" && path === "/api/recycle-bin") {
    return service.listRecycleBin();
  }

  if (method === "DELETE" && path === "/api/recycle-bin") {
    return service.emptyRecycleBin();
  }

  if (method === "GET" && path === "/api/workspace-folders") {
    return service.listWorkspaceFolders();
  }

  if (method === "POST" && path === "/api/workspace-folders") {
    const body = input;
    return service.createWorkspaceFolder(body.name ?? "New Folder");
  }

  const workspaceFolderMatch = path.match(/^\/api\/workspace-folders\/([^/]+)$/);
  if (method === "PATCH" && workspaceFolderMatch) {
    return service.updateWorkspaceFolder(workspaceFolderMatch[1], input);
  }
  if (method === "DELETE" && workspaceFolderMatch) {
    return service.deleteWorkspaceFolder(workspaceFolderMatch[1]);
  }

  if (method === "POST" && path === "/api/workspaces") {
    const body = input;
    return service.createWorkspace(body.name?.trim() || "Untitled Workspace", body.icon, body.folderId, body.parentWorkspaceId);
  }

  const workspaceTreeMatch = path.match(/^\/api\/workspaces\/([^/]+)\/tree$/);
  if (method === "GET" && workspaceTreeMatch) {
    const workspace = service.getWorkspace(workspaceTreeMatch[1]);
    return service.getTree(workspace.rootNodeId);
  }

  const workspaceHistoryMatch = path.match(/^\/api\/workspaces\/([^/]+)\/history$/);
  if (method === "GET" && workspaceHistoryMatch) {
    return service.getOutlineHistoryState(workspaceHistoryMatch[1]);
  }

  const workspaceHistoryActionMatch = path.match(/^\/api\/workspaces\/([^/]+)\/(undo|redo)$/);
  if (method === "POST" && workspaceHistoryActionMatch) {
    return workspaceHistoryActionMatch[2] === "undo"
      ? service.undoOutline(workspaceHistoryActionMatch[1])
      : service.redoOutline(workspaceHistoryActionMatch[1]);
  }

  const restoreNodeMatch = path.match(/^\/api\/nodes\/([^/]+)\/restore$/);
  if (method === "POST" && restoreNodeMatch) {
    return service.restoreNode(restoreNodeMatch[1]);
  }

  const splitNodeLinesMatch = path.match(/^\/api\/nodes\/([^/]+)\/split-lines$/);
  if (method === "POST" && splitNodeLinesMatch) {
    return service.splitNodeByLineBreaks(splitNodeLinesMatch[1], input.title);
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
      return body.name !== undefined ? service.updateWorkspace(moved.id, { name: body.name }) : moved;
    }
    return service.updateWorkspace(workspaceMatch[1], body);
  }
  if (method === "DELETE" && workspaceMatch) {
    return service.deleteWorkspace(workspaceMatch[1]);
  }

  const nodeChildrenMatch = path.match(/^\/api\/nodes\/([^/]+)\/children$/);
  if (method === "GET" && nodeChildrenMatch) {
    return service.listChildren(nodeChildrenMatch[1]);
  }

  const nodeMatch = path.match(/^\/api\/nodes\/([^/]+)$/);
  if (method === "GET" && nodeMatch) {
    return service.getNode(nodeMatch[1]);
  }
  if (method === "PATCH" && nodeMatch) {
    return service.updateNode(nodeMatch[1], input);
  }
  if (method === "DELETE" && nodeMatch) {
    return service.deleteNode(nodeMatch[1]);
  }

  if (method === "POST" && path === "/api/nodes") {
    return service.createNode(input);
  }

  if (method === "POST" && path === "/api/nodes/delete-batch") {
    const body = input;
    return service.deleteNodes(body.ids ?? []);
  }

  const convertNodeToWorkspaceMatch = path.match(/^\/api\/nodes\/([^/]+)\/convert-to-workspace$/);
  if (method === "POST" && convertNodeToWorkspaceMatch) {
    const body = input;
    return service.convertNodeToWorkspace(convertNodeToWorkspaceMatch[1], body.name);
  }

  if (method === "POST" && path === "/api/nodes/move-batch") {
    const body = input;
    return service.moveNodes(body.ids ?? [], body.parentId, body.position, body.expandParent);
  }

  if (method === "POST" && path === "/api/nodes/move-to-workspace") {
    const body = input;
    return service.moveNodesToWorkspace(body.ids ?? [], body.workspaceId);
  }

  const moveMatch = path.match(/^\/api\/nodes\/([^/]+)\/move$/);
  if (method === "POST" && moveMatch) {
    const body = input;
    return service.moveNode(moveMatch[1], body.parentId, body.position);
  }

  if (method === "GET" && path === "/api/search") {
    return service.searchNodes(url.searchParams.get("q") ?? "", url.searchParams.get("workspaceId") ?? undefined);
  }

  if (method === "GET" && path === "/api/tags") {
    const workspaceId = requiredParam(url, "workspaceId");
    return service.listTags(workspaceId);
  }

  if (method === "GET" && path === "/api/tag-results") {
    return service.listNodesByTagName(requiredParam(url, "name"));
  }

  if (method === "GET" && path === "/api/system/tag-tree") {
    return service.listTaggedNodeGroups(url.searchParams.get("includeUnused") === "1");
  }

  if (method === "GET" && path === "/api/system/tags") {
    return service.listAllTags();
  }

  const systemTagMatch = path.match(/^\/api\/system\/tags\/([^/]+)$/);
  if (method === "PATCH" && systemTagMatch) {
    return service.renameTagGroup(decodeURIComponent(systemTagMatch[1]), input.name);
  }
  if (method === "DELETE" && systemTagMatch) {
    return service.deleteTagGroup(decodeURIComponent(systemTagMatch[1]));
  }

  if (method === "POST" && path === "/api/tags") {
    const body = input;
    return service.createTag(body.workspaceId, body.name, body.color);
  }

  const tagMatch = path.match(/^\/api\/tags\/([^/]+)$/);
  if (method === "PATCH" && tagMatch) {
    return service.updateTag(tagMatch[1], input);
  }
  if (method === "DELETE" && tagMatch) {
    return service.deleteTag(tagMatch[1]);
  }

  const nodeTagsMatch = path.match(/^\/api\/nodes\/([^/]+)\/tags$/);
  if (method === "POST" && nodeTagsMatch) {
    const body = input;
    return service.setNodeTag(nodeTagsMatch[1], body.name);
  }

  const nodeTagMatch = path.match(/^\/api\/nodes\/([^/]+)\/tags\/([^/]+)$/);
  if (method === "DELETE" && nodeTagMatch) {
    service.getNode(nodeTagMatch[1]);
    service.removeNodeTag(nodeTagMatch[1], nodeTagMatch[2]);
    return { removed: nodeTagMatch[2] };
  }

  if (method === "GET" && path === "/api/fields") {
    return service.listFieldDefinitions(requiredParam(url, "workspaceId"));
  }

  if (method === "POST" && path === "/api/fields") {
    return service.createFieldDefinition(input);
  }

  if (method === "POST" && path === "/api/field-values") {
    const body = input;
    return service.setFieldValue(body.nodeId, body.fieldId, body.value);
  }

  if (method === "POST" && path === "/api/import/markdown") {
    const body = input;
    return importMarkdown(service, body);
  }

  if (method === "GET" && path === "/api/export/markdown") {
    return exportMarkdown(service, url.searchParams.get("workspaceId") ?? undefined);
  }

  if (method === "POST" && path === "/api/import/opml") {
    const body = input;
    return importOpml(service, body);
  }

  if (method === "GET" && path === "/api/export/opml") {
    return exportOpml(service, url.searchParams.get("workspaceId") ?? undefined);
  }

  throw new NotFoundError(`Route not found: ${method} ${path}`);
}
function requiredParam(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (!value) throw new ValidationError(`Missing required query param: ${name}`);
  return value;
}
