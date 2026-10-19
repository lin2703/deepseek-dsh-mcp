import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { canonical, denial, normalizeExecution, toolsFor } from './guard.mjs';
import { TOOL, buildHandoff, evidenceFor } from './server.mjs';

async function makeWorkspace(t) {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-recovery-test-'));
  t.after(async () => { await rm(workspace, { recursive: true, force: true }); });
  await writeFile(join(workspace, 'a.mjs'), 'export {};\n');
  await writeFile(join(workspace, 'granted.txt'), 'granted evidence\n');
  return workspace;
}

function contractFor(workspace, overrides = {}) {
  return normalizeExecution({
    workspace,
    write_paths: [join(workspace, 'out.txt')],
    read_roots: [join(workspace, 'granted.txt')],
    commands: ['node --check a.mjs'],
    max_steps: 8,
    timeout_seconds: 120,
    ...overrides,
  });
}

function boundaryLine(contract, requests) {
  const allowed = toolsFor(contract);
  return 'DSH_MCP_BOUNDARY ' + JSON.stringify({ agents: 1, requests, tools: allowed.length, allowed_tools: allowed, provider: 'local-test', model: 'local-test' });
}
function boundaryStderr(contract, count) {
  return Array.from({ length: count }, (_, index) => boundaryLine(contract, index + 1)).join('\n');
}
function jsonl(events) {
  return events.map(event => JSON.stringify(event)).join('\n');
}
function sessionEvent() {
  return { type: 'session', id: 'recovery-session' };
}
function call(tool, call_id, args) {
  return { type: 'tool_call', tool, call_id, arguments: args };
}
function denied(tool, call_id, message) {
  return { type: 'tool_result', tool, call_id, status: 'error', output: message };
}
function okRead(call_id, file_path) {
  return { type: 'tool_result', tool: 'read', call_id, status: 'success', result: `contents of ${file_path}` };
}
function commandPair(command, options = {}) {
  const { id = 'check-1', status = 'success', exit_code } = options;
  const result = { type: 'tool_result', tool: 'bash', call_id: id, status };
  if (exit_code !== undefined) result.exit_code = exit_code;
  if (status === 'error') result.output = options.output ?? 'command failed';
  return [call('bash', id, { command }), result];
}
function turnAndFinal(text = 'Done. All checks pass.') {
  return [
    { type: 'status', phase: 'turn_end', reason: { kind: 'completed' } },
    { type: 'final', text },
  ];
}
function runOutcome(contract, events, options = {}) {
  return {
    code: 0,
    stdout: options.stdout ?? jsonl(events),
    stderr: options.stderr ?? boundaryStderr(contract, options.boundaryCount ?? 3),
    stop: null,
    finished_at: 1_000_000,
    deadline_at: 1_120_000,
    ...options,
  };
}
const OUTSIDE_COMMAND = "Command is outside Astra's execution contract. Commands are matched as exact strings; shell composition (&&, ;, |, substitutions) is not authorized. Report the missing command instead of expanding scope.";
const OUTSIDE_READ = 'Path is outside the assigned read scope (/allowed). Report the missing path instead of retrying.';

