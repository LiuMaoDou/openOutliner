type NativeSave = (blob: Blob, filename: string) => Promise<void>;

export async function saveLocalFile(blob: Blob, filename: string): Promise<void> {
  const native = (window as Window & { openOutlinerAndroidSave?: NativeSave }).openOutlinerAndroidSave;
  if (native) {
    // Never silently fall back to a browser download after a native error.
    await native(blob, filename);
    return;
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  try { anchor.click(); }
  finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
