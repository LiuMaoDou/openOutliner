#!/bin/bash
# Build with the Android SDK and JDK only; no Gradle/Maven downloads required.
set -euo pipefail
cd "$(dirname "$0")"
mode="${1:-release}"
if [[ "$mode" != release && "$mode" != debug ]]; then echo "Usage: $0 [release|debug]" >&2; exit 1; fi
sdk="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/Library/Android/sdk}}"
tools="$sdk/build-tools/${ANDROID_BUILD_TOOLS:-36.0.0}"
platform="$sdk/platforms/${ANDROID_PLATFORM:-android-36.1}/android.jar"
java_bin="${JAVA_HOME:-$(/usr/libexec/java_home)}/bin"
out="build/$mode"
mkdir -p "$out/classes" "$out/dex" "$out/generated" "$out/package"
cp app/src/main/AndroidManifest.xml "$out/AndroidManifest.xml"
if [[ "$mode" == debug ]]; then
  python3 - "$out/AndroidManifest.xml" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
p.write_text(p.read_text().replace('android:debuggable="false"', 'android:debuggable="true"').replace('android:usesCleartextTraffic="false"', 'android:usesCleartextTraffic="true"'))
PY
fi
"$tools/aapt2" compile --dir app/src/main/res -o "$out/resources.zip"
"$tools/aapt2" link -o "$out/resources.apk" -I "$platform" --manifest "$out/AndroidManifest.xml" --java "$out/generated" -A app/src/main/assets "$out/resources.zip"
find app/src/main/java "$out/generated" -name '*.java' > "$out/sources.txt"
"$java_bin/javac" -encoding UTF-8 -source 8 -target 8 -bootclasspath "$platform:$tools/core-lambda-stubs.jar" -d "$out/classes" @"$out/sources.txt"
"$java_bin/jar" cf "$out/classes.jar" -C "$out/classes" .
"$tools/d8" --lib "$platform" --min-api 26 --output "$out/dex" "$out/classes.jar"
cp "$out/resources.apk" "$out/unsigned.apk"
(cd "$out/dex" && zip -q -u ../unsigned.apk classes*.dex)
"$tools/zipalign" -f -p 4 "$out/unsigned.apk" "$out/aligned.apk"

# Keep the personal signing identity outside the repository for future updates.
signing="${OPENOUTLINER_SIGNING_DIR:-$HOME/.local/share/openoutliner/android-signing}"
mkdir -p "$signing"
chmod 700 "$signing"
key="$signing/$mode.jks"
password="$signing/$mode.password"
if [[ ! -f "$key" ]]; then
  if [[ ! -f "$password" ]]; then (umask 077; openssl rand -base64 32 > "$password"); fi
  "$java_bin/keytool" -genkeypair -keystore "$key" -storepass:file "$password" -keypass:file "$password" -alias openoutliner -keyalg RSA -keysize 3072 -validity 10000 -dname "CN=OpenOutliner Personal, O=liu.red" -storetype JKS
  chmod 600 "$key"
fi
apk="$out/OpenOutliner-0.1.1-$mode.apk"
"$tools/apksigner" sign --ks "$key" --ks-key-alias openoutliner --ks-pass "file:$password" --out "$apk" "$out/aligned.apk"
"$tools/apksigner" verify --verbose "$apk"
shasum -a 256 "$apk" > "$apk.sha256"
echo "APK: $(pwd)/$apk"
