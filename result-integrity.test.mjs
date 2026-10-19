import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commandEvidence, normalizeExecution, toolsFor } from './guard.mjs';
import { buildHandoff } from './server.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));

async function makeWorkspace(t) {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-result-integrity-'));
  t.after(async () => { await rm(workspace, { recursive: true, force: true }); });
  return workspace;
}

function contractFor(workspace, overrides = {}) {
  return normalizeExecution({
    workspace,
    write_paths: [join(workspace, 'out.txt')],
    commands: ['node check.mjs'],
    max_steps: 8,
    timeout_seconds: 120,
    ...overrides,
  });
}

function boundaryStderr(contract, count = 3) {
  const allowed = toolsFor(contract);
  return Array.from({ length: count }, (_, index) => 'DSH_MCP_BOUNDARY ' + JSON.stringify({
    agents: 1, requests: index + 1, tools: allowed.length, allowed_tools: allowed, provider: 'local-test', model: 'local-test',
  })).join('\n');
}

function runOutcome(contract, events, options = {}) {
  return {
    code: 0,
    stdout: options.stdout ?? events.map(event => JSON.stringify(event)).join('\n'),
    stderr: options.stderr ?? boundaryStderr(contract),
    stop: null,
    finished_at: 1_000_000,
    deadline_at: 1_120_000,
    ...options,
  };
}

const session = () => ({ type: 'session', id: 'result-integrity-session' });
const call = (tool, callId, input) => ({ type: 'tool_call', tool, callId, input });
const result = (callId, options = {}) => ({ type: 'tool_result', ...options, callId });
const turnAndFinal = (text = 'Done. All checks pass.') => [
  { type: 'status', phase: 'turn_end', reason: { kind: 'completed' } },
  { type: 'final', text },
];

test('A: an orphan failure result after a passed check cannot be completed', async t => {
  const workspace = await makeWorkspace(t);
  const contract = contractFor(workspace);
  const events = [
    session(),
    call('bash', 'check-1', { command: contract.commands[0] }),
    result('check-1', { tool: 'bash', status: 'completed', result: 'OK', exit_code: 0 }),
    result('orphan', { tool: 'bash', status: 'completed', result: 'later failure', exit_code: 1 }),
    ...turnAndFinal('Done. All checks pass.'),
  ];
  const handoff = buildHandoff(contract, runOutcome(contract, events));
  assert.notEqual(handoff.status, 'completed');
  assert.equal(handoff.status, 'partial');
  assert.equal(handoff.stop_reason, 'unpaired_results');
  assert.equal(handoff.verification.acceptance_ready, false);
  assert.equal(handoff.evidence.orphan_results, 1);
  assert.equal(handoff.verification.unpaired_results, 1);
  assert.match(handoff.blockers.join(' '), /Unpaired tool result/);
  assert.match(handoff.summary, /cannot be paired/);
  assert.match(handoff.error, /unpaired_results/);
});

test('B: a real nonzero exit whose text imitates duplicate rejection stays failed', async t => {
  const workspace = await makeWorkspace(t);
  const contract = contractFor(workspace);
  const duplicateText = 'This command already ran against the current edits. Reuse its evidence.';
  const events = [
    session(),
    call('bash', 'first', { command: contract.commands[0] }),
    result('first', { tool: 'bash', status: 'completed', result: 'OK', exit_code: 0 }),
    call('bash', 'second', { command: contract.commands[0] }),
    result('second', { tool: 'bash', status: 'completed', result: duplicateText, exit_code: 1 }),
    ...turnAndFinal('Done. All checks pass.'),
  ];
  const handoff = buildHandoff(contract, runOutcome(contract, events));
  assert.notEqual(handoff.status, 'completed');
  assert.equal(handoff.stop_reason, 'unresolved_failures');
  assert.equal(handoff.commands[0].status, 'failed');
  assert.equal(handoff.commands[0].exit_code, 1);
  assert.equal(handoff.unresolved_failures[0].call_id, 'second');
  assert.match(handoff.blockers.join(' '), /did not succeed/);
  assert.equal(handoff.verification.acceptance_ready, false);
});

