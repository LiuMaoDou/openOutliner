/** One shared, byte-based capacity contract for export and import.
 * Larger archives are refused before download, never exported as an unrestorable file.
 */
export const MAX_RECOVERY_BYTES = 256 * 1024 * 1024;
export const RECOVERY_CAPACITY_LABEL = "256 MiB";
const capacityError = () => new Error(`恢复备份超过 ${RECOVERY_CAPACITY_LABEL}。请分别下载历史版本；原有数据不会被删除。`);

export function encodeRecovery(value: unknown, limit = MAX_RECOVERY_BYTES): Blob {
  const blob = new Blob([JSON.stringify(value)], { type: "application/json" });
  if (blob.size > limit) throw capacityError();
  return blob;
}

export async function decodeRecovery(file: Blob, limit = MAX_RECOVERY_BYTES): Promise<unknown> {
  if (file.size > limit) throw capacityError();
  // Count actual streamed UTF-8 bytes too; never trust the filename or content type.
  const reader = file.stream().getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  const parts: string[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) { await reader.cancel(); throw capacityError(); }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return JSON.parse(parts.join(""));
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) throw new Error("备份不是有效的 UTF-8 JSON 文件，原有数据未改动。");
    throw error;
  } finally { reader.releaseLock(); }
}
