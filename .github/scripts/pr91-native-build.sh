#!/usr/bin/env bash
set -euo pipefail

repo=$(git rev-parse --show-toplevel)
cd "$repo"
here=$(cd "$(dirname "$0")" && pwd)
out=${ARDIA_CI_OUTPUT:?ARDIA_CI_OUTPUT is required}
mkdir -p "$out"
exec > >(tee -a "$out/runner.log") 2>&1
export ARDIA_CI_OUTPUT="$out"
export ARDIA_CI_SOURCE_SHA=$(git rev-parse HEAD)
export ARDIA_CI_ENGINE_TREE=2c67e141131843cf5c74c72f67378e891810a46b
export ARDIA_CI_ENGINE_VERSION=0.2.40-nightly.5
export ARDIA_CI_ENGINE_SHA256=8177d5324bef7f5e371bbc6b4fdc857b11605350772186b4ab0d4f8b7dcf8e62
export ARDIA_CI_ENGINE_VERIFIED=false
export ARDIA_CI_CODESIGN_EXIT=not-run
export ARDIA_CI_STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
export ARDIA_CI_PHASE=preflight
derived="$repo/apps/browser/build-pr91-native"
app="$derived/Build/Products/Debug/Ardia.app"

finish() {
  result=$?
  trap - EXIT
  export ARDIA_CI_EXIT="$result"
  export ARDIA_CI_FINISHED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  if [[ -f "$derived/build-app.log" ]]; then
    cp "$derived/build-app.log" "$out/build-app.log" || true
  fi
  df -h . > "$out/disk-final.txt" 2>&1 || true
  bun "$here/pr91-native-manifest.mjs" || { if [[ "$result" == 0 ]]; then result=1; fi; }
  exit "$result"
}
trap finish EXIT

[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]]
[[ "${GITHUB_REPOSITORY:-}" == aaditagrawal/ardia ]]
[[ "${GITHUB_REF:-}" == refs/heads/verify/right-sidebar-native ]]
bun "$here/pr91-native-manifest.mjs" --source
[[ "$(git rev-parse HEAD:engine)" == "$ARDIA_CI_ENGINE_TREE" ]]
[[ -z "$(git status --porcelain -- engine)" ]]
awk -v tree="$ARDIA_CI_ENGINE_TREE" -v version="$ARDIA_CI_ENGINE_VERSION" -v sha="$ARDIA_CI_ENGINE_SHA256" \
  '$1 == tree && $2 == version && $3 == sha { found = 1 } END { exit !found }' \
  packages/ardiacore/prebuilt-engines.tsv
[[ "$(bun --version)" == 1.4.4 ]]
node -e 'if (Number(process.versions.node.split(".")[0]) < 24) process.exit(1)'
node --version > "$out/node-version.txt"
bun --version > "$out/bun-version.txt"
pod --version > "$out/cocoapods-version.txt"
xcodebuild -version > "$out/xcode-version.txt"
xcode-select -p > "$out/developer-directory.txt"
xcrun --sdk macosx --show-sdk-version > "$out/sdk-version.txt"
df -h . > "$out/disk-initial.txt"
cp "$here/pr91-native-signing.xcconfig" "$out/ci-signing.xcconfig"
export XCODE_XCCONFIG_FILE="$out/ci-signing.xcconfig"
export FORCE_BUNDLING=1
export RCT_NEW_ARCH_ENABLED=0
unset SKIP_BUNDLING

export ARDIA_CI_PHASE=dependencies
scripts/agent/locked pod --wait 120 -- \
  bun x --package pnpm@11.1.3 pnpm install --frozen-lockfile \
  2>&1 | tee "$out/dependencies.log"

export ARDIA_CI_PHASE=pods
if scripts/agent/locked pod --wait 120 -- \
  sh -c 'cd apps/browser/macos && pod install --deployment' \
  2>&1 | tee "$out/pods.log"; then
  :
