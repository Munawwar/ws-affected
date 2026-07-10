import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../ws-affected.mjs', import.meta.url));
const workspaceGraph = {
  app: { dependencies: { 'lib-a': '*' } },
  consumer: { dependencies: { app: '*' } },
  'dev-tool': {},
  'lib-a': { dependencies: { 'lib-b': '*' }, devDependencies: { 'dev-tool': '*' } },
  'lib-b': { peerDependencies: { 'lib-c': '*' } },
  'lib-c': { dependencies: { 'lib-a': '*' } },
};

function run(args) {
  const root = mkdtempSync(path.join(tmpdir(), 'ws-affected-'));
  try {
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ private: true, workspaces: ['packages/*'] }),
    );
    Object.entries(workspaceGraph).forEach(([name, config]) => {
      const directory = path.join(root, 'packages', name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        path.join(directory, 'package.json'),
        JSON.stringify({ name, version: '1.0.0', ...config }),
      );
    });
    return execFileSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean)
      .sort();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('lists transitive production dependencies once through a cycle', () => {
  assert.deepEqual(run(['--workspace', 'app', '--list-dependencies', '--dep-types', 'prod']), [
    'app',
    'lib-a',
    'lib-b',
    'lib-c',
  ]);
});

test('includes development dependencies only when all dependency types are selected', () => {
  assert.deepEqual(run(['--workspace', 'app', '--list-dependencies']), [
    'app',
    'dev-tool',
    'lib-a',
    'lib-b',
    'lib-c',
  ]);
});

test('lists transitive production dependents once through a cycle', () => {
  assert.deepEqual(run(['--workspace', 'lib-c', '--list', '--dep-types', 'prod']), [
    'app',
    'consumer',
    'lib-a',
    'lib-b',
    'lib-c',
  ]);
});
