import assert from 'node:assert/strict';
import test from 'node:test';
import { createGitClient, parseWorktreeList } from './git-client.mjs';

function commandRunner(results) {
  const calls = [];
  return {
    calls,
    async run(command, args) {
      calls.push({ command, args });
      const result = results.shift();
      return {
        ok: false,
        exitCode: 1,
        stdout: '',
        stderr: '',
        command,
        args,
        ...result,
      };
    },
  };
}

test('branch validation distinguishes invalid names from Git command failures', async () => {
  const runner = commandRunner([
    { ok: true, exitCode: 0, stdout: 'repair/exact\n' },
    { exitCode: 1 },
    { exitCode: 128, stderr: 'git unavailable' },
  ]);
  const git = createGitClient(runner, '/repo');

  assert.equal(await git.isValidBranchName('repair/exact'), true);
  assert.equal(await git.isValidBranchName('invalid branch'), false);
  await assert.rejects(
    git.isValidBranchName('repair/error'),
    (error) =>
      error.type === 'COMMAND_FAILED' &&
      error.message.includes('Could not validate branch name')
  );
});

test('local branch lookup permits only a verified missing ref', async () => {
  const runner = commandRunner([
    { ok: true, exitCode: 0 },
    { exitCode: 1 },
    { exitCode: 128, stderr: 'ref lookup failed' },
  ]);
  const git = createGitClient(runner, '/repo');

  assert.equal(await git.localBranchExists('repair/existing'), true);
  assert.equal(await git.localBranchExists('repair/missing'), false);
  await assert.rejects(
    git.localBranchExists('repair/error'),
    (error) =>
      error.type === 'COMMAND_FAILED' &&
      error.message.includes('Could not inspect local branch')
  );
});

test('origin branch lookup fails closed except for ls-remote exit code 2', async () => {
  const runner = commandRunner([
    { ok: true, exitCode: 0, stdout: 'abc\trefs/heads/repair/existing\n' },
    { exitCode: 2 },
    { exitCode: 128, stderr: 'authentication failed' },
  ]);
  const git = createGitClient(runner, '/repo');

  assert.equal(await git.remoteBranchExists('repair/existing'), true);
  assert.equal(await git.remoteBranchExists('repair/missing'), false);
  await assert.rejects(
    git.remoteBranchExists('repair/error'),
    (error) =>
      error.type === 'COMMAND_FAILED' &&
      error.message.includes('Could not inspect origin/repair/error')
  );

  assert.deepEqual(runner.calls[1], {
    command: 'git',
    args: [
      'ls-remote',
      '--exit-code',
      '--heads',
      'origin',
      'refs/heads/repair/missing',
    ],
  });
});

test('worktree list parsing preserves paths and branch ownership', () => {
  assert.deepEqual(
    parseWorktreeList(
      'worktree /repo\0HEAD aaa\0branch refs/heads/main\0\0worktree /repo-wt\0HEAD bbb\0detached\0\0'
    ),
    [
      {
        path: '/repo',
        head: 'aaa',
        branch: 'refs/heads/main',
        detached: false,
      },
      { path: '/repo-wt', head: 'bbb', branch: '', detached: true },
    ]
  );
});

test('worktree list parsing fails closed on incomplete or unknown records', () => {
  for (const raw of [
    'HEAD aaa\0',
    'worktree /repo\0branch refs/heads/main\0',
    'worktree /repo\0HEAD aaa\0future-field value\0',
  ]) {
    assert.throws(
      () => parseWorktreeList(raw),
      (error) => error.type === 'MALFORMED_GIT_OUTPUT'
    );
  }
});

test('local-default primitives use machine-readable inventory, CAS, and ff-only merge', async () => {
  const runner = commandRunner([
    {
      ok: true,
      exitCode: 0,
      stdout: 'worktree /repo\0HEAD aaa\0branch refs/heads/main\0\0',
    },
    { ok: true, exitCode: 0 },
    { ok: true, exitCode: 0 },
  ]);
  const git = createGitClient(runner, '/repo');

  assert.equal((await git.worktrees())[0].branch, 'refs/heads/main');
  await git.updateRef('refs/heads/main', 'bbb', 'aaa');
  await git.fastForward('bbb');

  assert.deepEqual(
    runner.calls.map(({ args }) => args),
    [
      ['worktree', 'list', '--porcelain', '-z'],
      ['update-ref', 'refs/heads/main', 'bbb', 'aaa'],
      ['merge', '--ff-only', 'bbb'],
    ]
  );
});

