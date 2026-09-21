import { execFileSync, spawn } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const directories: string[] = [];

/** Isolated CLI fixture: child commands record the version they actually receive. */
function fixture(version: string, failAt = '') {
  const root = mkdtempSync(path.join(tmpdir(), 'just-translate-build-'));
  directories.push(root);
  mkdirSync(path.join(root, 'scripts'));
  copyFileSync(
    new URL('../scripts/build.mjs', import.meta.url),
    path.join(root, 'scripts/build.mjs'),
  );
  const original = `${JSON.stringify({ name: 'fixture', version, private: true }, null, 2)}\n`;
  writeFileSync(path.join(root, 'package.json'), original);
  for (const [step, entry] of [
    ['typecheck', 'node_modules/typescript/bin/tsc'],
    ['bundle', 'node_modules/vite/bin/vite.js'],
    ['verify', 'scripts/verify-build.mjs'],
  ]) {
    mkdirSync(path.dirname(path.join(root, entry)), { recursive: true });
    writeFileSync(
      path.join(root, entry),
      `import('node:fs').then(fs => {
        const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
        fs.appendFileSync('steps.txt', ${JSON.stringify(step)} + ':' + version + '\\n');
        if (${JSON.stringify(step)} === ${JSON.stringify(failAt)}) process.exit(7);
        if (${JSON.stringify(step)} === 'bundle') {
          fs.mkdirSync('dist', { recursive: true });
          fs.writeFileSync('dist/manifest.json', JSON.stringify({ version: ${JSON.stringify(failAt)} === 'manifest-version' ? '9.9.9' : version }));
          fs.mkdirSync('dist/assets', { recursive: true });
          fs.writeFileSync('dist/assets/content.js', 'console.log("fixture");');
        }
      });`,
    );
  }
  // Only the isolated child has TTY flags; no real user terminal is needed in tests.
  writeFileSync(
    path.join(root, 'tty.cjs'),
    'process.stdin.isTTY = true; process.stdout.isTTY = true;',
  );
  return { root, original };
}

/** Feed confirmation only after the prompt appears, matching an interactive terminal. */
async function runBuild(
  root: string,
  answer?: string | null,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [...(answer === undefined ? [] : ['--require', './tty.cjs']), './scripts/build.mjs'],
      { cwd: root, stdio: 'pipe' },
    );
    let output = '';
    let answered = false;
    child.on('error', reject);
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
      if (answer !== undefined && !answered && output.includes('[y/N]')) {
        answered = true;
        child.stdin.end(answer === null ? undefined : `${answer}\n`);
      }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    if (answer === undefined) child.stdin.end();
    child.on('close', (code) => resolve({ code, output }));
  });
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('versioned build CLI', () => {
  it.each([
    ['0.3.30', '0.3.31'],
    ['0.3.98', '0.3.99'],
    ['0.3.99', '0.4.0'],
    ['0.98.99', '0.99.0'],
  ])('builds %s as %s using base-100 rollover', async (current, next) => {
    const { root } = fixture(current);
    expect(await runBuild(root)).toMatchObject({ code: 0 });
    expect(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))).toEqual({
      name: 'fixture',
      version: next,
      private: true,
    });
    expect(readFileSync(path.join(root, 'steps.txt'), 'utf8')).toBe(
      `typecheck:${current}\nbundle:${next}\nverify:${next}\n`,
    );
    expect(JSON.parse(readFileSync(path.join(root, 'dist/manifest.json'), 'utf8'))).toEqual({
      version: next,
    });
    const archive = path.join(root, `just-translate-v${next}.zip`);
    execFileSync('unzip', ['-tq', archive]);
    expect(
      JSON.parse(execFileSync('unzip', ['-p', archive, 'manifest.json'], { encoding: 'utf8' })),
    ).toEqual({ version: next });
    const entries = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' })
      .trim()
      .split('\n');
    expect(entries.sort()).toEqual(['assets/', 'assets/content.js', 'manifest.json']);
  });

  it('replaces an existing version archive without retaining stale files', async () => {
    const { root } = fixture('0.3.30');
    const archive = path.join(root, 'just-translate-v0.3.31.zip');
    writeFileSync(path.join(root, 'stale.txt'), 'old artifact');
    execFileSync('zip', ['-q', archive, 'stale.txt'], { cwd: root });
    expect(await runBuild(root)).toMatchObject({ code: 0 });
    const entries = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' });
    expect(entries).toContain('manifest.json');
    expect(entries).not.toContain('stale.txt');
  });

  it('rolls back the version and removes temporary files when publishing the zip fails', async () => {
    const { root, original } = fixture('0.3.30');
    // An occupied directory makes archive publication fail without mocking ZIP creation.
    mkdirSync(path.join(root, 'just-translate-v0.3.31.zip'));
    const entriesBefore = readdirSync(root).sort();
    expect((await runBuild(root)).code).not.toBe(0);
    expect(readFileSync(path.join(root, 'package.json'), 'utf8')).toBe(original);
    expect(
      readdirSync(root)
        .filter((name) => !['dist', 'steps.txt'].includes(name))
        .sort(),
    ).toEqual(entriesBefore);
  });

  it.each(['0.99.99', '0.100.0'])('blocks unattended major upgrades from %s', async (version) => {
    const { root, original } = fixture(version);
    const result = await runBuild(root);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('1.0.0');
    expect(result.output).toContain('交互式终端');
    expect(readFileSync(path.join(root, 'package.json'), 'utf8')).toBe(original);
    expect(() => readFileSync(path.join(root, 'steps.txt'))).toThrow();
  });

  it('upgrades the major version only after explicit terminal confirmation', async () => {
    const { root } = fixture('2.99.99');
    expect(await runBuild(root, 'y')).toMatchObject({ code: 0 });
    expect(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))).toHaveProperty(
      'version',
      '3.0.0',
    );
  });

  it.each(['n', '', 'maybe', null])(
    'cancels without changing files when the answer is %j',
    async (answer) => {
      const { root, original } = fixture('0.99.99');
      expect((await runBuild(root, answer)).code).not.toBe(0);
      expect(readFileSync(path.join(root, 'package.json'), 'utf8')).toBe(original);
      expect(() => readFileSync(path.join(root, 'steps.txt'))).toThrow();
    },
  );

  it.each(['typecheck', 'bundle', 'verify'])(
    'preserves the original version if %s fails',
    async (step) => {
      const { root, original } = fixture('0.3.30', step);
      expect((await runBuild(root)).code).not.toBe(0);
      expect(readFileSync(path.join(root, 'package.json'), 'utf8')).toBe(original);
      const steps = readFileSync(path.join(root, 'steps.txt'), 'utf8');
      expect(steps.trim().split('\n').at(-1)).toMatch(new RegExp(`^${step}:`));
    },
  );

  it('rejects an artifact whose version differs from the requested build version', async () => {
    const { root, original } = fixture('0.3.30', 'manifest-version');
    const result = await runBuild(root);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('manifest');
    expect(readFileSync(path.join(root, 'package.json'), 'utf8')).toBe(original);
  });

  it.each(['0.3.100', '0.03.1', '0.3', '0.3.1-beta', '-1.0.0'])(
    'rejects invalid version %s before building',
    async (version) => {
      const { root, original } = fixture(version);
      expect((await runBuild(root)).code).not.toBe(0);
      expect(readFileSync(path.join(root, 'package.json'), 'utf8')).toBe(original);
      expect(() => readFileSync(path.join(root, 'steps.txt'))).toThrow();
    },
  );
});
