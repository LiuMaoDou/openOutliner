package red.liu.line;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.util.Base64;
import android.webkit.WebMessage;
import android.webkit.WebMessagePort;
import android.webkit.WebView;
import java.io.OutputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

/** A page-scoped message port, not a JavaScript interface. The user picks
 * each destination with ACTION_CREATE_DOCUMENT; no arbitrary path access. */
final class LocalExportController {
  static final int REQUEST = 11;
  private static final long MAX = 256L * 1024 * 1024;
  private static final int CHUNK = 48 * 1024;
  private static final String WRITE_ERROR = "保存备份失败或文件不完整，请重试；本机数据库未改动";
  private final Activity activity;
  private final ExecutorService fileIo = Executors.newSingleThreadExecutor();
  private WebMessagePort port;
  private Export active;
  private boolean pickerPending;

  private static final class Export {
    final String id;
    final long expected;
    boolean ioPending;
    // The file executor owns the stream, destination, and byte count.
    long written;
    OutputStream output;
    Uri destination;

    Export(String id, long expected) {
      this.id = id;
      this.expected = expected;
    }
  }

  private interface FileOperation { void run() throws Exception; }

  LocalExportController(Activity activity) { this.activity = activity; }

  void attach(WebView view, Uri origin) {
    detach();
    WebMessagePort[] ports = view.createWebMessageChannel();
    port = ports[0];
    final WebMessagePort owned = port;
    owned.setWebMessageCallback(new WebMessagePort.WebMessageCallback() {
      @Override public void onMessage(WebMessagePort source, WebMessage message) {
        if (port == owned) receive(message.getData());
      }
    });
    view.postWebMessage(new WebMessage("openoutliner-export-port-v1", new WebMessagePort[]{ports[1]}), origin);
  }

  private void receive(String message) {
    try {
      if (message == null || message.length() > 70_000) throw new IllegalArgumentException("Invalid export message");
      JSONObject value = new JSONObject(message);
      String op = value.getString("op"), requestId = value.getString("id");
      if ("begin".equals(op)) {
        if (active != null || pickerPending) { reply(requestId, "error", "已有文件保存操作正在进行"); return; }
        String name = value.getString("name"), mime = value.getString("mime");
        long bytes = value.getLong("size");
        if (!requestId.matches("[0-9a-fA-F-]{36}") || !name.matches("openoutliner-[A-Za-z0-9_.-]{1,140}\\.json")
            || !"application/json".equals(mime) || bytes < 0 || bytes > MAX) {
          reply(requestId, "error", "无效的备份文件或超过 256 MiB"); return;
        }
        active = new Export(requestId, bytes);
        Intent create = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        create.addCategory(Intent.CATEGORY_OPENABLE);
        create.setType(mime);
        create.putExtra(Intent.EXTRA_TITLE, name);
        pickerPending = true;
        try { activity.startActivityForResult(create, REQUEST); }
        catch (Exception error) { pickerPending = false; fail("无法打开系统文件保存器"); }
        return;
      }
      Export export = active;
      if (export == null || !requestId.equals(export.id)) { reply(requestId, "error", "备份会话已失效"); return; }
      if ("abort".equals(op)) { fail("备份已取消"); return; }
      if (pickerPending) throw new IllegalStateException("Destination not selected");
      if ("chunk".equals(op)) {
        String data = value.getString("data");
        runFileOperation(export, "ack", WRITE_ERROR, () -> {
          byte[] bytes = Base64.decode(data, Base64.NO_WRAP);
          if (export.output == null || bytes.length == 0 || bytes.length > CHUNK || export.written + bytes.length > export.expected) {
            throw new IllegalArgumentException("Invalid backup chunk");
          }
          export.output.write(bytes);
          export.written += bytes.length;
        });
      } else if ("end".equals(op)) {
        runFileOperation(export, "done", WRITE_ERROR, () -> {
          if (export.output == null || export.written != export.expected) throw new IllegalStateException("Incomplete backup");
          export.output.flush();
          export.output.close();
          export.output = null;
        });
      } else throw new IllegalArgumentException("Invalid export operation");
    } catch (Exception error) { fail(WRITE_ERROR); }
  }

  void onResult(int result, Intent data) {
    pickerPending = false;
    Uri destination = result == Activity.RESULT_OK && data != null ? data.getData() : null;
    Export export = active;
    if (export == null) {
      if (destination != null) fileIo.execute(() -> deleteFile(destination));
      return;
    }
    if (destination == null) { fail("已取消保存备份"); return; }
    runFileOperation(export, "ready", "无法写入所选文件", () -> {
      export.destination = destination;
      export.output = activity.getContentResolver().openOutputStream(destination, "wt");
      if (export.output == null) throw new IllegalStateException("No output stream");
    });
  }

  private void runFileOperation(Export export, String success, String error, FileOperation operation) {
    // The web client waits for each acknowledgment. Reject pipelined operations
    // so at most one chunk is retained while a provider handles the write.
    if (export.ioPending) throw new IllegalStateException("Export operation already pending");
    export.ioPending = true;
    fileIo.execute(() -> {
      try {
        operation.run();
      } catch (Exception failure) {
        activity.runOnUiThread(() -> { if (active == export) fail(error); });
        return;
      }
      activity.runOnUiThread(() -> {
        if (active != export) return;
        export.ioPending = false;
        if ("done".equals(success)) active = null;
        reply(export.id, success, "");
      });
    });
  }

  private void reply(String requestId, String type, String error) {
    if (port == null || requestId == null) return;
    try {
      JSONObject message = new JSONObject();
      message.put("id", requestId); message.put("type", type); message.put("error", error);
      port.postMessage(new WebMessage(message.toString()));
    } catch (Exception ignored) { /* Navigation may have closed the other end. */ }
  }

  private void fail(String message) {
    Export failed = cancelExport();
    if (failed != null) reply(failed.id, "error", message);
  }

  private Export cancelExport() {
    Export cancelled = active;
    active = null;
    if (cancelled != null) fileIo.execute(() -> {
      if (cancelled.output != null) {
        try { cancelled.output.close(); } catch (Exception ignored) {}
      }
      if (cancelled.destination != null) deleteFile(cancelled.destination);
    });
    return cancelled;
  }

  private void deleteFile(Uri destination) {
    try { activity.getContentResolver().delete(destination, null, null); } catch (Exception ignored) {}
  }

  void detach() {
    cancelExport();
    if (port != null) {
      try { port.close(); } catch (Exception ignored) {}
      port = null;
    }
  }

  void destroy() {
    detach();
    fileIo.shutdown();
  }
}
