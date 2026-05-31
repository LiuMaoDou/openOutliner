export type FieldType = "text" | "number" | "date" | "checkbox" | "select";

export interface Workspace {
  id: string;
  name: string;
  icon: string;
  rootNodeId: string;
  createdAt: string;
  updatedAt: string;
}

export interface OutlineNode {
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
}

export interface Tag {
  id: string;
  workspaceId: string;
  name: string;
  color: string;
  createdAt: string;
}

export interface FieldDefinition {
  id: string;
  workspaceId: string;
  tagId: string;
  name: string;
  type: FieldType;
  options: string | null;
  createdAt: string;
}

export interface FieldValue {
  nodeId: string;
  fieldId: string;
  value: string;
  updatedAt: string;
}

export interface OutlineTreeNode extends OutlineNode {
  tags: Tag[];
  fieldValues: FieldValue[];
  children: OutlineTreeNode[];
}

export interface CreateNodeInput {
  parentId: string;
  title: string;
  body?: string;
  position?: number;
  done?: boolean;
}

export interface UpdateNodeInput {
  title?: string;
  body?: string;
  done?: boolean;
  collapsed?: boolean;
}
