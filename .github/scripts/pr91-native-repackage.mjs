import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, readdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const input = process.env.ARDIA_CI_INPUT;
const out = process.env.ARDIA_CI_OUTPUT;
const compiledSHA = '1ac6e39a726aa1641d485e43fb3e93e225af3829';
const demand = (condition, reason) => { if (!condition) throw new Error(reason); };
const text = file => readFileSync(file, 'utf8');
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const capture = (command, args, file) => {
  try {
    const stdout = execFileSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    writeFileSync(file, stdout);
    return stdout.trim();
  } catch (error) {
    writeFileSync(file, String(error.stdout ?? '') + String(error.stderr ?? '') + '\n');
    throw error;
  }
};
const signedCapture = (args, file) => {
  const result = Bun.spawnSync(['/usr/bin/codesign', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const output = Buffer.concat([result.stdout, result.stderr]).toString('utf8');
  writeFileSync(file, output);
  demand(result.exitCode === 0, 'codesign failed with status ' + result.exitCode + '; see ' + file);
  return output.trim();
};

try {
  demand(input && out && process.env.RUNNER_TEMP, 'Missing artifact directories');
  demand(process.env.GITHUB_REPOSITORY === 'aaditagrawal/ardia', 'Unexpected repository');
  demand(process.env.DEVELOPER_DIR === '/Applications/Xcode_27.app/Contents/Developer', 'Unexpected Xcode selection');
  mkdirSync(out, { recursive: true });
  const startedAt = new Date().toISOString();
  const packagingXcode = capture('xcodebuild', ['-version'], join(out, 'packaging-xcode-version.txt'));
  const packagingSDK = capture('xcrun', ['--sdk', 'macosx', '--show-sdk-version'], join(out, 'packaging-sdk-version.txt'));
  demand(/^Xcode 27\./.test(packagingXcode) && /^27\./.test(packagingSDK), 'Packaging requires the selected SDK 27 toolchain');
  const manifest = JSON.parse(text(join(input, 'manifest.json')));
  demand(manifest.sourceGitSHA === compiledSHA && manifest.sourceSnapshot.files.length === 19, 'Unexpected compiled source snapshot');
  demand(manifest.nativeApi.native === 13 && manifest.nativeApi.javascript === 13 && manifest.nativeApi.snapshotBlobsVerified === true, 'Unexpected native API');
  demand(manifest.configuration === 'Debug' && manifest.bundledJavascript.dev === true, 'Input is not bundled Debug');
  demand(manifest.engine.tree === '2c67e141131843cf5c74c72f67378e891810a46b' && manifest.engine.archiveSHA256 === '8177d5324bef7f5e371bbc6b4fdc857b11605350772186b4ab0d4f8b7dcf8e62' && manifest.engine.downloadChecksumVerified === true, 'Input engine provenance mismatch');
  demand(manifest.registeredHookNamesInBinary === 'devLeftEdgePointer=1\ndevLeftEdgeStats=1', 'Native hook probe did not pass');
  demand(text(join(input, 'build-wrapper.log')).includes('BUILD SUCCEEDED'), 'Input native build did not succeed');
  demand(manifest.codesignVerification.exitCode === 1 && manifest.codesignVerification.result.includes('In subcomponent: ') && manifest.codesignVerification.result.includes('/Sparkle.framework'), 'Input signature failure is not the known embedded Sparkle failure');
  execFileSync('git', ['diff', '--exit-code', compiledSHA, 'HEAD', '--', 'apps', 'packages', 'engine'], { stdio: 'pipe' });
  for (const file of manifest.sourceSnapshot.files) demand(git('rev-parse', 'HEAD:' + file.path) === file.blob, 'Feature source changed: ' + file.path);
  demand(git('rev-parse', 'HEAD:engine') === manifest.engine.tree, 'Engine tree changed');
  const archive = join(input, 'Ardia-pr91-native-Debug.tar.gz');
  const inputHash = hash(archive);
  demand(inputHash === manifest.archive.sha256 && inputHash === text(archive + '.sha256').trim().split(/\s+/)[0], 'Input archive checksum mismatch');
  const paths = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim().split('\n');
  demand(paths.every(path => path.startsWith('Ardia.app/') && !path.split('/').includes('..')), 'Unexpected archive entry');
  for (const entry of readdirSync(input)) {
    if (['manifest.json', 'Ardia-pr91-native-Debug.tar.gz', 'Ardia-pr91-native-Debug.tar.gz.sha256', 'codesign-verify.txt', 'codesign-details.txt'].includes(entry)) continue;
    copyFileSync(join(input, entry), join(out, entry));
  }
  copyFileSync(join(input, 'manifest.json'), join(out, 'compiled-build-manifest.json'));
  copyFileSync(join(input, 'codesign-verify.txt'), join(out, 'compiled-codesign-verify.txt'));
  const work = mkdtempSync(join(process.env.RUNNER_TEMP, 'ardia-pr91-sign-'));
  execFileSync('tar', ['-xzf', archive, '-C', work], { stdio: 'inherit' });
  const app = join(work, 'Ardia.app');
  const image = text(join(input, 'debug-code-image.txt')).trim();
  demand(image === 'Contents/MacOS/Ardia.debug.dylib', 'Unexpected Debug code image');
  const files = { nativeDebugImage: join(app, image), javascriptBundle: join(app, 'Contents/Resources/main.jsbundle'), chromiumFramework: join(app, 'Contents/Frameworks/Chromium Framework.framework/Versions/Current/Chromium Framework') };
  const before = Object.fromEntries(Object.entries(files).map(([name, file]) => [name, hash(file)]));
  demand(before.javascriptBundle === manifest.javascriptBundleSHA256.split(/\s+/)[0], 'Input bundled JavaScript hash mismatch');
  const signArgs = ['--force', '--sign', '-', '--timestamp=none', '--preserve-metadata=identifier,entitlements,flags'];
  signedCapture([...signArgs, join(app, 'Contents/Frameworks/Sparkle.framework')], join(out, 'sparkle-resign.txt'));
  signedCapture([...signArgs, join(app, 'Contents/Frameworks/hermes.framework')], join(out, 'hermes-resign.txt'));
  signedCapture([...signArgs, app], join(out, 'app-resign.txt'));
  const signatureResult = signedCapture(['--verify', '--deep', '--strict', '--verbose=2', app], join(out, 'codesign-verify.txt'));
  signedCapture(['-dvv', app], join(out, 'codesign-details.txt'));
  const after = Object.fromEntries(Object.entries(files).map(([name, file]) => [name, hash(file)]));
  demand(JSON.stringify(before) === JSON.stringify(after), 'Compiled application code, JavaScript or engine changed during signing');
  const outputArchive = join(out, 'Ardia-pr91-native-Debug.tar.gz');
  execFileSync('tar', ['-czf', outputArchive, '-C', work, 'Ardia.app'], { stdio: 'inherit', env: { ...process.env, COPYFILE_DISABLE: '1' } });
  const digest = hash(outputArchive);
  writeFileSync(outputArchive + '.sha256', digest + '  ' + outputArchive + '\n');
  const buildRunURL = manifest.runURL;
  const buildStartedAt = manifest.startedAt;
  const buildFinishedAt = manifest.finishedAt;
  const packagingSHA = git('rev-parse', 'HEAD');
  const runURL = process.env.GITHUB_SERVER_URL + '/' + process.env.GITHUB_REPOSITORY + '/actions/runs/' + process.env.GITHUB_RUN_ID;
  const packaging = { inputRunURL: buildRunURL, inputArchiveSHA256: inputHash, packagingGitSHA: packagingSHA, tools: { xcode: packagingXcode, sdk: packagingSDK }, signaturesReplaced: ['Contents/Frameworks/Sparkle.framework', 'Contents/Frameworks/hermes.framework', 'Ardia.app'], compiledContentSHA256Before: before, compiledContentSHA256After: after, compiledContentUnchanged: true, codesignVerificationExitCode: 0 };
  writeFileSync(join(out, 'repackage-provenance.json'), JSON.stringify(packaging, null, 2) + '\n');
  const result = { ...manifest, runURL, buildRunURL, buildStartedAt, buildFinishedAt, startedAt, finishedAt: new Date().toISOString(), exitCode: 0, phase: 'complete', packagingGitSHA: packagingSHA, packaging, codesignVerification: { exitCode: 0, result: signatureResult }, archive: { file: 'Ardia-pr91-native-Debug.tar.gz', sha256: digest } };
  demand(result.codesignVerification.exitCode === 0 && result.packaging.compiledContentUnchanged === true, 'Signature acceptance failed');
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(result, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ runURL, compiledSourceSHA: compiledSHA, packagingGitSHA: packagingSHA, archiveSHA256: digest, compiledContentUnchanged: true, strictCodesignPassed: true }, null, 2) + '\n');
} catch (error) {
  if (out) {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'repackage-failure.txt'), String(error.stack ?? error) + '\n');
  }
  process.stderr.write(String(error.stack ?? error) + '\n');
  process.exit(1);
}
