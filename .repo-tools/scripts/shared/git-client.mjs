import {
  RepositoryToolError,
  commandFailure,
} from './repository-tool-error.mjs';

export function parseWorktreeList(raw) {
  const fields = raw.split('\0');
  const worktrees = [];
  let current = null;

  for (const field of fields) {
    if (!field) continue;
    const separator = field.indexOf(' ');
    const key = separator === -1 ? field : field.slice(0, separator);
    const value = separator === -1 ? '' : field.slice(separator + 1);

    if (key === 'worktree') {
      if (current) worktrees.push(current);
      if (!value) {
        throw new RepositoryToolError(
          'MALFORMED_GIT_OUTPUT',
          'Git worktree output omitted a path.'
        );
      }
      current = { path: value, head: '', branch: '', detached: false };
      continue;
    }
    if (!current) {
      throw new RepositoryToolError(
        'MALFORMED_GIT_OUTPUT',
        'Git worktree output did not begin with a worktree path.'
      );
    }
    if (key === 'HEAD') {
      if (current.head || !value) {
        throw new RepositoryToolError(
          'MALFORMED_GIT_OUTPUT',
          'Git worktree output has an invalid HEAD.'
        );
      }
      current.head = value;
    } else if (key === 'branch') {
      if (current.branch || !value) {
        throw new RepositoryToolError(
          'MALFORMED_GIT_OUTPUT',
          'Git worktree output has an invalid branch.'
        );
      }
      current.branch = value;
    } else if (key === 'detached') {
      current.detached = true;
    } else if (key === 'bare') {
      current.bare = true;
    } else if (key === 'locked' || key === 'prunable') {
      current[key] = true;
      current[`${key}Reason`] = value;
    } else {
      throw new RepositoryToolError(
        'MALFORMED_GIT_OUTPUT',
        `Git worktree output contains an unsupported field: ${key}`
      );
    }
  }
  if (current) worktrees.push(current);
  if (
    !worktrees.length ||
    worktrees.some((worktree) => !worktree.head && !worktree.bare)
  ) {
    throw new RepositoryToolError(
      'MALFORMED_GIT_OUTPUT',
      'Git worktree output did not contain a complete worktree record.'
    );
  }
  return worktrees;
}

