import type { CreateNodeInput, OutlineNode, UpdateNodeInput } from "../backend/domain/types.js";

export const creationPrefix = "openoutliner-create-v1:";
export interface CreationIntent {
  id: string;
  owner: string;
  parentId: string;
  position: number;
  initialTitle: string;
  title: string;
  body: string;
  version: string;
  cancelled?: boolean;
  updatedAt: string;
}
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;
export function isCreationIntent(value: unknown): value is CreationIntent {
  if (!value || typeof value !== "object") return false;
  const v = value as CreationIntent;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.id)
    && typeof v.owner === "string" && !!v.owner && typeof v.parentId === "string" && !!v.parentId
    && Number.isSafeInteger(v.position) && v.position >= 0 && typeof v.initialTitle === "string"
    && typeof v.title === "string" && typeof v.body === "string" && typeof v.version === "string"
    && typeof v.updatedAt === "string" && (v.cancelled === undefined || typeof v.cancelled === "boolean");
}
export function parseCreationBackup(value: unknown): CreationIntent[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(isCreationIntent)) throw new Error("备份中的待创建大纲格式无效。");
  return value;
}

export class CreationJournal {
  private memory = new Map<string, CreationIntent>();
  constructor(private storage: StorageLike, readonly owner: string) {}
  private key(intent: Pick<CreationIntent, "owner" | "id">) { return creationPrefix + intent.owner + ":" + intent.id; }
  private read(key: string) {
    const buffered = this.memory.get(key);
    if (buffered) return buffered;
    try {
      const raw = this.storage.getItem(key);
      const value: unknown = raw && JSON.parse(raw);
      if (isCreationIntent(value) && this.key(value) === key) return value;
    } catch { /* Invalid entries are never executed. */ }
  }
  list(): CreationIntent[] {
    const keys = new Set(this.memory.keys());
    for (let index = 0; index < this.storage.length; index++) {
      const key = this.storage.key(index);
      if (key?.startsWith(creationPrefix)) keys.add(key);
    }
    return [...keys].map(key => this.read(key)).filter((value): value is CreationIntent => !!value);
  }
  get(id: string) { return this.read(this.key({ owner: this.owner, id })); }
  put(intent: CreationIntent) {
    const key = this.key(intent);
    this.memory.set(key, intent);
    this.storage.setItem(key, JSON.stringify(intent));
    this.memory.delete(key);
  }
  begin(id: string, parentId: string, position: number, title: string) {
    this.put({ id, owner: this.owner, parentId, position, initialTitle: title, title, body: "", version: crypto.randomUUID(), updatedAt: new Date().toISOString() });
  }
  stage(id: string, patch: Partial<Pick<CreationIntent, "title" | "body" | "cancelled">>) {
    const current = this.get(id);
    if (current) this.put({ ...current, ...patch, version: crypto.randomUUID(), updatedAt: new Date().toISOString() });
  }
  acknowledge(intent: CreationIntent) {
    const key = this.key(intent);
    if (this.read(key)?.version !== intent.version) return;
    this.storage.removeItem(key);
    this.memory.delete(key);
  }
  restore(intents: CreationIntent[]) {
    for (const intent of intents) {
      // Imported intents cannot replace the live tab's entries.
      this.put({ ...intent, owner: "recovery-" + crypto.randomUUID(), version: crypto.randomUUID() });
    }
  }
  hasVolatileEntries() { return this.memory.size > 0; }
}

export interface CreationCommands {
  getNode(id: string): OutlineNode;
  createNode(input: CreateNodeInput): OutlineNode;
  updateNode(id: string, patch: UpdateNodeInput): OutlineNode;
  deleteNode(id: string): unknown;
}
/** Replay only after acquiring the original tab's owner lock. Never overwrite
 * a different edit or resurrect a tombstone with the same reserved UUID. */
export function replayCreation(intent: CreationIntent, commands: CreationCommands, isMissing: (error: unknown) => boolean) {
  let node: OutlineNode | undefined;
  try { node = commands.getNode(intent.id); }
  catch (error) { if (!isMissing(error)) throw error; }
  if (intent.cancelled) {
    if (node) {
      if ((node.title !== intent.initialTitle && node.title !== intent.title) ||
          (node.body !== "" && node.body !== intent.body)) throw new Error("已取消的新节点存在其他编辑，请手动检查。");
      commands.deleteNode(intent.id);
    }
    return;
  }
  if (!node) {
    node = commands.createNode({ id: intent.id, parentId: intent.parentId, position: intent.position, title: intent.initialTitle });
  }
  if (node.parentId === null ||
      (node.title !== intent.initialTitle && node.title !== intent.title) ||
      (node.body !== "" && node.body !== intent.body)) throw new Error("待创建大纲与当前内容冲突，草稿已保留。");
  if (node.title !== intent.title || node.body !== intent.body) commands.updateNode(node.id, { title: intent.title, body: intent.body });
}
