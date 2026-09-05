export type SqlValue = string | number | bigint | Uint8Array | null;
export interface SqlDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): {
    all(...values: SqlValue[]): Record<string, unknown>[];
    get(...values: SqlValue[]): Record<string, unknown> | undefined;
    run(...values: SqlValue[]): unknown;
  };
}
