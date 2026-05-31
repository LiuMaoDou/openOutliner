export interface Workspace {
  id: string;
  name: string;
  icon: string;
  rootNodeId: string;
  createdAt: string;
  updatedAt: string;
}

export interface Tag {
  id: string;
  workspaceId: string;
  name: string;
  color: string;
  createdAt: string;
}

export interface FieldValue {
  nodeId: string;
  fieldId: string;
  value: string;
  updatedAt: string;
}

export interface OutlineTreeNode {
  id: string;
  workspaceId: string;
  parentId: string | null;
  position: number;
  title: string;
  body: string;
  done: boolean;
  collapsed: boolean;
  createdAt: string;
  updatedAt: string;
  tags: Tag[];
  fieldValues: FieldValue[];
  children: OutlineTreeNode[];
}

export async function apiGet<T>(path: string): Promise<T> {
  return request<T>(path);
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: "POST",
    body: JSON.stringify(body)
  });
}

export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: "PATCH",
    body: JSON.stringify(body)
  });
}

export async function apiDelete<T>(path: string): Promise<T> {
  return request<T>(path, { method: "DELETE" });
}

export async function apiText(path: string): Promise<string> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(await errorMessage(response));
  return response.text();
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers
    }
  });
  if (!response.ok) throw new Error(await errorMessage(response));
  return (await response.json()) as T;
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error ?? response.statusText;
  } catch {
    return response.statusText;
  }
}
