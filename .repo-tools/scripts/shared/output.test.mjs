import assert from 'node:assert/strict';
import test from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { createOutput } from './output.mjs';

function capture(isTTY, env = {}) {
  const stdout = {
    isTTY,
    text: '',
    write(value) {
      this.text += value;
    },
  };
  const stderr = {
    isTTY,
    text: '',
    write(value) {
      this.text += value;
    },
  };
  return { stdout, stderr, output: createOutput({ stdout, stderr, env }) };
}

for (const [name, isTTY, env] of [
  ['redirected', false, {}],
  ['NO_COLOR', true, { NO_COLOR: '' }],
]) {
  test(`${name} output stays plain and keeps blockers outside step indentation`, () => {
    const { output, stdout, stderr } = capture(isTTY, env);
    output.step('Inspect');
    output.info('Detail');
    output.command('Next:', 'pnpm safety:guard');
    output.debug('hidden');
    for (const level of ['error', 'danger', 'warning'])
      output[level]('Blocked\nNext action');
    assert.equal(
      stdout.text,
      '[STEP] Inspect\n  [INFO] Detail\n  [INFO] Next: pnpm safety:guard\n'
    );
    assert.equal(
      stderr.text,
      '[ERROR] Blocked\nNext action\n[DANGER] Blocked\nNext action\n[WARNING] Blocked\nNext action\n'
    );
  });
}

test('TTY output emphasizes commands and keeps blockers visually primary', () => {
  const { output, stdout, stderr } = capture(true);
  output.step('Inspect');
  output.command('Next:', 'pnpm safety:guard');
  output.danger('Blocked');
  assert.equal(
    stripVTControlCharacters(stdout.text),
    '[STEP] Inspect\n  [INFO] Next: pnpm safety:guard\n'
  );
  assert.equal(stripVTControlCharacters(stderr.text), '[DANGER] Blocked\n');
  const [, commandLine] = stdout.text.trimEnd().split('\n');
  assert.match(
    commandLine,
    /^  \u001b\[[0-9;]+m\[INFO\]\u001b\[[0-9;]+m Next: \u001b\[[0-9;]+mpnpm safety:guard\u001b\[[0-9;]+m$/
  );
  assert.match(
    stderr.text,
    /^\u001b\[[0-9;]+m\[DANGER\]\u001b\[[0-9;]+m Blocked\u001b\[[0-9;]+m\n$/
  );
});

test('verbose debug and prompt formatting remain supported', () => {
  let text = '';
  const stream = {
    isTTY: false,
    write(value) {
      text += value;
    },
  };
  const output = createOutput({
    stdout: stream,
    stderr: stream,
    verbose: true,
    env: {},
  });
  output.debug('diagnostic');
  assert.equal(text, '[DEBUG] diagnostic\n');
  assert.equal(output.format('PROMPT', 'Proceed?'), '[PROMPT] Proceed?');
});