test('C: a result with the same call id but another tool never pairs with the bash call', async t => {
  const workspace = await makeWorkspace(t);
  const contract = contractFor(workspace);
  const events = [
    session(),
    call('bash', 'same-id', { command: contract.commands[0] }),
    result('same-id', { tool: 'read', status: 'completed', result: 'file contents', exit_code: 0 }),
    ...turnAndFinal('Done. All checks pass.'),
  ];
  const handoff = buildHandoff(contract, runOutcome(contract, events));
  assert.notEqual(handoff.status, 'completed');
  assert.equal(handoff.stop_reason, 'unfinished_tool_call');
  assert.equal(handoff.commands[0].status, 'unfinished');
  assert.deepEqual(handoff.missing_authorized_checks.map(entry => entry.reason), ['no_result']);
  assert.equal(handoff.evidence.orphan_results, 1);
  assert.match(handoff.blockers.join(' '), /Unpaired tool result/);
  assert.equal(handoff.verification.acceptance_ready, false);
});

test('results before their calls, duplicate ids and duplicate results are not evidence', async t => {
  const workspace = await makeWorkspace(t);
  const contract = contractFor(workspace);

  const before = buildHandoff(contract, runOutcome(contract, [
    session(),
    result('late', { tool: 'bash', status: 'completed', result: 'OK', exit_code: 0 }),
    call('bash', 'late', { command: contract.commands[0] }),
    ...turnAndFinal(),
  ]));
  assert.notEqual(before.status, 'completed');
  assert.equal(before.stop_reason, 'unfinished_tool_call');
  assert.equal(before.evidence.orphan_results, 1);

  const duplicateId = buildHandoff(contract, runOutcome(contract, [
    session(),
    call('bash', 'dup', { command: contract.commands[0] }),
    call('bash', 'dup', { command: contract.commands[0] }),
    result('dup', { tool: 'bash', status: 'completed', result: 'OK', exit_code: 0 }),
    ...turnAndFinal(),
  ]));
  assert.notEqual(duplicateId.status, 'completed');
  assert.equal(duplicateId.stop_reason, 'unfinished_tool_call');
  assert.equal(duplicateId.commands[0].status, 'unfinished');

  const duplicateResult = buildHandoff(contract, runOutcome(contract, [
    session(),
    call('bash', 'one-result', { command: contract.commands[0] }),
    result('one-result', { tool: 'bash', status: 'completed', result: 'OK', exit_code: 0 }),
    result('one-result', { tool: 'bash', status: 'completed', result: 'contradictory failure', exit_code: 1 }),
    ...turnAndFinal(),
  ]));
  assert.notEqual(duplicateResult.status, 'completed');
  assert.equal(duplicateResult.stop_reason, 'unpaired_results');
  assert.equal(duplicateResult.evidence.orphan_results, 1);
});

test('a missing actual exit code remains unverified, not passed', async t => {
  const workspace = await makeWorkspace(t);
  const contract = contractFor(workspace);
  const events = [
    session(),
    call('bash', 'check-1', { command: contract.commands[0] }),
    result('check-1', { tool: 'bash', status: 'completed', result: 'OK' }),
    ...turnAndFinal('Done. All checks pass.'),
  ];
  const handoff = buildHandoff(contract, runOutcome(contract, events));
  assert.notEqual(handoff.status, 'completed');
  assert.equal(handoff.commands[0].status, 'succeeded_unverified');
  assert.equal(handoff.commands[0].exit_code, 'unknown');
  assert.equal(handoff.stop_reason, 'unverified_commands');
  assert.equal(handoff.verification.acceptance_ready, false);
});