export function createGitClient(commandRunner, cwd) {
  const run = (args, options = {}) =>
    commandRunner.run('git', args, { cwd, ...options });
  const required = async (args, context) => {
    const result = await run(args);
    if (!result.ok) throw commandFailure(context, result);
    return result.stdout.trim();
  };
  const requiredRaw = async (args, context) => {
    const result = await run(args);
    if (!result.ok) throw commandFailure(context, result);
    return result.stdout;
  };

  return {
    run,
    required,
    repoRoot: () =>
      required(
        ['rev-parse', '--show-toplevel'],
        'Could not determine repository root'
      ),
    branch: () =>
      required(
        ['rev-parse', '--abbrev-ref', 'HEAD'],
        'Could not determine current branch'
      ),
    head: () => required(['rev-parse', 'HEAD'], 'Could not determine HEAD'),
    ref: (ref) => required(['rev-parse', ref], `Could not determine ${ref}`),
    tree: (ref) =>
      required(
        ['rev-parse', `${ref}^{tree}`],
        `Could not determine tree for ${ref}`
      ),
    async fileModeAt(ref, path) {
      const entry = await required(
        ['ls-tree', ref, '--', path],
        `Could not determine file mode for ${path}`
      );
      return entry.split(/\s+/, 1)[0] || '';
    },
    async attribute(name, path) {
      const result = await required(
        ['check-attr', name, '--', path],
        `Could not inspect ${name} for ${path}`
      );
      return result.slice(result.lastIndexOf(': ') + 2).trim();
    },
    parent: (ref) =>
      required(
        ['rev-parse', `${ref}^`],
        `Could not determine parent for ${ref}`
      ),
    status: () =>
      required(['status', '--porcelain'], 'Could not inspect worktree'),
    statusZ: () =>
      requiredRaw(
        ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
        'Could not inspect worktree'
      ),
    cleanupStatusZ: (ignored = false) =>
      requiredRaw(
        [
          '--no-optional-locks',
          'status',
          '--porcelain=v1',
          '-z',
          '--untracked-files=all',
          ...(ignored ? ['--ignored=matching'] : []),
        ],
        'Could not inspect cleanup local state'
      ),
    gitDir: () =>
      required(
        ['rev-parse', '--absolute-git-dir'],
        'Could not inspect Git directory'
      ),
    commonDir: () =>
      required(
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        'Could not inspect Git common directory'
      ),
    async remoteBranchHead(branch) {
      const ref = `refs/heads/${branch}`;
      const raw = await required(
        ['ls-remote', '--heads', 'origin', ref],
        'Could not inspect remote branch head'
      );
      const rows = raw
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split('\t'));
      if (rows.length === 0) return null;
      if (
        rows.length !== 1 ||
        rows[0][1] !== ref ||
        !/^[a-f0-9]{40,64}$/.test(rows[0][0])
      ) {
        throw new RepositoryToolError(
          'MALFORMED_GIT_OUTPUT',
          'Ambiguous remote branch head'
        );
      }
      return rows[0][0];
    },
    removeWorktree: (path) =>
      required(['worktree', 'remove', '--', path], 'Could not remove worktree'),
    origin: () =>
      required(['remote', 'get-url', 'origin'], "Remote 'origin' is required"),
    fetchDefault: (branch) =>
      required(['fetch', 'origin', branch], `Could not fetch origin/${branch}`),
    fetchBranch: (branch) =>
      required(
        [
          'fetch',
          'origin',
          `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
        ],
        `Could not fetch origin/${branch}`
      ),
    upstream: async (branch) => {
      const remote = await run(['config', '--get', `branch.${branch}.remote`]);
      const merge = await run(['config', '--get', `branch.${branch}.merge`]);
      const remoteMissing = !remote.ok && remote.exitCode === 1;
      const mergeMissing = !merge.ok && merge.exitCode === 1;

      if (remoteMissing && mergeMissing) return '';
      if (!remote.ok && !remoteMissing) {
        throw commandFailure(
          `Could not inspect configured upstream remote for ${branch}`,
          remote
        );
      }
      if (!merge.ok && !mergeMissing) {
        throw commandFailure(
          `Could not inspect configured upstream merge ref for ${branch}`,
          merge
        );
      }
      if (remoteMissing || mergeMissing) {
        throw new RepositoryToolError(
          'UPSTREAM_CONFIGURATION_INCOMPLETE',
          `Configured upstream for ${branch} is incomplete and was left unchanged.`
        );
      }
      return `${remote.stdout.trim()}:${merge.stdout.trim()}`;
    },
    isValidBranchName: async (branch) => {
      if (!branch || branch === 'HEAD' || branch.startsWith('-')) return false;
      const result = await run(['check-ref-format', `refs/heads/${branch}`]);
      if (result.ok) return true;
      if (result.exitCode === 1) return false;
      throw commandFailure(`Could not validate branch name ${branch}`, result);
    },
    localBranchExists: async (branch) => {
      const result = await run([
        'show-ref',
        '--verify',
        '--quiet',
        `refs/heads/${branch}`,
      ]);
      if (result.ok) return true;
      if (result.exitCode === 1) return false;
      throw commandFailure(`Could not inspect local branch ${branch}`, result);
    },
    remoteBranchExists: async (branch) => {
      const result = await run([
        'ls-remote',
        '--exit-code',
        '--heads',
        'origin',
        `refs/heads/${branch}`,
      ]);
      if (result.ok) return true;
      if (result.exitCode === 2) return false;
      throw commandFailure(`Could not inspect origin/${branch}`, result);
    },
    verifyRef: async (ref) => (await run(['rev-parse', '--verify', ref])).ok,
    mergeBase: (left, right) =>
      required(
        ['merge-base', left, right],
        `Could not determine merge base for ${left} and ${right}`
      ),
    logRange: (range, format = '--oneline') =>
      required(['log', format, range], 'Could not inspect commits'),
    latestSubject: () =>
      required(
        ['log', '-1', '--format=%s'],
        'Could not read latest commit subject'
      ),
    diff: (args) =>
      required(['--no-pager', 'diff', ...args], 'Could not inspect diff'),
    async diffUntracked(paths) {
      let diff = '';
      for (const path of paths) {
        const result = await run([
          '--no-pager',
          'diff',
          '--no-index',
          '--',
          '/dev/null',
          path,
        ]);
        if (!result.ok && result.exitCode !== 1) {
          throw commandFailure(
            `Could not inspect untracked file ${path}`,
            result
          );
        }
        diff += result.stdout;
      }
      return diff;
    },
    async checkWhitespace(args) {
      const result = await run(['--no-pager', 'diff', '--check', ...args]);
      if (!result.ok)
        throw commandFailure('Git whitespace validation failed', result);
    },
    untracked: () =>
      required(
        ['ls-files', '--others', '--exclude-standard'],
        'Could not inspect untracked files'
      ),
    hashFiles: (paths) =>
      required(
        ['hash-object', '--no-filters', '--', ...paths],
        'Could not fingerprint untracked files'
      ),
    isAncestor: async (ancestor, descendant) => {
      const result = await run([
        'merge-base',
        '--is-ancestor',
        ancestor,
        descendant,
      ]);
      if (result.ok) return true;
      if (result.exitCode === 1) return false;
      throw commandFailure(
        `Could not compare ancestry of ${ancestor} and ${descendant}`,
        result
      );
    },
    remoteRefsContaining: async (commit) =>
      (
        await required(
          [
            'for-each-ref',
            '--contains',
            commit,
            '--format=%(refname)',
            'refs/remotes',
          ],
          `Could not find remote refs containing ${commit}`
        )
      )
        .split('\n')
        .filter(Boolean),
    revListCount: async (range) =>
      Number(
        await required(
          ['rev-list', '--count', range],
          `Could not count ${range}`
        )
      ),
    addPaths: (paths) =>
      required(
        ['add', '-A', '--', ...paths],
        'Could not stage confirmed changes'
      ),
    writeTree: () =>
      required(['write-tree'], 'Could not fingerprint staged changes'),
    commit: (message) =>
      required(['commit', '-m', message], 'Could not create commit'),
    switchCreate: (branch) =>
      required(['switch', '-c', branch], `Could not create branch ${branch}`),
    push: (branch) =>
      required(['push', '-u', 'origin', branch], `Could not push ${branch}`),
    pushExact: (branch, head) =>
      required(
        ['push', 'origin', `${head}:refs/heads/${branch}`],
        `Could not push exact head to ${branch}`
      ),
    setUpstream: (branch) =>
      required(
        ['branch', '--set-upstream-to', `origin/${branch}`, branch],
        `Could not set upstream for ${branch}`
      ),
    fastForward: (ref) =>
      required(['merge', '--ff-only', ref], `Could not fast-forward to ${ref}`),
    worktrees: async () =>
      parseWorktreeList(
        await requiredRaw(
          ['worktree', 'list', '--porcelain', '-z'],
          'Could not inspect Git worktrees'
        )
      ),
    updateRef: (ref, next, expected) =>
      required(
        ['update-ref', ref, next, expected],
        `Could not compare-and-swap ${ref}`
      ),
  };
}

export function parsePorcelainZ(text) {
  const records = text.split('\0');
  const entries = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    const status = record.slice(0, 2);
    const entry = { status, path: record.slice(3) };
    if (/[RC]/.test(status)) {
      index += 1;
      if (records[index]) entry.originalPath = records[index];
    }
    entries.push(entry);
  }
  return entries;
}

export function parseNameStatus(text) {
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, ...parts] = line.split('\t');
      return { status: status[0], path: parts.at(-1) };
    });
}