else
  bun "$here/pr91-native-manifest.mjs" --relocate-pod-lock
  scripts/agent/locked pod --wait 120 -- \
    sh -c 'cd apps/browser/macos && pod install --deployment' \
    2>&1 | tee "$out/pods-retry.log"
fi
git diff --exit-code -- package.json pnpm-lock.yaml pnpm-workspace.yaml
bun "$here/pr91-native-manifest.mjs" --pod-lock

export ARDIA_CI_PHASE=engine
export ARDIACORE_PREBUILT_REPO=mantrakp04/ardia
export ARDIACORE_PREBUILT_ASSETS=https://github.com/mantrakp04/ardia/releases/download
ARDIACORE_FRAMEWORK=$(packages/ardiacore/scripts/fetch-engine.sh 2> >(tee "$out/engine.log" >&2))
export ARDIACORE_FRAMEWORK
[[ "$ARDIACORE_FRAMEWORK" == "$repo/apps/browser/build-ardiacore/prebuilt/2c67e1411318/Chromium Framework.framework" ]]
[[ -f "$ARDIACORE_FRAMEWORK/Versions/Current/Chromium Framework" ]]
export ARDIA_CI_ENGINE_VERIFIED=true

export ARDIA_CI_PHASE=build-settings
xcodebuild -workspace apps/browser/macos/Ardia.xcworkspace -scheme Ardia-macOS \
  -derivedDataPath "$derived" -destination 'platform=macOS,arch=arm64' \
  -configuration Debug -hideShellScriptEnvironment -showBuildSettings -json \
  > "$out/settings.raw.json" 2> "$out/build-settings.log"
xcodebuild -project apps/browser/macos/Pods/Pods.xcodeproj -target ArdiaShell \
  -sdk macosx -configuration Debug -hideShellScriptEnvironment -showBuildSettings -json \
  > "$out/settings.shell.raw.json" 2> "$out/shell-build-settings.log"
bun "$here/pr91-native-manifest.mjs" --settings
rm "$out/settings.raw.json" "$out/settings.shell.raw.json"

export ARDIA_CI_PHASE=build
scripts/agent/build-app --as pr91-native --config Debug --force --wait 120 \
  2>&1 | tee "$out/build-wrapper.log"

export ARDIA_CI_PHASE=package
[[ -x "$app/Contents/MacOS/Ardia" ]]
[[ -s "$app/Contents/Resources/main.jsbundle" ]]
bun "$here/pr91-native-manifest.mjs" --bundle "$derived/Build/Products/Debug/main.jsbundle"
shasum -a 256 "$app/Contents/Resources/main.jsbundle" > "$out/main.jsbundle.sha256"
LC_ALL=C /usr/bin/strings -a "$app/Contents/MacOS/Ardia" | \
  awk '/devLeftEdgePointer/ { pointer = 1 } /devLeftEdgeStats/ { stats = 1 } END { print "devLeftEdgePointer=" pointer + 0; print "devLeftEdgeStats=" stats + 0; exit !(pointer && stats) }' \
  > "$out/debug-hooks.txt"
codesign -dvv "$app" > "$out/codesign-details.txt" 2>&1
if codesign --verify --deep --strict --verbose=2 "$app" > "$out/codesign-verify.txt" 2>&1; then
  export ARDIA_CI_CODESIGN_EXIT=0
else
  export ARDIA_CI_CODESIGN_EXIT=$?
fi
COPYFILE_DISABLE=1 tar -czf "$out/Ardia-pr91-native-Debug.tar.gz" \
  -C "$derived/Build/Products/Debug" Ardia.app
shasum -a 256 "$out/Ardia-pr91-native-Debug.tar.gz" > "$out/Ardia-pr91-native-Debug.tar.gz.sha256"
git diff --exit-code -- package.json pnpm-lock.yaml pnpm-workspace.yaml
bun "$here/pr91-native-manifest.mjs" --pod-lock
[[ "$ARDIA_CI_CODESIGN_EXIT" == 0 ]]
export ARDIA_CI_PHASE=complete