test('canonical pairing with an omitted result tool name and command evidence completes', async t => {
  const workspace = await makeWorkspace(t);
  const contract = contractFor(workspace);
  const path = join(workspace, 'out.txt');
  const events = [
    session(),
    call('write', 'write-1', { file_path: path, content: 'x' }),
    result('write-1', { status: 'completed', result: 'written' }),
    call('bash', 'check-1', { command: contract.commands[0] }),
    result('check-1', { status: 'completed', result: 'OK' }),
    ...turnAndFinal('Done. All checks pass.'),
  ];
  const facts = commandEvidence({ name: 'bash', callId: 'check-1' }, {
    isError: false, value: { kind: 'foreground', exitCode: 0, timedOut: false, aborted: false, signal: null },
  });
  const handoff = buildHandoff(contract, runOutcome(contract, events, {
    stderr: boundaryStderr(contract) + '\nDSH_MCP_COMMAND ' + JSON.stringify(facts),
  }));
  assert.equal(handoff.status, 'completed');
  assert.equal(handoff.stop_reason, 'completed');
  assert.equal(handoff.commands[0].status, 'succeeded');
  assert.equal(handoff.commands[0].exit_code, 0);
  assert.deepEqual(handoff.modified_files.observed.map(entry => entry.path), [path]);
  assert.equal(handoff.evidence.orphan_results, 0);
  assert.equal(handoff.verification.acceptance_ready, true);
});

test('a true unexecuted duplicate rejection reuses the prior pass; a modified rerun recovers an ordinary failure', async t => {
  const workspace = await makeWorkspace(t);
  const contract = contractFor(workspace);
  const duplicateText = 'This command already ran against the current edits. Reuse its evidence.';

  const repeated = buildHandoff(contract, runOutcome(contract, [
    session(),
    call('bash', 'check-1', { command: contract.commands[0] }),
    result('check-1', { tool: 'bash', status: 'completed', result: 'OK', exit_code: 0 }),
    call('bash', 'duplicate', { command: contract.commands[0] }),
    result('duplicate', { tool: 'bash', status: 'error', result: duplicateText }),
    ...turnAndFinal(),
  ]));
  assert.equal(repeated.status, 'completed');
  assert.equal(repeated.commands[0].status, 'succeeded');
  assert.equal(repeated.commands[0].exit_code, 0);
  assert.deepEqual(repeated.unresolved_failures, []);

  const rerun = buildHandoff(contract, runOutcome(contract, [
    session(),
    call('bash', 'failing', { command: contract.commands[0] }),
    result('failing', { tool: 'bash', status: 'error', result: 'SyntaxError', exit_code: 1 }),
    call('write', 'fix', { file_path: join(workspace, 'out.txt'), content: 'fix\n' }),
    result('fix', { tool: 'write', status: 'completed', result: 'written' }),
    call('bash', 'rerun', { command: contract.commands[0] }),
    result('rerun', { tool: 'bash', status: 'completed', result: 'OK', exit_code: 0 }),
    ...turnAndFinal(),
  ]));
  assert.equal(rerun.status, 'completed');
  assert.equal(rerun.commands[0].status, 'succeeded');
  assert.equal(rerun.commands[0].exit_code, 0);
  assert.deepEqual(rerun.unresolved_failures, []);
  assert.ok(rerun.modified_files.observed.some(entry => entry.path === join(workspace, 'out.txt')));
  assert.ok(ROOT.length > 0);
});

test('D: a contradictory structured error is never erased by exit 0', async t => {
  const workspace = await makeWorkspace(t);
  const contract = contractFor(workspace);
  const handoff = buildHandoff(contract, runOutcome(contract, [
    session(),
    call('bash', 'check-1', { command: contract.commands[0] }),
    result('check-1', { tool: 'bash', status: 'error', isError: true, result: 'post execution validation failed', exit_code: 0 }),
    ...turnAndFinal('Done. All checks pass.'),
  ]));
  assert.notEqual(handoff.status, 'completed');
  assert.equal(handoff.verification.acceptance_ready, false);
  assert.equal(handoff.commands[0].status, 'failed');
  assert.equal(handoff.unresolved_failures[0].call_id, 'check-1');
  assert.match(handoff.blockers.join(' '), /did not succeed/);

  // Refusal-like words in ordinary successful output are still just output.
  const ordinary = buildHandoff(contract, runOutcome(contract, [
    session(),
    call('bash', 'check-1', { command: contract.commands[0] }),
    result('check-1', { tool: 'bash', status: 'completed', result: "Command is outside Astra's execution contract, but this is ordinary successful output.", exit_code: 0 }),
    ...turnAndFinal(),
  ]));
  assert.equal(ordinary.status, 'completed');
  assert.equal(ordinary.commands[0].status, 'succeeded');
});

