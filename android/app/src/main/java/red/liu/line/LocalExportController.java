package red.liu.line;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.util.Base64;
import android.webkit.WebMessage;
import android.webkit.WebMessagePort;
import android.webkit.WebView;
import org.json.JSONObject;
import java.io.OutputStream;

/** A page-scoped message port, not a JavaScript interface. The user picks
 * each destination with ACTION_CREATE_DOCUMENT; no arbitrary path access. */
final class LocalExportController {
  static final int REQUEST = 11;
  private static final long MAX = 256L * 1024 * 1024;
  private static final int CHUNK = 48 * 1024;
  private final Activity activity;
  private WebMessagePort port;
  private String id;
  private long expected, written;
  private OutputStream output;
  private Uri destination;
  private boolean pickerPending;

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
        if (id != null || pickerPending) { reply(requestId, "error", "已有文件保存操作正在进行"); return; }
        String name = value.getString("name"), mime = value.getString("mime");
        long bytes = value.getLong("size");
        if (!requestId.matches("[0-9a-fA-F-]{36}") || !name.matches("openoutliner-[A-Za-z0-9_.-]{1,140}\\.json")
            || !"application/json".equals(mime) || bytes < 0 || bytes > MAX) {
          reply(requestId, "error", "无效的备份文件或超过 256 MiB"); return;
        }
        id = requestId; expected = bytes; written = 0;
        Intent create = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        create.addCategory(Intent.CATEGORY_OPENABLE);
        create.setType(mime);
        create.putExtra(Intent.EXTRA_TITLE, name);
        pickerPending = true;
        try { activity.startActivityForResult(create, REQUEST); }
        catch (Exception error) { pickerPending = false; fail("无法打开系统文件保存器"); }
        return;
      }
      if (!requestId.equals(id)) { reply(requestId, "error", "备份会话已失效"); return; }
      if ("abort".equals(op)) { fail("备份已取消"); return; }
      if (output == null) throw new IllegalStateException("Destination not selected");
      if ("chunk".equals(op)) {
        byte[] bytes = Base64.decode(value.getString("data"), Base64.NO_WRAP);
        if (bytes.length == 0 || bytes.length > CHUNK || written + bytes.length > expected) throw new IllegalArgumentException("Invalid backup chunk");
        output.write(bytes);
        written += bytes.length;
        reply(id, "ack", "");
      } else if ("end".equals(op)) {
        if (written != expected) throw new IllegalStateException("Incomplete backup");
        output.flush();
        output.close();
        output = null;
        String complete = id;
        destination = null; id = null;
        reply(complete, "done", "");
      } else throw new IllegalArgumentException("Invalid export operation");
    } catch (Exception error) { fail("保存备份失败或文件不完整，请重试；本机数据库未改动"); }
  }

  void onResult(int result, Intent data) {
    pickerPending = false;
    if (id == null) return;
    if (result != Activity.RESULT_OK || data == null || data.getData() == null) { fail("已取消保存备份"); return; }
    try {
      destination = data.getData();
      output = activity.getContentResolver().openOutputStream(destination, "wt");
      if (output == null) throw new IllegalStateException("No output stream");
      reply(id, "ready", "");
    } catch (Exception error) { fail("无法写入所选文件"); }
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
    String failed = id;
    abortFile();
    id = null;
    reply(failed, "error", message);
  }

  private void abortFile() {
    if (output != null) {
      try { output.close(); } catch (Exception ignored) {}
      output = null;
    }
    if (destination != null) {
      try { activity.getContentResolver().delete(destination, null, null); } catch (Exception ignored) {}
      destination = null;
    }
  }

  void detach() {
    abortFile();
    id = null;
    if (port != null) {
      try { port.close(); } catch (Exception ignored) {}
      port = null;
    }
  }
}
