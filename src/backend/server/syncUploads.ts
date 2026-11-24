import { createHash, randomUUID, type Hash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ValidationError } from "../services/outliner.js";
import { MAX_STAGED_SYNC_BYTES, SYNC_CHUNK_BYTES } from "../shared/uploadLimits.js";

interface Upload {
  file: string;
  bytes: number;
  written: number;
  next: number;
  digest: string;
  hash: Hash;
  expires: number;
}
const metadata = z.object({
  bytes: z.number().int().positive().max(MAX_STAGED_SYNC_BYTES),
  digest: z.string().regex(/^[0-9a-f]{64}$/)
});

/** Bounded, private staging area. Chunks never mutate the outline DB.
 * Only a complete, checksum-verified upload reaches the existing atomic push. */
export class SyncUploadStore {
  private readonly directory: string;
  private readonly entries = new Map<string, Upload>();
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(root = tmpdir(), private readonly ttl = 10 * 60_000, private readonly budget = MAX_STAGED_SYNC_BYTES) {
    mkdirSync(root, { recursive: true });
    this.directory = mkdtempSync(join(root, "openoutliner-upload-"));
    this.timer = setInterval(() => this.expire(), 60_000);
    this.timer.unref();
  }
  private expire() {
    const now = Date.now();
    for (const [id, entry] of this.entries) if (entry.expires <= now) this.abort(id);
  }
  start(input: unknown) {
    this.expire();
    const result = metadata.safeParse(input);
    if (!result.success) throw new ValidationError("Invalid staged sync metadata or upload too large");
    const { bytes, digest } = result.data;
    if (this.entries.size >= 4 || bytes + [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0) > this.budget) {
      throw new ValidationError("Server staged sync capacity is busy; retry later");
    }
    const id = randomUUID(), file = join(this.directory, id);
    writeFileSync(file, "", { flag: "wx", mode: 0o600 });
    this.entries.set(id, { file, bytes, digest, hash: createHash("sha256"), written: 0, next: 0, expires: Date.now() + this.ttl });
    return { id, chunkBytes: SYNC_CHUNK_BYTES };
  }
  append(id: string, index: number, bytes: Buffer) {
    this.expire();
    const entry = this.entries.get(id);
    if (!entry || !Number.isSafeInteger(index) || index !== entry.next ||
        !bytes.length || bytes.length > SYNC_CHUNK_BYTES || entry.written + bytes.length > entry.bytes) {
      throw new ValidationError("Invalid, expired or out-of-order sync chunk");
    }
    appendFileSync(entry.file, bytes);
    entry.hash.update(bytes);
    entry.written += bytes.length;
    entry.next++;
    entry.expires = Date.now() + this.ttl;
    return { received: entry.written };
  }
  finish(id: string): unknown {
    this.expire();
    const entry = this.entries.get(id);
    if (!entry) throw new ValidationError("Staged sync upload not found or expired");
    try {
      if (entry.written !== entry.bytes || entry.hash.digest("hex") !== entry.digest) {
        throw new ValidationError("Incomplete staged sync or checksum mismatch");
      }
      try {
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(entry.file)));
      } catch { throw new ValidationError("Invalid staged sync JSON"); }
    } finally { this.abort(id); }
  }
  abort(id: string) {
    const entry = this.entries.get(id);
    if (entry) {
      this.entries.delete(id);
      rmSync(entry.file, { force: true });
    }
  }
  dispose() {
    clearInterval(this.timer);
    this.entries.clear();
    rmSync(this.directory, { recursive: true, force: true });
  }
}