test('E: two complete call/result pairs with the same call id are rejected', async t => {
  const workspace = await makeWorkspace(t);
  const contract = contractFor(workspace);
  const handoff = buildHandoff(contract, runOutcome(contract, [
    session(),
    call('bash', 'a', { command: contract.commands[0] }),
    result('a', { tool: 'bash', status: 'completed', result: 'OK', exit_code: 0 }),
    call('bash', 'a', { command: contract.commands[0] }),
    result('a', { tool: 'bash', status: 'completed', result: 'OK', exit_code: 0 }),
    ...turnAndFinal(),
  ]));
  assert.notEqual(handoff.status, 'completed');
  assert.equal(handoff.stop_reason, 'duplicate_evidence');
  assert.equal(handoff.verification.acceptance_ready, false);
  assert.equal(handoff.verification.duplicate_pairs, 1);
  assert.equal(handoff.evidence.duplicate_pairs.length, 1);
  assert.equal(handoff.evidence.duplicate_pairs[0].call_id, 'a');
  assert.equal(handoff.evidence.orphan_results, 0);
  assert.match(handoff.blockers.join(' '), /Duplicate complete tool call\/result pair/);
  assert.match(handoff.summary, /reuse the same call id/);
});

test('F: canonical command evidence conflicting with a top-level exit code fails', async t => {
  const workspace = await makeWorkspace(t);
  const contract = contractFor(workspace);
  const facts = { call_id: 'check-1', exit_code: 1, timed_out: false, aborted: false, signal: null, stopped: null };
  const handoff = buildHandoff(contract, runOutcome(contract, [
    session(),
    call('bash', 'check-1', { command: contract.commands[0] }),
    result('check-1', { tool: 'bash', status: 'completed', result: 'OK', exit_code: 0 }),
    ...turnAndFinal(),
  ], { stderr: boundaryStderr(contract) + '\nDSH_MCP_COMMAND ' + JSON.stringify(facts) }));
  assert.notEqual(handoff.status, 'completed');
  assert.equal(handoff.verification.acceptance_ready, false);
  assert.equal(handoff.stop_reason, 'unresolved_failures');
  assert.equal(handoff.commands[0].status, 'failed');
  assert.equal(handoff.commands[0].exit_code, 1);
  assert.match(handoff.blockers.join(' '), /did not succeed/);
});

test('G: execution evidence with an unknown exit code is not an unexecuted duplicate', async t => {
  const workspace = await makeWorkspace(t);
  const contract = contractFor(workspace);
  const duplicateText = 'This command already ran against the current edits. Reuse its evidence.';
  const facts = { call_id: 'duplicate', exit_code: null, timed_out: false, aborted: false, signal: null, stopped: null };
  const handoff = buildHandoff(contract, runOutcome(contract, [
    session(),
    call('bash', 'check-1', { command: contract.commands[0] }),
    result('check-1', { tool: 'bash', status: 'completed', result: 'OK', exit_code: 0 }),
    call('bash', 'duplicate', { command: contract.commands[0] }),
    result('duplicate', { tool: 'bash', status: 'error', result: duplicateText }),
    ...turnAndFinal(),
  ], { stderr: boundaryStderr(contract) + '\nDSH_MCP_COMMAND ' + JSON.stringify(facts) }));
  assert.notEqual(handoff.status, 'completed');
  assert.equal(handoff.commands[0].status, 'failed');
  assert.notEqual(handoff.commands[0].status, 'not_executed');
  assert.equal(handoff.unresolved_failures[0].call_id, 'duplicate');
  assert.equal(handoff.verification.acceptance_ready, false);
});
