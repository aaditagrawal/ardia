import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const [app, image] = process.argv.slice(2);
const out = process.env.ARDIA_CI_OUTPUT;
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const paths = { nativeCodeImage: join(app, image), javascriptBundle: join(app, 'Contents/Resources/main.jsbundle'), chromiumFramework: join(app, 'Contents/Frameworks/Chromium Framework.framework/Versions/Current/Chromium Framework') };
const before = Object.fromEntries(Object.entries(paths).map(([name, path]) => [name, hash(path)]));
const executableBefore = hash(join(app, 'Contents/MacOS/Ardia'));
for (const [name, target] of [['sparkle', join(app, 'Contents/Frameworks/Sparkle.framework')], ['hermes', join(app, 'Contents/Frameworks/hermes.framework')], ['app', app]]) {
  const result = Bun.spawnSync(['/usr/bin/codesign', '--force', '--sign', '-', '--timestamp=none', '--preserve-metadata=identifier,entitlements,flags', target], { stdout: 'pipe', stderr: 'pipe' });
  writeFileSync(join(out, name + '-resign.txt'), Buffer.concat([result.stdout, result.stderr]));
  if (result.exitCode !== 0) throw new Error(name + ' ad hoc signing failed with exit ' + result.exitCode);
}
const after = Object.fromEntries(Object.entries(paths).map(([name, path]) => [name, hash(path)]));
if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Native code, JavaScript or Chromium payload changed during signature normalization');
writeFileSync(join(out, 'signature-normalization.json'), JSON.stringify({ reason: 'Ad hoc signatures for embedded frameworks after CocoaPods strips development files', signed: ['Sparkle.framework', 'hermes.framework', 'Ardia.app'], payloadSHA256Before: before, payloadSHA256After: after, compiledPayloadsUnchanged: true, launcherSHA256Before: executableBefore, launcherSHA256After: hash(join(app, 'Contents/MacOS/Ardia')) }, null, 2) + '\n');
