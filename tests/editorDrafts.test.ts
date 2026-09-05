import { describe, expect, it } from "vitest";
import { DraftJournal, parseDraftBackup } from "../src/web/editorDrafts.js";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); }
  };
}

describe("durable editor journal", () => {
  it("recovers title and Notes edits after reload before the debounce runs", () => {
    const storage = memoryStorage();
    const first = new DraftJournal(storage, "tab-a");
    first.stage("node", "title", "New title", "Old title");
    first.stage("node", "body", "New Notes", "Old Notes");
    const reloaded = new DraftJournal(storage, "tab-a");
    expect(reloaded.get("node", "title")).toMatchObject({ value: "New title", expected: "Old title" });
    expect(reloaded.get("node", "body")).toMatchObject({ value: "New Notes", expected: "Old Notes" });
  });

  it("advances the edit baseline after save without clearing a newer keystroke", () => {
    const journal = new DraftJournal(memoryStorage(), "tab-a");
    journal.begin("node", "title", "Original");
    const sent = journal.stage("node", "title", "First", "Original");
    journal.stage("node", "title", "Second", "Original");
    journal.acknowledge(sent);
    expect(journal.get("node", "title")).toMatchObject({ value: "Second", expected: "First" });
    journal.acknowledge(journal.get("node", "title")!);
    expect(journal.get("node", "title")).toBeUndefined();
    journal.stage("node", "title", "Third", "Original");
    expect(journal.get("node", "title")?.expected).toBe("Second");
  });

  it("starts a new editing session from the current remote value", () => {
    const journal = new DraftJournal(memoryStorage(), "tab-a");
    journal.begin("node", "title", "Original");
    journal.acknowledge(journal.stage("node", "title", "First", "Original"));
    journal.end("node", "title");
    journal.begin("node", "title", "Remote");
    expect(journal.stage("node", "title", "Next", "Remote").expected).toBe("Remote");
  });

  it("never removes another tab's pending draft when acknowledging a save", () => {
    const storage = memoryStorage();
    const a = new DraftJournal(storage, "tab-a"), b = new DraftJournal(storage, "tab-b");
    const saved = a.stage("node", "title", "First tab", "Original");
    b.stage("node", "title", "Second tab", "Original");
    a.acknowledge(saved);
    expect(a.get("node", "title")).toBeUndefined();
    expect(b.get("node", "title")?.value).toBe("Second tab");
  });

  it("does not let an old blur clear the baseline of a newly focused editor", () => {
    const journal = new DraftJournal(memoryStorage(), "tab-a");
    journal.begin("node", "title", "Original");
    const oldSession = journal.session("node", "title");
    journal.begin("node", "title", "Remote update");
    journal.end("node", "title", oldSession);
    expect(journal.stage("node", "title", "New edit", "Outdated prop").expected).toBe("Remote update");
  });

  it("keeps both conflicting values and archives the discarded draft independently", () => {
    const storage = memoryStorage(), journal = new DraftJournal(storage, "tab-a");
    const draft = journal.stage("node", "body", "Local Notes", "Original");
    journal.conflict(draft, "Remote Notes", "Concurrent edit");
    journal.archive(draft.id, draft.version);
    journal.stage("node", "body", "Later Notes", "Remote Notes");
    const backup = new DraftJournal(storage, "tab-a").list().find(item => item.archived);
    expect(backup).toMatchObject({ value: "Local Notes", conflict: { current: "Remote Notes" } });
    expect(journal.get("node", "body")?.value).toBe("Later Notes");
  });

  it("retains a recoverable in-memory copy when browser storage is full", () => {
    const storage = memoryStorage(), journal = new DraftJournal(storage, "tab-a");
    const write = storage.setItem;
    storage.setItem = () => { throw new Error("Quota exceeded"); };
    expect(() => journal.stage("node", "title", "Unsaved text", "Original")).toThrow("Quota exceeded");
    expect(journal.hasVolatileDrafts()).toBe(true);
    expect(journal.get("node", "title")?.value).toBe("Unsaved text");
    storage.setItem = write;
    journal.stage("node", "title", "Saved retry", "Original");
    expect(journal.hasVolatileDrafts()).toBe(false);
    expect(new DraftJournal(storage, "tab-a").get("node", "title")?.value).toBe("Saved retry");
  });

  it("restores backup drafts for review without replacing this tab's editor", () => {
    const source = new DraftJournal(memoryStorage(), "source");
    source.stage("node", "title", "Recovered title", "Old title");
    const note = source.stage("node", "body", "Archived Notes", "Old Notes");
    source.archive(note.id);
    const backup = parseDraftBackup(JSON.parse(JSON.stringify(source.list())));
    const target = new DraftJournal(memoryStorage(), "target");
    target.stage("node", "title", "Current unfinished title", "Current base");
    target.restore(backup);
    expect(target.get("node", "title")?.value).toBe("Current unfinished title");
    expect(target.list().find(draft => draft.value === "Recovered title")?.archived).toBeUndefined();
    expect(target.list().find(draft => draft.value === "Recovered title")?.owner).not.toBe("target");
    expect(target.list().find(draft => draft.value === "Archived Notes")?.archived).toBe(true);
  });

  it("can recover an archived version without deleting the archive or autosaving it", () => {
    const journal = new DraftJournal(memoryStorage(), "tab-a");
    const draft = journal.stage("node", "body", "Recovered Notes", "Original");
    journal.archive(draft.id);
    journal.recoverArchive(journal.list()[0].id);
    expect(journal.list().filter(item => item.archived)).toHaveLength(1);
    expect(journal.list().filter(item => !item.archived)).toHaveLength(1);
    expect(journal.get("node", "body")).toBeUndefined();
  });

  it("rejects malformed backup drafts before they enter the journal", () => {
    expect(parseDraftBackup(undefined)).toEqual([]);
    expect(() => parseDraftBackup({ value: "bad" })).toThrow("格式无效");
    expect(() => parseDraftBackup([{ nodeId: "node", field: "workspace_id", value: "other" }])).toThrow("格式无效");
  });
});
