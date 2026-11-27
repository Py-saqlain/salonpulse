import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('a real staging build refuses an HTTP API before emitting a bundle', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const vite = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
  const result = spawnSync(process.execPath, [vite, 'build', '--mode', 'staging'], {
    cwd: root, env: { ...process.env, VITE_API_BASE_URL: 'http://api.salon.example' },
    encoding: 'utf8', timeout: 20000,
  });
  assert.notEqual(result.status, 0);
  assert.ok((result.stdout + result.stderr).includes('Production builds require VITE_API_BASE_URL'));
});
