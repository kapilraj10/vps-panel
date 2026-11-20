// checkRepo (apps.js): the panel checks a repository + branch before saving an app. Uses a local repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kapil-gitcheck-'));
process.env.DB_PATH = path.join(tmp, 'panel.db');
process.env.SESSION_SECRET = 'g'.repeat(64);
delete process.env.GIT_CHECK;
const { checkRepo } = await import('../apps.js');
const repo = path.join(tmp, 'repo');
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
fs.mkdirSync(repo);
execFileSync('git', ['init', '-q', '-b', 'main', repo]);
fs.writeFileSync(path.join(repo, 'index.js'), 'console.log(1)\n');
git('add', '.');
git('commit', '-qm', 'init');

test('existing branch passes, missing branch and missing repository are refused with a clear message', async () => {
  assert.deepEqual(await checkRepo(repo, 'main'), { checked: true });
  await assert.rejects(checkRepo(repo, 'nope'), /Branch "nope" was not found/);
  await assert.rejects(checkRepo(path.join(tmp, 'missing'), 'main'), (e) => e.status === 400);
  await assert.rejects(checkRepo('https://127.0.0.1/x.git', 'main', '', { publicOnly: true }), /private or reserved/, 'customers cannot make the panel probe internal hosts');
  await assert.rejects(checkRepo('https://10.10.10.31/x.git', 'main', '', { publicOnly: true }), /private or reserved/);
  process.env.GIT_CHECK = 'off';
  assert.deepEqual(await checkRepo('https://example.invalid/x.git', 'main'), { checked: false });
  fs.rmSync(tmp, { recursive: true, force: true });
});
