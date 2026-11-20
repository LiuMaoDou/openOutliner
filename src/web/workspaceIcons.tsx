import { FileText, FolderClosed, FolderOpen } from "lucide-react";

export function WorkspaceTreeIcon({ hasChildren, collapsed }: { hasChildren: boolean; collapsed: boolean }) {
  const Icon = hasChildren ? (collapsed ? FolderClosed : FolderOpen) : FileText;
  return <Icon size={15} strokeWidth={2.2} aria-hidden="true" />;
}
