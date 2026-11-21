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

export async function requestEnglishTranslation(text: string): Promise<string> {
  const response = await fetch("/api/translation/english", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(35_000)
  }).catch(() => {
    throw new Error("Could not reach the translation server. Check the connection and try again.");
  });
  const result = await response.json().catch(() => null);
  if (response.ok && typeof result?.text === "string" && result.text.trim()) return result.text;
  throw new Error(typeof result?.error === "string" ? result.error : "The translation server did not return a translation.");
}