test('shared Git parsers preserve rename destinations and NUL-delimited paths', async () => {
  const { parsePorcelainZ, parseNameStatus } = await import('./git-client.mjs');
  assert.deepEqual(parsePorcelainZ('R  new name\0old name\0?? line\nbreak\0'), [
    { status: 'R ', path: 'new name', originalPath: 'old name' },
    { status: '??', path: 'line\nbreak' },
  ]);
  assert.deepEqual(parseNameStatus('M\tfile\nR100\told\tnew\n'), [
    { status: 'M', path: 'file' },
    { status: 'R', path: 'new' },
  ]);
  assert.deepEqual(parsePorcelainZ(''), []);
  assert.deepEqual(parseNameStatus(''), []);
});

test('cleanup inventory retains lock/prunable reasons and accepts bare records without HEAD', () => {
  const entries = parseWorktreeList(
    'worktree /bare\0bare\0\0worktree /linked\0HEAD aaa\0branch refs/heads/task/x\0locked ongoing work\0prunable missing link\0\0'
  );
  assert.equal(entries[0].bare, true);
  assert.equal(entries[1].locked, true);
  assert.equal(entries[1].lockedReason, 'ongoing work');
  assert.equal(entries[1].prunable, true);
  assert.equal(entries[1].prunableReason, 'missing link');
  assert.equal(
    parseWorktreeList('worktree /linked\0HEAD aaa\0locked\0')[0].locked,
    true
  );
});

test('cleanup reads disable optional status locks and remote lookup never fetches; removal is single-target non-force', async () => {
  const oid = 'a'.repeat(40);
  const runner = commandRunner([
    { ok: true, stdout: '' },
    { ok: true, stdout: '!! node_modules/\0' },
    { ok: true, stdout: `${oid}\trefs/heads/task/example\n` },
    { ok: true },
  ]);
  const git = createGitClient(runner, '/repo');
  await git.cleanupStatusZ();
  await git.cleanupStatusZ(true);
  assert.equal(await git.remoteBranchHead('task/example'), oid);
  await git.removeWorktree('/worktrees/exact');
  assert.deepEqual(
    runner.calls.map((call) => call.args),
    [
      [
        '--no-optional-locks',
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
      ],
      [
        '--no-optional-locks',
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
        '--ignored=matching',
      ],
      ['ls-remote', '--heads', 'origin', 'refs/heads/task/example'],
      ['worktree', 'remove', '--', '/worktrees/exact'],
    ]
  );
});

test('publication Git primitives fetch the exact origin branch and push one captured head', async () => {
  const head = 'a'.repeat(40);
  const runner = commandRunner([
    { ok: true, exitCode: 0 },
    { ok: true, exitCode: 0 },
    { ok: true, exitCode: 0 },
  ]);
  const git = createGitClient(runner, '/repo');

  await git.fetchBranch('feature/test');
  await git.pushExact('feature/test', head);
  await git.setUpstream('feature/test');

  assert.deepEqual(
    runner.calls.map(({ args }) => args),
    [
      [
        'fetch',
        'origin',
        '+refs/heads/feature/test:refs/remotes/origin/feature/test',
      ],
      ['push', 'origin', `${head}:refs/heads/feature/test`],
      ['branch', '--set-upstream-to', 'origin/feature/test', 'feature/test'],
    ]
  );
});

test('upstream inspection distinguishes absent, configured, incomplete, and unreadable config', async () => {
  const runner = commandRunner([
    { exitCode: 1 },
    { exitCode: 1 },
    { ok: true, exitCode: 0, stdout: 'fork\n' },
    { ok: true, exitCode: 0, stdout: 'refs/heads/feature/test\n' },
    { ok: true, exitCode: 0, stdout: 'fork\n' },
    { exitCode: 1 },
    { exitCode: 128, stderr: 'config unreadable' },
    { exitCode: 1 },
  ]);
  const git = createGitClient(runner, '/repo');

  assert.equal(await git.upstream('feature/absent'), '');
  assert.equal(
    await git.upstream('feature/configured'),
    'fork:refs/heads/feature/test'
  );
  await assert.rejects(
    git.upstream('feature/incomplete'),
    (error) => error.type === 'UPSTREAM_CONFIGURATION_INCOMPLETE'
  );
  await assert.rejects(
    git.upstream('feature/unreadable'),
    (error) =>
      error.type === 'COMMAND_FAILED' &&
      error.message.includes('configured upstream remote')
  );
});

test('remote refs containing a commit are listed from remote-tracking refs only', async () => {
  const runner = commandRunner([
    {
      ok: true,
      stdout: 'refs/remotes/origin/main\nrefs/remotes/origin/task/x\n',
    },
    { ok: true, stdout: '' },
  ]);
  const git = createGitClient(runner, '/repo');
  assert.deepEqual(await git.remoteRefsContaining('abc'), [
    'refs/remotes/origin/main',
    'refs/remotes/origin/task/x',
  ]);
  assert.deepEqual(await git.remoteRefsContaining('def'), []);
  assert.deepEqual(runner.calls[0].args, [
    'for-each-ref',
    '--contains',
    'abc',
    '--format=%(refname)',
    'refs/remotes',
  ]);
});
