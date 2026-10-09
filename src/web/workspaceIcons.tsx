import { FolderTree, type LucideIcon, type LucideProps } from "lucide-react";

// Eager imports put every workspace icon in the offline shell's static graph.
// Keep the file names so existing kebab-case names and Lucide aliases still work.
const modules = import.meta.glob<LucideIcon>([
  "/node_modules/lucide-react/dist/esm/icons/*.js",
  "!/node_modules/lucide-react/dist/esm/icons/index.js"
], { eager: true, import: "default" });

const workspaceIcons = new Map(Object.entries(modules).map(([path, icon]) => [
  path.slice(path.lastIndexOf("/") + 1, -3),
  icon
]));

// Lucide exports this legacy alias without a matching icon file.
const fingerprint = workspaceIcons.get("fingerprint-pattern");
if (fingerprint) workspaceIcons.set("fingerprint", fingerprint);

export const workspaceIconNames = [...workspaceIcons.keys()];

export function randomWorkspaceIcon(): string {
  return workspaceIconNames[Math.floor(Math.random() * workspaceIconNames.length)] ?? "folder-tree";
}

export function WorkspaceIcon({ name, ...props }: LucideProps & { name: string }) {
  const Icon = workspaceIcons.get(name) ?? FolderTree;
  return <Icon {...props} />;
}
