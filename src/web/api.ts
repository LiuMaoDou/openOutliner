import { localRequest } from "./offline";
export type {
  Workspace, WorkspaceFolder, Tag, FieldValue, OutlineNode, OutlineTreeNode,
  RecycleBinEntry, TaggedNodePathSegment, TaggedNodeResult, TaggedNodeGroup
} from "../backend/domain/types";
export type { OutlineHistoryState, OutlineHistoryResult } from "../backend/services/outliner";

export async function apiGet<T>(path: string): Promise<T> {
  return localRequest<T>(path);
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  return localRequest<T>(path, "POST", body);
}

export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  return localRequest<T>(path, "PATCH", body);
}

export async function apiDelete<T>(path: string): Promise<T> {
  return localRequest<T>(path, "DELETE");
}

export async function apiText(path: string): Promise<string> {
  return localRequest<string>(path);
}
