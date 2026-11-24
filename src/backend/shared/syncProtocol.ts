import { changesBetween, equal, rowKey, tables, type Change, type Snapshot } from "./sync.js";

export interface FullEnvelope { version: 1; revision: string; data: Snapshot }
export interface DeltaEnvelope { version: 2; baseRevision: string; revision: string; changes: Change[] }
export type SyncEnvelope = FullEnvelope | DeltaEnvelope;

/** Canonical bytes independent of SQL column order, locale, and transport. */
export function canonicalSnapshot(data: Snapshot): string {
  return JSON.stringify(tables.map(table => {
    const rows = data[table].map(row => [rowKey(table, row), Object.keys(row).sort().map(key => [key, row[key]])] as const);
    rows.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    return [table, rows];
  }));
}

/** A server delta is an exact transition, not a concurrent merge. Reject
 * any unexpected before-image, duplicate key, or inconsistent row identity. */
export function applyExactDelta(base: Snapshot, changes: Change[]): Snapshot {
  const result = {} as Snapshot;
  for (const table of tables) {
    const rows = new Map(base[table].map(row => [rowKey(table, row), row]));
    const seen = new Set<string>();
    for (const change of changes) {
      if (!tables.includes(change.table)) throw new Error("Invalid delta table");
      if (change.table !== table) continue;
      if (seen.has(change.key) ||
          (change.before !== null && rowKey(table, change.before) !== change.key) ||
          (change.after !== null && rowKey(table, change.after) !== change.key) ||
          !equal(rows.get(change.key) ?? null, change.before)) {
        throw new Error("Delta baseline mismatch");
      }
      seen.add(change.key);
      if (change.after === null) rows.delete(change.key);
      else rows.set(change.key, change.after);
    }
    result[table] = [...rows.values()];
  }
  return result;
}

/** Verify both ends before allowing a delta to become a local sync baseline. */
export async function decodeEnvelope(envelope: SyncEnvelope, base: Snapshot | undefined, revision: string | undefined,
  digest: (data: string) => Promise<string>): Promise<FullEnvelope> {
  if (envelope.version === 1) return envelope;
  if (envelope.version !== 2 || !base || !revision || envelope.baseRevision !== revision ||
      !Array.isArray(envelope.changes) || await digest(canonicalSnapshot(base)) !== revision) {
    throw new Error("Invalid sync delta baseline");
  }
  const data = applyExactDelta(base, envelope.changes);
  if (await digest(canonicalSnapshot(data)) !== envelope.revision) throw new Error("Invalid sync delta checksum");
  return { version: 1, revision: envelope.revision, data };
}

/** Bounded revision window. If a client is older than this window or the
 * server restarted, it receives a full snapshot; never guess a missing base.
 * Keep checkpoints in memory only, so a recycle-bin purge does not create
 * a second persistent copy of deleted data on the server. */
export class RevisionWindow {
  private entries = new Map<string, { data: Snapshot; size: number; expires: number }>();
  private size = 0;
  constructor(private maxBytes = 48 * 1024 * 1024, private maxEntries = 8, private ttlMs = 15 * 60_000) {}
  response(full: FullEnvelope, baseRevision?: string | null, now = Date.now()): SyncEnvelope {
    for (const [revision, entry] of this.entries) if (entry.expires <= now) this.remove(revision);
    const before = baseRevision ? this.entries.get(baseRevision)?.data : undefined;
    let result: SyncEnvelope = full;
    if (baseRevision === full.revision) {
      result = { version: 2, baseRevision, revision: full.revision, changes: [] };
    } else if (before && baseRevision) {
      const changes = changesBetween(before, full.data);
      // Never retain an old physical deletion in the checkpoint window.
      if (changes.some(change => change.after === null)) this.clear();
      else {
        const delta: DeltaEnvelope = { version: 2, baseRevision, revision: full.revision, changes };
        if (JSON.stringify(delta).length < JSON.stringify(full).length) result = delta;
      }
    }
    // Also clear older bases after a hard delete observed on a full pull.
    const latest = [...this.entries.values()].at(-1);
    if (latest && changesBetween(latest.data, full.data).some(change => change.after === null)) {
      this.clear();
      if (result.version === 2 && result.changes.length) result = full;
    }
    if (!this.entries.has(full.revision)) {
      const size = JSON.stringify(full.data).length * 2;
      if (size <= this.maxBytes) {
        this.entries.set(full.revision, { data: full.data, size, expires: now + this.ttlMs });
        this.size += size;
        while (this.entries.size > this.maxEntries || this.size > this.maxBytes) {
          const oldest = this.entries.keys().next().value;
          if (oldest === undefined) break;
          this.remove(oldest);
        }
      }
    }
    return result;
  }
  private remove(revision: string) {
    const entry = this.entries.get(revision);
    if (entry) { this.size -= entry.size; this.entries.delete(revision); }
  }
  private clear() { this.entries.clear(); this.size = 0; }
}
