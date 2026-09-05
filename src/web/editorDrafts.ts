export type DraftField = "title" | "body";
export interface EditorDraft {
  id: string;
  owner: string;
  nodeId: string;
  field: DraftField;
  expected: string;
  value: string;
  version: string;
  updatedAt: string;
  conflict?: { current: string | null; message: string };
  archived?: boolean;
}

export const draftPrefix = "openoutliner-draft-v1:";
type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

export function parseDraftBackup(value: unknown): EditorDraft[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("恢复备份中的编辑草稿格式无效。");
  return value.map(item => {
    if (!item || typeof item !== "object" || typeof item.nodeId !== "string" || (item.field !== "title" && item.field !== "body") || typeof item.expected !== "string" || typeof item.value !== "string" || typeof item.updatedAt !== "string" || (item.archived !== undefined && typeof item.archived !== "boolean")) {
      throw new Error("恢复备份中的编辑草稿格式无效。");
    }
    if (item.conflict && ((item.conflict.current !== null && typeof item.conflict.current !== "string") || typeof item.conflict.message !== "string")) throw new Error("恢复备份中的编辑冲突格式无效。");
    return item as EditorDraft;
  });
}

// One key per tab and field prevents one tab's acknowledgement from deleting
// another tab's work. sessionStorage keeps the owner stable across reloads.
export class DraftJournal {
  private memory = new Map<string, EditorDraft>();
  private bases = new Map<string, { value: string; session: string }>();
  constructor(private storage: DraftStorage, readonly owner: string) {}
  private id(nodeId: string, field: DraftField) { return `${draftPrefix}${this.owner}:${nodeId}:${field}`; }
  private read(id: string): EditorDraft | undefined {
    const buffered = this.memory.get(id);
    if (buffered) return buffered;
    const raw = this.storage.getItem(id);
    if (!raw) return;
    try {
      const value = JSON.parse(raw) as EditorDraft;
      if (value.id === id && typeof value.nodeId === "string" && (value.field === "title" || value.field === "body") && typeof value.value === "string" && typeof value.expected === "string") return value;
    } catch { /* An invalid entry must not replace application data. */ }
  }
  get(nodeId: string, field: DraftField) {
    const draft = this.read(this.id(nodeId, field));
    return draft?.archived ? undefined : draft;
  }
  list(): EditorDraft[] {
    const ids = new Set(this.memory.keys());
    for (let i = 0; i < this.storage.length; i++) {
      const key = this.storage.key(i);
      if (key?.startsWith(draftPrefix)) ids.add(key);
    }
    return [...ids].map(id => this.read(id)).filter((value): value is EditorDraft => Boolean(value));
  }
  begin(nodeId: string, field: DraftField, expected: string) {
    this.bases.set(this.id(nodeId, field), { value: this.get(nodeId, field)?.expected ?? expected, session: crypto.randomUUID() });
  }
  session(nodeId: string, field: DraftField) { return this.bases.get(this.id(nodeId, field))?.session; }
  end(nodeId: string, field: DraftField, session?: string) {
    const id = this.id(nodeId, field);
    if (!session || this.bases.get(id)?.session === session) this.bases.delete(id);
  }
  put(draft: EditorDraft) {
    // Retain an in-memory recovery copy even when the durable write fails.
    this.memory.set(draft.id, draft);
    this.storage.setItem(draft.id, JSON.stringify(draft));
    this.memory.delete(draft.id);
  }
  stage(nodeId: string, field: DraftField, value: string, expected: string) {
    const id = this.id(nodeId, field), previous = this.get(nodeId, field);
    const base = previous?.expected ?? this.bases.get(id)?.value ?? expected;
    const draft: EditorDraft = { id, owner: this.owner, nodeId, field, expected: base, value, version: crypto.randomUUID(), updatedAt: new Date().toISOString(), conflict: previous?.conflict };
    this.put(draft);
    return draft;
  }
  acknowledge(saved: EditorDraft) {
    this.bases.set(saved.id, { value: saved.value, session: this.bases.get(saved.id)?.session ?? crypto.randomUUID() });
    const latest = this.read(saved.id);
    if (!latest || latest.archived) return;
    if (latest.version === saved.version) {
      this.storage.removeItem(saved.id);
      this.memory.delete(saved.id);
    } else if (latest.expected === saved.expected) {
      this.put({ ...latest, expected: saved.value });
    }
  }
  conflict(draft: EditorDraft, current: string | null, message: string) {
    const latest = this.read(draft.id);
    if (latest && !latest.archived) this.put({ ...latest, conflict: { current, message } });
  }
  archive(id: string, version?: string) {
    const draft = this.read(id);
    if (!draft || (version && draft.version !== version)) return;
    this.put({ ...draft, id: `${id}:archived:${crypto.randomUUID()}`, archived: true });
    this.storage.removeItem(id);
    this.memory.delete(id);
  }
  restore(drafts: EditorDraft[]) {
    for (const draft of drafts) {
      // Imported drafts are always reviewed separately. They never become this
      // live tab's autosave entry and cannot overwrite its pending keystrokes.
      const owner = `recovery-${crypto.randomUUID()}`;
      this.put({ ...draft, owner, id: `${draftPrefix}${owner}:${draft.nodeId}:${draft.field}`, version: crypto.randomUUID() });
    }
  }
  recoverArchive(id: string) {
    const draft = this.read(id);
    if (draft?.archived) this.restore([{ ...draft, archived: false }]);
  }
  hasVolatileDrafts() { return this.memory.size > 0; }
}
