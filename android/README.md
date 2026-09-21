# OpenOutliner Android

个人 Android 客户端，固定连接 `https://line.liu.red/`。使用系统 WebView，不依赖 Google Play 服务。Android 8.0（API 26）及以上；能否在华为手机安装取决于该手机当前系统是否支持 Android APK。

## 功能

- 沿用网站的同源登录、IndexedDB 本机保存、同步及冲突处理，不改动服务端。
- 底部「缩进」「取消缩进」对应节点标题的 Tab / Shift+Tab，直接调用页面原有键盘处理，移动真实节点层级，保留撤销及同步行为。
- 先点选节点标题再操作；首个同级节点不能缩进，顶层节点不能取消缩进。中文候选字未确认时提示先完成输入，不强行结束输入法组合。
- 底部工具栏和系统栏跟随网页的亮色、暗色或系统主题，切换后自动更新。
- 工具栏不抢编辑焦点；窗口随软键盘调整，支持横竖屏与折叠屏窗口尺寸变化。
- 登录 Cookie 保留；支持系统文件选择器导入；外链交给浏览器；连接失败可重试。
- 只允许 HTTPS 网站留在应用内，不忽略证书错误，不暴露 JavaScript 原生权限桥，不申请存储全盘读写权限。

这是网页外壳首版。首次使用需要网络；离线启动依赖网站 Service Worker 缓存及设备 WebView 能力，后台同步不作保证。原生工具栏随 APK 更新，网页随服务器更新。网站通过 Blob 生成的导出文件暂不支持下载，请在电脑端导出已同步内容。卸载或清除数据前先确认同步完成。

## 构建

依赖 JDK 17、Android SDK Platform 36.1、Build Tools 36.0.0、Python 3、zip、OpenSSL。无需 Gradle 或 Maven 下载。macOS 默认使用 `~/Library/Android/sdk`，可通过 `ANDROID_SDK_ROOT`、`JAVA_HOME`、`ANDROID_PLATFORM` 和 `ANDROID_BUILD_TOOLS` 覆盖。

```sh
bash android/build.sh release
bash android/build.sh debug
```

产物：`android/build/release/OpenOutliner-0.1.1-release.apk`，附 SHA-256 文件。发布包关闭 WebView 调试和明文 HTTP。

个人签名自动生成在 `~/.local/share/openoutliner/android-signing/`（或 `OPENOUTLINER_SIGNING_DIR`），不进入 Git。请安全备份整个签名目录；后续覆盖安装必须使用同一签名，并增加 Manifest 的 `versionCode`。debug 和 release 使用不同签名；切换包时请保留已有数据或使用独立测试模拟器。

## 隔离测试

debug 包允许启动参数 `testUrl=http://127.0.0.1:4318/`，用于 `adb reverse tcp:4318 tcp:4318` 后连接临时数据库服务。发布包完全忽略该参数。

```sh
adb install android/build/debug/OpenOutliner-0.1.1-debug.apk
adb reverse tcp:4318 tcp:4318
adb shell am start -n red.liu.line/.MainActivity --es testUrl http://127.0.0.1:4318/
```

验收：标题输入 → 缩进成为前一个同级节点的子节点 → 取消缩进恢复同级 → 文本保持不变 → 刷新及离线重启仍保留 → 恢复联网同步。另检查登录保持、返回、外链、键盘遮挡和屏幕尺寸切换。禁止对线上个人笔记做破坏性测试。