test('actual shape: denied multi-path ls with 2>&1 becomes a warning after an authorized read and passed check', async t => {
  const workspace = await makeWorkspace(t);
  const contract = contractFor(workspace);
  const granted = join(workspace, 'granted.txt');
  const command = `ls -la ${workspace} ${join(workspace, 'tests')} ${join(workspace, 'validation')} 2>&1`;
  const events = [
    sessionEvent(),
    call('bash', 'ls-1', { command }),
    denied('bash', 'ls-1', OUTSIDE_COMMAND),
    call('read', 'read-1', { file_path: granted }),
    okRead('read-1', granted),
    ...commandPair(contract.commands[0], { id: 'check-1', exit_code: 0 }),
    ...turnAndFinal(),
  ];
  const outcome = runOutcome(contract, events);
  const handoff = buildHandoff(contract, outcome);
  assert.equal(handoff.status, 'completed');
  assert.equal(handoff.stop_reason, 'completed');
  assert.equal(handoff.error, null);
  assert.equal(handoff.verification.acceptance_ready, true);
  assert.equal(handoff.verification.warnings, 1);
  assert.equal(handoff.warnings.length, 1);
  const [warning] = handoff.warnings;
  assert.equal(warning.tool, 'bash');
  assert.equal(warning.call_id, 'ls-1');
  assert.match(warning.target, /^command:ls -la /);
  assert.match(warning.message, /Command is outside Astra/);
  assert.equal(warning.alternative_call_id, 'read-1');
  assert.deepEqual(warning.alternative_call_ids, ['read-1']);
  assert.ok(warning.targets.includes(canonical(workspace)));
  assert.deepEqual(handoff.unresolved_failures, []);
  assert.deepEqual(handoff.blockers, []);
  assert.equal(handoff.evidence.valid_calls, true);
  assert.equal(handoff.evidence.tool_errors, 1);
  assert.equal(handoff.evidence.transcript.length, 6);
  assert.equal(handoff.evidence.events.length, events.length);
  const payload = evidenceFor(handoff, outcome);
  assert.equal(payload.handoff.warnings.length, 1);
  assert.equal(payload.transcript.length, 6);
  assert.equal(payload.handoff.unresolved_failures.length, 0);
  // The guard itself is unchanged: ls is still outside the exact command contract,
  // and out-of-scope reads still deny.
  assert.match(denial(contract, 'bash', { command }), /outside Astra's execution contract/);
  assert.match(denial(contract, 'read', { file_path: '/etc/passwd' }), /outside the assigned read scope/);
});

test('actual shape: denied glob/grep on a granted file parent recovers only after reading that file', async t => {
  const workspace = await makeWorkspace(t);
  const external = await mkdtemp(join(tmpdir(), 'dsh-recovery-root-'));
  t.after(async () => { await rm(external, { recursive: true, force: true }); });
  const granted = join(external, 'outside.txt');
  await writeFile(granted, 'explicit file root\n');
  const contract = contractFor(workspace, { read_roots: [granted] });
  const parent = canonical(external);
  const events = [
    sessionEvent(),
    call('glob', 'glob-1', { pattern: '*', path: parent }),
    denied('glob', 'glob-1', OUTSIDE_READ),
    call('grep', 'grep-1', { pattern: 'needle', path: parent }),
    denied('grep', 'grep-1', OUTSIDE_READ),
    call('read', 'read-1', { file_path: granted }),
    okRead('read-1', granted),
    ...commandPair(contract.commands[0], { id: 'check-1', exit_code: 0 }),
    ...turnAndFinal(),
  ];
  const handoff = buildHandoff(contract, runOutcome(contract, events));
  assert.equal(handoff.status, 'completed');
  assert.equal(handoff.stop_reason, 'completed');
  assert.equal(handoff.verification.warnings, 2);
  assert.deepEqual(handoff.warnings.map(entry => entry.tool), ['glob', 'grep']);
  for (const warning of handoff.warnings) {
    assert.equal(warning.target, `path:${parent}`);
    assert.deepEqual(warning.targets, [parent]);
    assert.equal(warning.alternative_call_id, 'read-1');
  }
  assert.deepEqual(handoff.unresolved_failures, []);
  assert.equal(handoff.evidence.valid_calls, true);
  assert.equal(handoff.evidence.tool_errors, 2);
  assert.equal(handoff.evidence.transcript.length, 8);
});

test('a successful read outside the granted file cannot stand in for a denied parent enumeration', async t => {
  const workspace = await makeWorkspace(t);
  const external = await mkdtemp(join(tmpdir(), 'dsh-recovery-unrelated-'));
  t.after(async () => { await rm(external, { recursive: true, force: true }); });
  const granted = join(external, 'granted.txt');
  const notGranted = join(external, 'not-granted.txt');
  await writeFile(granted, 'granted\n');
  await writeFile(notGranted, 'not granted\n');
  const contract = contractFor(workspace, { read_roots: [granted] });
  const events = [
    sessionEvent(),
    call('glob', 'glob-1', { pattern: '*', path: canonical(external) }),
    denied('glob', 'glob-1', OUTSIDE_READ),
    call('read', 'read-unrelated', { file_path: notGranted }),
    okRead('read-unrelated', notGranted),
    ...commandPair(contract.commands[0], { id: 'check-1', exit_code: 0 }),
    ...turnAndFinal(),
  ];
  const handoff = buildHandoff(contract, runOutcome(contract, events));
  assert.equal(handoff.status, 'partial');
  assert.deepEqual(handoff.warnings, []);
  assert.deepEqual(handoff.unresolved_failures.map(entry => entry.call_id), ['glob-1']);
  assert.equal(handoff.verification.acceptance_ready, false);
});

test('failed, missing or unknown-exit required checks keep the denial unresolved', async t => {
  const workspace = await makeWorkspace(t);
  const granted = join(workspace, 'granted.txt');
  const contract = contractFor(workspace, { commands: ['node --check a.mjs', 'node --test flow.test.mjs'] });
  const base = [
    sessionEvent(),
    call('bash', 'ls-1', { command: `ls -la ${workspace} 2>&1` }),
    denied('bash', 'ls-1', OUTSIDE_COMMAND),
    call('read', 'read-1', { file_path: granted }),
    okRead('read-1', granted),
  ];
  const scenarios = [
    { name: 'missing', tail: turnAndFinal() },
    { name: 'failed', tail: [...commandPair(contract.commands[0], { id: 'check-1', status: 'error', exit_code: 1 }), ...turnAndFinal()] },
    { name: 'unknown-exit', tail: [...commandPair(contract.commands[0], { id: 'check-1', status: 'success' }), ...turnAndFinal()] },
  ];
  for (const scenario of scenarios) {
    const handoff = buildHandoff(contract, runOutcome(contract, [...base, ...scenario.tail]));
    assert.notEqual(handoff.status, 'completed', scenario.name);
    assert.deepEqual(handoff.warnings, [], scenario.name);
    assert.equal(handoff.verification.warnings, 0, scenario.name);
    assert.equal(handoff.verification.acceptance_ready, false, scenario.name);
    assert.ok(handoff.unresolved_failures.some(entry => entry.call_id === 'ls-1'), scenario.name);
  }
});

test('no alternative evidence, direct out-of-scope access, writes and escalation are never warnings', async t => {
  const workspace = await makeWorkspace(t);
  const granted = join(workspace, 'granted.txt');
  const contract = contractFor(workspace);
  const events = [
    sessionEvent(),
    call('bash', 'ls-no-alt', { command: `ls -la ${workspace}` }),
    denied('bash', 'ls-no-alt', OUTSIDE_COMMAND),
    call('read', 'read-outside', { file_path: '/etc/passwd' }),
    denied('read', 'read-outside', OUTSIDE_READ),
    call('write', 'write-outside', { file_path: join(workspace, 'not-granted.txt'), content: 'x' }),
    denied('write', 'write-outside', 'Path is outside the assigned write scope. Report the missing path instead of retrying.'),
    call('bash', 'escalate-1', { command: `ls -la ${workspace}`, run_in_background: true }),
    denied('bash', 'escalate-1', 'Escalation and background jobs are disabled; report the blocker instead of retrying.'),
    ...commandPair(contract.commands[0], { id: 'check-1', exit_code: 0 }),
    ...turnAndFinal(),
  ];
  const handoff = buildHandoff(contract, runOutcome(contract, events));
  assert.equal(handoff.status, 'partial');
  assert.equal(handoff.stop_reason, 'unresolved_failures');
  assert.deepEqual(handoff.warnings, []);
  assert.equal(handoff.verification.warnings, 0);
  assert.deepEqual(handoff.unresolved_failures.map(entry => entry.call_id), ['ls-no-alt', 'read-outside', 'write-outside', 'escalate-1']);
  assert.equal(handoff.verification.acceptance_ready, false);
  assert.equal(handoff.evidence.tool_errors, 4);
  assert.ok(granted.length > 0);
});

test('complex bash, unsupported flags, non-ls commands, outside targets and executed failures do not recover', async t => {
  const workspace = await makeWorkspace(t);
  const granted = join(workspace, 'granted.txt');
  const contract = contractFor(workspace);
  const events = [
    sessionEvent(),
    call('bash', 'complex', { command: `ls -la ${workspace} && cat ${granted}` }),
    denied('bash', 'complex', OUTSIDE_COMMAND),
    call('bash', 'recursive', { command: `ls -R ${workspace}` }),
    denied('bash', 'recursive', OUTSIDE_COMMAND),
    call('bash', 'not-ls', { command: `cat ${granted}` }),
    denied('bash', 'not-ls', OUTSIDE_COMMAND),
    call('bash', 'outside-target', { command: 'ls -la /etc' }),
    denied('bash', 'outside-target', OUTSIDE_COMMAND),
    call('bash', 'executed-failure', { command: `ls -la ${workspace}` }),
    { type: 'tool_result', tool: 'bash', call_id: 'executed-failure', status: 'error', exit_code: 1, output: OUTSIDE_COMMAND },
    call('read', 'read-1', { file_path: granted }),
    okRead('read-1', granted),
    ...commandPair(contract.commands[0], { id: 'check-1', exit_code: 0 }),
    ...turnAndFinal(),
  ];
  const handoff = buildHandoff(contract, runOutcome(contract, events));
  assert.equal(handoff.status, 'partial');
  assert.equal(handoff.stop_reason, 'unresolved_failures');
  assert.deepEqual(handoff.warnings, []);
  assert.equal(handoff.unresolved_failures.length, 5);
  assert.equal(handoff.evidence.valid_calls, false);
  assert.equal(handoff.verification.acceptance_ready, false);
});

test('deadline, unfinished tool calls and malformed JSONL still prevent completion', async t => {
  const workspace = await makeWorkspace(t);
  const granted = join(workspace, 'granted.txt');
  const contract = contractFor(workspace);
  const events = [
    sessionEvent(),
    call('bash', 'ls-1', { command: `ls -la ${workspace} 2>&1` }),
    denied('bash', 'ls-1', OUTSIDE_COMMAND),
    call('read', 'read-1', { file_path: granted }),
    okRead('read-1', granted),
    ...commandPair(contract.commands[0], { id: 'check-1', exit_code: 0 }),
    ...turnAndFinal(),
  ];
  const timedOut = buildHandoff(contract, runOutcome(contract, events, {
    stop: { kind: 'deadline', message: 'DeepSeek exceeded its deadline; stopped without retry.' },
    code: null,
    deadline_at: 1_000_000,
    finished_at: 1_000_000,
  }));
  assert.equal(timedOut.status, 'partial');
  assert.equal(timedOut.stop_reason, 'deadline_exceeded');
  assert.equal(timedOut.verification.acceptance_ready, false);
  assert.equal(timedOut.warnings.length, 1);

  const unfinished = buildHandoff(contract, runOutcome(contract, [
    ...events.slice(0, -2),
    call('read', 'never-finished', { file_path: granted }),
    ...events.slice(-2),
  ]));
  assert.equal(unfinished.status, 'partial');
  assert.equal(unfinished.stop_reason, 'unfinished_tool_call');
  assert.equal(unfinished.verification.acceptance_ready, false);

  const malformed = buildHandoff(contract, runOutcome(contract, events, {
    stdout: jsonl(events) + '\n{"type":"final","text":',
    code: 1,
  }));
  assert.equal(malformed.status, 'partial');
  assert.equal(malformed.stop_reason, 'invalid_jsonl');
  assert.equal(malformed.verification.acceptance_ready, false);
  assert.ok(malformed.evidence.invalid_jsonl_count > 0);
});

test('TOOL guidance requires authorized alternatives and does not claim parent-directory grants', () => {
  assert.match(TOOL.description, /Use read\/glob\/grep for exploration/);
  assert.match(TOOL.description, /does not grant its parent directory/);
  assert.match(TOOL.description, /every other denial remains a failure/);
  assert.match(TOOL.inputSchema.properties.execution.properties.read_roots.description, /that file only, not its parent directory/);
  assert.match(TOOL.description, /non-blocking warning/);
});
