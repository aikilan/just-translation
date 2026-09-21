// @ts-check
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execPath, stdin, stdout, stderr } from 'node:process';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packagePath = path.join(projectRoot, 'package.json');

/** Require a human decision for a major upgrade; piped input never counts as approval.
 * @param {string} current
 * @param {string} next
 * @returns {Promise<void>}
 */
async function confirmMajorUpgrade(current, next) {
  const prompt = `版本 ${current} 的次版本号已达到上限或将超过 99，是否升级主版本至 ${next} 并继续构建？`;
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error(`${prompt}\n已阻断构建：请在交互式终端运行 pnpm build 后确认。`);
  }
  const terminal = createInterface({ input: stdin, output: stdout, terminal: false });
  try {
    /** @type {Promise<string>} */
    const confirmation = new Promise((resolve) => {
      terminal.once('close', () => resolve(''));
      terminal.question(`${prompt} [y/N] `, resolve);
    });
    const answer = await confirmation;
    if (!/^(y|yes)$/iu.test(answer.trim())) throw new Error('已取消构建，版本号未改变。');
  } finally {
    terminal.close();
  }
}

/** Increment patch/minor in base 100. Major changes always require explicit confirmation.
 * @param {unknown} version
 * @returns {Promise<string>}
 */
async function nextVersion(version) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version)) {
    throw new Error('版本号必须为 主版本.次版本.小版本 三段非负整数，且不能包含前导零。');
  }
  const [major, minor, patch] = version.split('.').map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger) || patch > 99) {
    throw new Error('版本号超出范围：小版本必须在 0–99 之间，各段必须为安全整数。');
  }
  if (minor > 99 || (minor === 99 && patch === 99)) {
    if (!Number.isSafeInteger(major + 1)) throw new Error('主版本号超出安全整数范围。');
    const next = `${major + 1}.0.0`;
    await confirmMajorUpgrade(version, next);
    return next;
  }
  return patch === 99 ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
}

/** Run the installed project tools without shell expansion, stopping at the first failure.
 * @param {string} entry
 * @param {string[]} args
 */
function run(entry, args = []) {
  const result = spawnSync(execPath, [path.join(projectRoot, entry), ...args], {
    cwd: projectRoot,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${entry} 执行失败（${result.signal ?? result.status}）。`);
  }
}

/** Archive dist contents at ZIP root, verify integrity/version, then publish the complete file.
 * A fresh temporary archive prevents stale entries from an earlier build of the same version.
 * @param {string} version
 * @returns {string} Absolute path of the verified ZIP.
 */
function packageBuild(version) {
  const name = `just-translate-v${version}.zip`;
  const destination = path.join(projectRoot, name);
  const temporaryDirectory = mkdtempSync(path.join(projectRoot, '.build-zip-'));
  const temporaryArchive = path.join(temporaryDirectory, name);
  try {
    execFileSync('zip', ['-q', '-r', temporaryArchive, '.'], {
      cwd: path.join(projectRoot, 'dist'),
    });
    execFileSync('unzip', ['-tq', temporaryArchive]);
    const manifest = /** @type {{ version?: unknown }} */ (
      JSON.parse(
        execFileSync('unzip', ['-p', temporaryArchive, 'manifest.json'], { encoding: 'utf8' }),
      )
    );
    if (manifest.version !== version) throw new Error('ZIP 内 manifest 版本与构建版本不一致。');
    renameSync(temporaryArchive, destination);
    return destination;
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

/** Version is visible to Vite before bundling; failed builds restore only our own file write. */
async function build() {
  const original = readFileSync(packagePath, 'utf8');
  const packageJson = /** @type {{ version: unknown }} */ (JSON.parse(original));
  const next = await nextVersion(packageJson.version);
  run('node_modules/typescript/bin/tsc', ['--noEmit']);
  const updated = `${JSON.stringify({ ...packageJson, version: next }, null, 2)}\n`;
  writeFileSync(packagePath, updated);
  try {
    stdout.write(`构建版本：${packageJson.version} → ${next}\n`);
    run('node_modules/vite/bin/vite.js', ['build']);
    run('scripts/verify-build.mjs');
    const manifest = /** @type {{ version?: unknown }} */ (
      JSON.parse(readFileSync(path.join(projectRoot, 'dist/manifest.json'), 'utf8'))
    );
    if (manifest.version !== next) {
      throw new Error(`manifest 版本不一致：预期 ${next}，实际 ${manifest.version}。`);
    }
    const archive = packageBuild(next);
    stdout.write(`构建成功：v${next}\nZIP：${archive}\n`);
  } catch (error) {
    if (readFileSync(packagePath, 'utf8') === updated) {
      writeFileSync(packagePath, original);
      stderr.write(`已恢复版本号：${packageJson.version}\n`);
    }
    throw error;
  }
}

try {
  await build();
} catch (error) {
  stderr.write(`构建失败：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
