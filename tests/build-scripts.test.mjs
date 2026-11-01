import { test } from 'node:test';
import assert from 'node:assert/strict';
import { architectures, buildSteps, executeSteps } from '../scripts/build-platform.mjs';

test('one-click build defaults to Node architecture and supports both targets', () => {
  assert.deepEqual(architectures('', 'arm64'), ['arm64']);
  assert.deepEqual(architectures('all', 'x64'), ['x64', 'arm64']);
  assert.throws(() => architectures('invalid', 'x64'));
  assert.throws(() => architectures('', 'ia32'));
  assert.throws(() => buildSteps('linux', ['x64']));
});
test('platform builds prepare, validate and package exactly the requested architectures', () => {
  for (const platform of ['mac', 'win']) {
    const steps = buildSteps(platform, ['x64', 'arm64']);
    assert.deepEqual(steps[0], ['ci']);
    assert.deepEqual(steps[1], ['run', 'prepare:tools', '--', platform, 'x64']);
    assert.deepEqual(steps[2], ['run', 'prepare:tools', '--', platform, 'arm64']);
    assert.deepEqual(steps[5], ['exec', '--no', '--', 'tsx', 'scripts/check-tools.ts', `${platform}-x64`, `${platform}-arm64`]);
    assert.deepEqual(steps[6], ['exec', '--no', '--', 'electron-builder', `--${platform}`, '--x64', '--arm64']);
    assert.deepEqual(steps.at(-1), ['run', 'checksums']);
  }
});
test('build failure stops the pipeline before packaging or success', async () => {
  const executed = [];
  await assert.rejects(executeSteps(buildSteps('win', ['arm64']), async args => {
    executed.push(args);
    if (args[0] === 'run') throw new Error('fixture failure');
  }), /fixture failure/);
  assert.equal(executed.length, 2);
  assert.ok(!executed.some(args => args.includes('electron-builder')));
});
