import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { RELEASES_PAGE } from './update-check.js';

const run = promisify(execFile);
const publicId = 'com.chiikawa-buddy.desktop';

export function installerFor(release, target) {
  if (target.checkout || target.portable || !/^\d+\.\d+\.\d+$/.test(release.version)) return null;
  const { version, tag, asset } = release;
  if (!asset || asset.url !== RELEASES_PAGE + '/download/' + tag + '/' + asset.name) return null;
  if (target.platform === 'darwin' && tag === 'v' + version && asset.name === 'chiikawa-manager-' + target.arch + '.zip') return 'mac';
  if (target.platform === 'win32' && tag === 'v' + version + '-windows') {
    const names = ['ChiikawaManager-' + version + '-Setup.exe'];
    if (target.arch === 'arm64') names.push('ChiikawaManager-' + version + '-arm64-Setup.exe');
    if (names.includes(asset.name)) return 'windows';
  }
  return null;
}

// GitHub supplies the digest and size in the same official release listing used for the prompt.
export async function downloadVerified(asset, meta, dest, fetchFile = fetch) {
  if (!/^sha256:[a-f0-9]{64}$/.test(meta?.digest) || !Number.isSafeInteger(meta.size) || meta.size <= 0)
    throw Error('배포 파일의 검증 정보를 확인할 수 없어요.');
  const response = await fetchFile(asset.url, { signal: AbortSignal.timeout(15 * 60_000) });
  if (!response.ok || !response.body) throw Error('업데이트 파일을 받지 못했어요.');
  const hash = createHash('sha256');
  let size = 0;
  const verify = new Transform({
    transform(chunk, _, cb) {
      size += chunk.length;
      if (size > meta.size) return cb(Error('배포 파일 크기가 달라요.'));
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  await pipeline(response.body, verify, createWriteStream(dest, { flags: 'wx', mode: 0o600 }));
  if (size !== meta.size || 'sha256:' + hash.digest('hex') !== meta.digest) throw Error('다운로드 파일 검증에 실패했어요.');
}

export async function prepareInstall(kind, release, meta, resources, tempRoot = os.tmpdir()) {
  const tmp = await fs.mkdtemp(path.join(tempRoot, 'chiikawa-download-'));
  let stage;
  const cleanup = async () => {
    await fs.rm(tmp, { recursive: true, force: true });
    if (stage) await fs.rm(stage, { recursive: true, force: true });
  };
  try {
    const download = path.join(tmp, release.asset.name);
    await downloadVerified(release.asset, meta, download);
    if (kind === 'windows') return { command: download, args: [], cleanup, downloadDir: tmp };
    const current = path.resolve(resources, '../..');
    const readPlist = async (bundle, key) => (await run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', path.join(bundle, 'Contents/Info.plist')])).stdout.trim();
    if (await readPlist(current, 'CFBundleIdentifier') !== publicId || path.basename(current).normalize() !== '치이카와 매니저.app')
      throw Error('이 위치의 앱은 공개 배포판 자동 교체 대상이 아니에요.');
    stage = await fs.mkdtemp(path.join(path.dirname(current), '.chiikawa-update-'));
    await run('/usr/bin/ditto', ['-x', '-k', download, stage]);
    const next = path.join(stage, '치이카와 매니저.app');
    if (await readPlist(next, 'CFBundleIdentifier') !== publicId || await readPlist(next, 'CFBundleShortVersionString') !== release.version)
      throw Error('다운로드한 앱의 이름이나 버전이 달라요.');
    await run('/usr/bin/codesign', ['--verify', '--strict', '--deep', next]);
    await fs.rm(tmp, { recursive: true, force: true });
    return { command: path.join(resources, 'bin', 'swap-update'), args: [String(process.pid), current, next], cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
