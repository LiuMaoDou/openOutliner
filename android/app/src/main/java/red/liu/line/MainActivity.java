package red.liu.line;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import org.json.JSONTokener;

/** Personal, same-origin client. No JavaScript-to-native privileged bridge. */
public class MainActivity extends Activity {
  private static final String HOME = "https://line.liu.red/";
  private static final int FILE_PICKER = 10;
  private WebView web;
  private LinearLayout root;
  private LinearLayout errorPanel;
  private TextView errorMessage;
  private ProgressBar progress;
  private ValueCallback<Uri[]> fileCallback;
  private String mobileScript;
  private String home = HOME;
  private boolean failed;
  private final ArrayList<Button> themedButtons = new ArrayList<>();
  private final Handler themeHandler = new Handler(Looper.getMainLooper());
  private boolean darkTheme;
  private boolean themeApplied;
  private boolean resumed;
  private final Runnable themeRefresh = new Runnable() {
    @Override public void run() {
      if (!resumed) return;
      syncPageTheme();
      themeHandler.postDelayed(this, 500);
    }
  };

  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    boolean debug = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    // Only a debug build can target the isolated QA server. Release ignores extras.
    if (debug && getIntent().getStringExtra("testUrl") != null) {
      String candidate = getIntent().getStringExtra("testUrl");
      if (candidate.startsWith("http://127.0.0.1:")) home = candidate;
    }
    WebView.setWebContentsDebuggingEnabled(debug);
    root = new LinearLayout(this);
    root.setOrientation(LinearLayout.VERTICAL);
    root.setBackgroundColor(Color.rgb(250, 250, 250));
    root.setFitsSystemWindows(true);
    if (Build.VERSION.SDK_INT >= 30) {
      root.setOnApplyWindowInsetsListener((view, insets) -> {
        android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
        android.graphics.Insets keyboard = insets.getInsets(WindowInsets.Type.ime());
        view.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, keyboard.bottom));
        return WindowInsets.CONSUMED;
      });
    }
    setContentView(root);
    progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
    root.addView(progress, new LinearLayout.LayoutParams(-1, dp(3)));
    web = new WebView(this);
    web.setBackgroundColor(Color.WHITE);
    root.addView(web, new LinearLayout.LayoutParams(-1, 0, 1));
    errorPanel = new LinearLayout(this);
    errorPanel.setOrientation(LinearLayout.VERTICAL);
    errorPanel.setGravity(Gravity.CENTER);
    errorPanel.setPadding(dp(24), dp(24), dp(24), dp(24));
    errorMessage = new TextView(this);
    errorMessage.setTextColor(Color.WHITE);
    errorMessage.setGravity(Gravity.CENTER);
    errorMessage.setTextSize(17);
    errorPanel.addView(errorMessage);
    Button retry = button("重新连接");
    retry.setOnClickListener(v -> web.loadUrl(home));
    errorPanel.addView(retry);
    errorPanel.setVisibility(View.GONE);
    root.addView(errorPanel, new LinearLayout.LayoutParams(-1, 0, 1));

    LinearLayout toolbar = new LinearLayout(this);
    toolbar.setPadding(dp(6), 0, dp(6), 0);
    Button outdent = button("⇤ 取消缩进");
    outdent.setContentDescription("取消缩进，相当于 Shift 加 Tab");
    outdent.setOnClickListener(v -> command("outdent"));
    Button indent = button("⇥ 缩进");
    indent.setContentDescription("缩进，相当于 Tab");
    indent.setOnClickListener(v -> command("indent"));
    Button menu = button("⋯");
    menu.setContentDescription("应用菜单");
    menu.setOnClickListener(v -> showMenu());
    toolbar.addView(outdent, new LinearLayout.LayoutParams(0, -1, 1));
    toolbar.addView(indent, new LinearLayout.LayoutParams(0, -1, 1));
    toolbar.addView(menu, new LinearLayout.LayoutParams(dp(52), -1));
    root.addView(toolbar, new LinearLayout.LayoutParams(-1, dp(52)));
    applyTheme(false);

    WebSettings settings = web.getSettings();
    settings.setJavaScriptEnabled(true);
    settings.setDomStorageEnabled(true);
    settings.setAllowFileAccess(false);
    // Access is limited by Android's per-URI grant from the system file picker.
    settings.setAllowContentAccess(true);
    settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    settings.setUseWideViewPort(true);
    settings.setLoadWithOverviewMode(true);
    settings.setSupportMultipleWindows(false);
    CookieManager.getInstance().setAcceptCookie(true);
    CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
    mobileScript = readAsset("mobile.js");
    web.setWebViewClient(new WebViewClient() {
      @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        if (trusted(request.getUrl())) return false;
        if (request.isForMainFrame() && request.hasGesture()) openExternal(request.getUrl());
        return true;
      }
      @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
        failed = false;
        errorPanel.setVisibility(View.GONE);
        web.setVisibility(View.VISIBLE);
        progress.setVisibility(View.VISIBLE);
      }
      @Override public void onPageFinished(WebView view, String url) {
        progress.setVisibility(View.GONE);
        syncPageTheme();
        if (!failed && trusted(Uri.parse(url))) {
          web.evaluateJavascript("Boolean(window.indexedDB && window.WebAssembly && navigator.locks && window.crypto && typeof crypto.randomUUID === 'function' && typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function')", supported -> {
            if (!"true".equals(supported)) {
              showError("系统网页组件版本过旧\n请更新 Android System WebView 后重试，或通过菜单在浏览器打开。");
            } else web.evaluateJavascript(mobileScript, null);
          });
        }
        CookieManager.getInstance().flush();
      }
      @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
        if (request.isForMainFrame()) showError();
      }
      @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
        if (request.isForMainFrame() && response.getStatusCode() >= 400) showError();
      }
    });
    web.setWebChromeClient(new WebChromeClient() {
      @Override public void onProgressChanged(WebView view, int value) { progress.setProgress(value); }
      @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
        if (fileCallback != null) fileCallback.onReceiveValue(null);
        fileCallback = callback;
        try { startActivityForResult(params.createIntent(), FILE_PICKER); }
        catch (ActivityNotFoundException error) { fileCallback.onReceiveValue(null); fileCallback = null; toast("未找到文件选择器"); }
        return true;
      }
    });
    web.setDownloadListener((url, agent, disposition, mime, length) -> {
      if (url.startsWith("https://")) openExternal(Uri.parse(url));
      else toast("此版本暂不支持本机导出下载，请在电脑端导出已同步的笔记");
    });
    if (Build.VERSION.SDK_INT >= 33) {
      getOnBackInvokedDispatcher().registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::goBack);
    }
    // The database belongs to the website. Reload from its persistent storage
    // after process recreation; never clear cookies, cache or IndexedDB here.
    web.loadUrl(home);
  }

  private Button button(String title) {
    Button button = new Button(this);
    button.setText(title);
    button.setTextSize(14);
    button.setAllCaps(false);
    themedButtons.add(button);
    button.setMinWidth(0);
    button.setMinimumWidth(0);
    button.setPadding(dp(6), 0, dp(6), 0);
    // A toolbar tap must not dismiss the IME or blur the node title.
    button.setFocusable(false);
    button.setFocusableInTouchMode(false);
    return button;
  }

  // Read only the trusted page's resolved theme; no privileged JS bridge is exposed.
  private void syncPageTheme() {
    if (web == null || web.getUrl() == null || !trusted(Uri.parse(web.getUrl())) || failed) return;
    web.evaluateJavascript("document.documentElement.classList.contains('dark')", value -> {
      if (resumed && web.getUrl() != null && trusted(Uri.parse(web.getUrl())) && !failed) {
        applyTheme("true".equals(value));
      }
    });
  }

  private void applyTheme(boolean dark) {
    if (themeApplied && darkTheme == dark) return;
    darkTheme = dark;
    themeApplied = true;
    int background = dark ? Color.rgb(32, 35, 41) : Color.rgb(250, 250, 250);
    int foreground = dark ? Color.rgb(231, 236, 231) : Color.rgb(24, 24, 27);
    int buttonBackground = dark ? Color.rgb(45, 49, 55) : Color.rgb(244, 244, 245);
    root.setBackgroundColor(background);
    web.setBackgroundColor(dark ? Color.rgb(9, 9, 11) : Color.WHITE);
    errorMessage.setTextColor(foreground);
    for (Button button : themedButtons) {
      button.setTextColor(foreground);
      button.setBackgroundTintList(android.content.res.ColorStateList.valueOf(buttonBackground));
    }
    getWindow().setStatusBarColor(background);
    getWindow().setNavigationBarColor(background);
    if (Build.VERSION.SDK_INT >= 30) {
      WindowInsetsController controller = getWindow().getInsetsController();
      if (controller != null) {
        int lightBars = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
          | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
        controller.setSystemBarsAppearance(dark ? 0 : lightBars, lightBars);
      }
    } else {
      View decor = getWindow().getDecorView();
      int lightBars = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
      int flags = decor.getSystemUiVisibility();
      decor.setSystemUiVisibility(dark ? flags & ~lightBars : flags | lightBars);
    }
  }

  private boolean trusted(Uri url) {
    Uri base = Uri.parse(home);
    return base.getScheme().equals(url.getScheme()) && base.getHost().equals(url.getHost())
      && base.getPort() == url.getPort() && url.getUserInfo() == null;
  }

  private void command(String name) {
    if (web.getUrl() == null || !trusted(Uri.parse(web.getUrl())) || failed) return;
    web.evaluateJavascript("window.openOutlinerAndroidCommand ? window.openOutlinerAndroidCommand('" + name + "') : '页面正在加载，请稍后重试'", value -> {
      try {
        Object result = new JSONTokener(value).nextValue();
        if (result instanceof String && !((String) result).isEmpty()) toast((String) result);
      } catch (Exception ignored) { toast("请等待页面加载完成"); }
    });
  }

  private void showMenu() {
    new AlertDialog.Builder(this).setTitle("OpenOutliner · line.liu.red")
      .setItems(new String[]{"重新加载页面", "在浏览器打开", "使用说明"}, (dialog, which) -> {
        if (which == 0) new AlertDialog.Builder(this).setMessage("确认重新加载？请先结束当前输入，等待本机保存完成。")
          .setPositiveButton("重新加载", (d, w) -> web.reload()).setNegativeButton("取消", null).show();
        if (which == 1) openExternal(Uri.parse(HOME));
        if (which == 2) new AlertDialog.Builder(this).setTitle("手机编辑")
          .setMessage("先点选节点标题，再点底部的缩进或取消缩进。缩进会变成前一个同级节点的子节点；取消缩进会向上移一级。\n\n中文输入时请先确认候选字。首个同级节点无法继续缩进，顶层节点无法取消缩进。\n\n首次使用需要联网。离线能力取决于系统 WebView 和页面缓存；请确认页面显示已同步后再卸载或清除应用数据。\n\n当前版本不支持网页生成的本机导出文件，请在电脑端导出已同步的笔记。")
          .setPositiveButton("知道了", null).show();
      }).show();
  }

  private void showError() {
    showError("暂时无法打开笔记\n请检查网络后重试。已保存的本机数据会保留。");
  }

  private void showError(String message) {
    failed = true;
    errorMessage.setText(message);
    web.setVisibility(View.GONE);
    errorPanel.setVisibility(View.VISIBLE);
    progress.setVisibility(View.GONE);
  }

  private void openExternal(Uri uri) {
    if (!"https".equals(uri.getScheme()) && !"http".equals(uri.getScheme()) && !"mailto".equals(uri.getScheme())) {
      toast("暂不支持打开此链接"); return;
    }
    try { startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)); }
    catch (ActivityNotFoundException error) { toast("没有可打开此链接的应用"); }
  }

  private void goBack() {
    web.evaluateJavascript("(() => { const d = document.querySelector('dialog[open]'); if(d) return true; document.activeElement?.blur(); return false; })()", result -> {
      if ("true".equals(result)) { toast("请先使用页面按钮关闭弹窗"); return; }
      if (web.canGoBack()) web.goBack();
      else moveTaskToBack(true);
    });
  }

  @Override public void onBackPressed() { goBack(); }
  @Override protected void onResume() {
    super.onResume();
    resumed = true;
    themeHandler.post(themeRefresh);
  }
  @Override protected void onPause() {
    resumed = false;
    themeHandler.removeCallbacks(themeRefresh);
    super.onPause();
    CookieManager.getInstance().flush();
    // Keep WebView timers alive until Android suspends the process, allowing
    // the website to finish its pending local save and foreground sync.
  }
  @Override protected void onActivityResult(int request, int result, Intent data) {
    super.onActivityResult(request, result, data);
    if (request == FILE_PICKER && fileCallback != null) {
      fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
      fileCallback = null;
    }
  }
  @Override protected void onDestroy() {
    resumed = false;
    themeHandler.removeCallbacks(themeRefresh);
    if (fileCallback != null) fileCallback.onReceiveValue(null);
    root.removeView(web);
    web.destroy();
    super.onDestroy();
  }
  private String readAsset(String name) {
    try (InputStream input = getAssets().open(name); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
      byte[] buffer = new byte[4096]; int count;
      while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
      return output.toString("UTF-8");
    } catch (Exception error) { throw new IllegalStateException("Missing mobile controls", error); }
  }
  private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
  private void toast(String value) { Toast.makeText(this, value, Toast.LENGTH_SHORT).show(); }
}
