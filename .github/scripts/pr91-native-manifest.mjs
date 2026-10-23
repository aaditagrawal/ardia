import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const env = process.env;
const out = env.ARDIA_CI_OUTPUT;
const settingsFile = join(out, 'build-settings.json');
const keys = ['ARCHS', 'CONFIGURATION', 'SDKROOT', 'SDK_VERSION', 'MACOSX_DEPLOYMENT_TARGET', 'CODE_SIGN_STYLE', 'CODE_SIGN_IDENTITY', 'DEVELOPMENT_TEAM', 'CODE_SIGN_ENTITLEMENTS', 'CODE_SIGNING_ALLOWED', 'CODE_SIGNING_REQUIRED', 'ENABLE_HARDENED_RUNTIME', 'FORCE_BUNDLING', 'GCC_PREPROCESSOR_DEFINITIONS', 'SWIFT_ACTIVE_COMPILATION_CONDITIONS', 'SWIFT_OPTIMIZATION_LEVEL', 'OTHER_SWIFT_FLAGS', 'PRODUCT_BUNDLE_IDENTIFIER', 'ARDIACORE_STAGE_DIR'];

if (process.argv.includes('--source')) {
  const snapshot = JSON.parse(readFileSync(join(import.meta.dirname, 'pr91-native-source.json'), 'utf8'));
  for (const file of snapshot.files) {
    const blob = execFileSync('git', ['rev-parse', 'HEAD:' + file.path], { encoding: 'utf8' }).trim();
    if (blob !== file.blob) throw new Error('Snapshot source blob mismatch: ' + file.path);
  }
  const nativeSource = readFileSync('packages/shell/ios/AppModule.swift', 'utf8');
  const jsSource = readFileSync('apps/browser/src/nativeApi.tsx', 'utf8');
  const native = Number(nativeSource.match(/Constant\("apiVersion"\)\s*\{\s*\(\)\s*->\s*Int\s+in\s+(\d+)/)?.[1]);
  const javascript = Number(jsSource.match(/NATIVE_API_VERSION\s*=\s*(\d+)/)?.[1]);
  if (native !== 13 || javascript !== 13) throw new Error('Native and JavaScript API versions must both be 13');
  writeFileSync(join(out, 'source-snapshot.json'), JSON.stringify(snapshot, null, 2) + '\n');
  writeFileSync(join(out, 'source-api.json'), JSON.stringify({ expected: 13, native, javascript, snapshotBlobsVerified: true, runtimeVerified: false }, null, 2) + '\n');
} else if (process.argv.includes('--settings')) {
  const settings = [...JSON.parse(readFileSync(join(out, 'settings.raw.json'), 'utf8')), ...JSON.parse(readFileSync(join(out, 'settings.shell.raw.json'), 'utf8'))];
  const filtered = settings.map(({ target, buildSettings }) => ({ target, settings: Object.fromEntries(keys.filter(key => key in buildSettings).map(key => [key, buildSettings[key]])) }));
  writeFileSync(settingsFile, JSON.stringify(filtered, null, 2) + '\n');
  const app = filtered.find(item => item.target === 'Ardia-macOS');
  if (!app) throw new Error('App build settings are missing');
  const expected = { CONFIGURATION: 'Debug', CODE_SIGN_STYLE: 'Manual', CODE_SIGN_IDENTITY: '-', DEVELOPMENT_TEAM: '', CODE_SIGN_ENTITLEMENTS: '', CODE_SIGNING_ALLOWED: 'YES', CODE_SIGNING_REQUIRED: 'NO', ENABLE_HARDENED_RUNTIME: 'NO', FORCE_BUNDLING: '1' };
  for (const [key, value] of Object.entries(expected)) {
    if ((app.settings[key] ?? '') !== value) throw new Error('Unexpected build setting: ' + key);
  }
  if (!String(app.settings.SWIFT_ACTIVE_COMPILATION_CONDITIONS ?? '').split(/\s+/).includes('DEBUG')) throw new Error('Swift DEBUG condition is missing');
  const shell = filtered.find(item => item.target === 'ArdiaShell');
  if (!shell || !String(shell.settings.SWIFT_ACTIVE_COMPILATION_CONDITIONS ?? '').split(/\s+/).includes('DEBUG')) throw new Error('ArdiaShell Swift DEBUG condition is missing');
} else if (process.argv.includes('--bundle')) {
  const file = process.argv[process.argv.indexOf('--bundle') + 1];
  const text = readFileSync(file, 'utf8');
  if (!/\b__DEV__\s*=\s*true\b/.test(text)) throw new Error('Bundled JavaScript does not declare __DEV__=true');
  writeFileSync(join(out, 'bundle-validation.json'), JSON.stringify({ dev: true, metroSourceBundleSHA256: createHash('sha256').update(text).digest('hex'), bundledRuntimeVerified: false }, null, 2) + '\n');
} else {
  const archive = join(out, 'Ardia-pr91-native-Debug.tar.gz');
  const version = name => existsSync(join(out, name)) ? readFileSync(join(out, name), 'utf8').trim() : null;
  const manifest = {
    sourceGitSHA: env.ARDIA_CI_SOURCE_SHA,
    sourceRepository: env.GITHUB_REPOSITORY,
    sourceRef: env.GITHUB_REF,
    runURL: env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID ? env.GITHUB_SERVER_URL + '/' + env.GITHUB_REPOSITORY + '/actions/runs/' + env.GITHUB_RUN_ID : null,
    startedAt: env.ARDIA_CI_STARTED_AT,
    finishedAt: env.ARDIA_CI_FINISHED_AT,
    exitCode: Number(env.ARDIA_CI_EXIT),
    phase: env.ARDIA_CI_PHASE,
    engine: { tree: env.ARDIA_CI_ENGINE_TREE, version: env.ARDIA_CI_ENGINE_VERSION, archiveSHA256: env.ARDIA_CI_ENGINE_SHA256, downloadChecksumVerified: env.ARDIA_CI_ENGINE_VERIFIED === 'true', assetURL: 'https://github.com/mantrakp04/ardia/releases/download/v' + env.ARDIA_CI_ENGINE_VERSION + '/ArdiaCore-' + env.ARDIA_CI_ENGINE_TREE.slice(0, 12) + '.tar.xz' },
    configuration: 'Debug',
    forceBundling: true,
    javascriptDev: true,
    nativeApi: existsSync(join(out, 'source-api.json')) ? JSON.parse(readFileSync(join(out, 'source-api.json'), 'utf8')) : { expected: 13, runtimeVerified: false },
    registeredHookNamesInBinary: version('debug-hooks.txt'),
    bundledJavascript: existsSync(join(out, 'bundle-validation.json')) ? JSON.parse(readFileSync(join(out, 'bundle-validation.json'), 'utf8')) : null,
    javascriptBundleSHA256: version('main.jsbundle.sha256'),
    sourceSnapshot: existsSync(join(out, 'source-snapshot.json')) ? JSON.parse(readFileSync(join(out, 'source-snapshot.json'), 'utf8')) : null,
    buildCommand: 'scripts/agent/build-app --as pr91-native --config Debug --force --wait 120',
    signingOverrides: version('ci-signing.xcconfig'),
    buildSettings: existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, 'utf8')) : null,
    tools: { xcode: version('xcode-version.txt'), sdk: version('sdk-version.txt'), node: version('node-version.txt'), bun: version('bun-version.txt'), cocoaPods: version('cocoapods-version.txt'), pnpm: '11.1.3' },
    codesignVerification: { exitCode: env.ARDIA_CI_CODESIGN_EXIT === 'not-run' ? null : Number(env.ARDIA_CI_CODESIGN_EXIT), result: version('codesign-verify.txt') },
    archive: existsSync(archive) ? { file: 'Ardia-pr91-native-Debug.tar.gz', sha256: createHash('sha256').update(readFileSync(archive)).digest('hex') } : null,
    applicationLaunched: false
  };
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}
