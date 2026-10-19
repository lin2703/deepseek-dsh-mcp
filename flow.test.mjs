import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, link, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  apply, budgetNotice, closeoutSchedule, commandEvidence, createBoundary, denial, normalizeExecution, toolsFor, visibleToolsForRequest,
} from './guard.mjs';
import { TOOL, buildHandoff, evidenceFor, parseEventStream } from './server.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const ALL_TOOL_SCHEMAS = ['read', 'glob', 'grep', 'write', 'edit', 'bash'].map(name => ({ name }));
const allowedNames = tools => tools.map(tool => tool.name);

async function makeWorkspace(t) {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-flow-test-'));
  t.after(async () => { await rm(workspace, { recursive: true, force: true }); });
  return workspace;
}

function contractFor(workspace, overrides = {}) {
  return normalizeExecution({
    workspace,
    write_paths: [join(workspace, 'a.txt')],
    commands: ['node --check a.mjs', 'node --test flow.test.mjs'],
    max_steps: 4,
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
function sessionEvent(id = 'session-test') {
  return { type: 'session', id };
}
function writePair(path, id = 'write-1') {
  return [
    { type: 'tool_call', tool: 'write', call_id: id, arguments: { file_path: path, content: 'x' } },
    { type: 'tool_result', tool: 'write', call_id: id, status: 'success' },
  ];
}
function commandPair(command, options = {}) {
  const { id = 'bash-1', status = 'success', exit_code } = options;
  const result = { type: 'tool_result', tool: 'bash', call_id: id, status };
  if (exit_code !== undefined) result.exit_code = exit_code;
  if (status === 'error') result.output = options.output ?? 'command failed';
  return [
    { type: 'tool_call', tool: 'bash', call_id: id, arguments: { command } },
    result,
  ];
}
function turnAndFinal(text = 'Done. All checks pass.') {
  return [
    { type: 'status', phase: 'turn_end', reason: { kind: 'completed' } },
    { type: 'final', text },
  ];
}
function runOutcome(contract, events, options = {}) {
  const boundaryCount = options.boundaryCount ?? 2;
  return {
    code: 0,
    stdout: options.stdout ?? jsonl(events),
    stderr: options.stderr ?? boundaryStderr(contract, boundaryCount),
    stop: null,
    finished_at: 1_000_000,
    deadline_at: 1_120_000,
    ...options,
  };
}

test('tool schema documents numeric limits, read-only tools and command isolation', () => {
  assert.match(TOOL.description, /max_steps 1\.\.64/);
  assert.match(TOOL.description, /timeout_seconds 10\.\.900/);
  assert.match(TOOL.description, /120000 ms/);
  assert.match(TOOL.description, /read, glob and grep are read-only/);
  assert.match(TOOL.description, /do not concatenate them with &&, ; or \|/);
  const execution = TOOL.inputSchema.properties.execution.properties;
  assert.equal(execution.max_steps.minimum, 1);
  assert.equal(execution.max_steps.maximum, 64);
  assert.equal(execution.timeout_seconds.minimum, 10);
  assert.equal(execution.timeout_seconds.maximum, 900);
  assert.match(execution.commands.description, /one command per string/);
  assert.match(execution.commands.description, /verbatim/);
  assert.match(execution.commands.description, /120000 ms/);
  assert.match(execution.max_steps.description, /final request is summary-only/);
});

test('normalizeExecution keeps ranges and path protections', async t => {
  const workspace = await makeWorkspace(t);
  await writeFile(join(workspace, 'a.mjs'), 'export {};\n');
  await writeFile(join(workspace, 'a.txt'), 'x\n');
  const contract = contractFor(workspace);
  assert.deepEqual(contract.commands, ['node --check a.mjs', 'node --test flow.test.mjs']);
  assert.deepEqual(toolsFor(contract), ['read', 'glob', 'grep', 'write', 'edit', 'bash']);
  assert.throws(() => contractFor(workspace, { max_steps: 65 }), /max_steps 1\.\.64/);
  assert.throws(() => contractFor(workspace, { max_steps: 0 }), /max_steps 1\.\.64/);
  assert.throws(() => contractFor(workspace, { timeout_seconds: 901 }), /timeout_seconds 10\.\.900/);
  assert.throws(() => contractFor(workspace, { timeout_seconds: 9 }), /timeout_seconds 10\.\.900/);
  assert.throws(() => normalizeExecution({ workspace: '/' }), /specific existing project workspace/);
  assert.throws(() => normalizeExecution({ workspace, write_paths: [join(ROOT, 'outside.txt')] }), /within the workspace/);
  assert.throws(() => normalizeExecution({ workspace, write_paths: [join(workspace, '.git')] }), /protected or sealed/);
  assert.throws(() => normalizeExecution({ workspace, commands: Array.from({ length: 17 }, (_, index) => `echo ${index}`) }), /at most 16|At most 16/i);
});

test('guard denial rejects command composition, oversized timeout and out-of-scope paths', async t => {
  const workspace = await makeWorkspace(t);
  await writeFile(join(workspace, 'a.mjs'), 'export {};\n');
  const contract = contractFor(workspace);
  assert.equal(denial(contract, 'bash', { command: 'node --check a.mjs' }), undefined);
  assert.match(denial(contract, 'bash', { command: 'node --check a.mjs && node --test flow.test.mjs' }), /exact strings|shell composition/);
  assert.match(denial(contract, 'bash', { command: 'node --check a.mjs; node --test flow.test.mjs' }), /exact strings|shell composition/);
  assert.match(denial(contract, 'bash', { command: 'node --check a.mjs', timeoutMs: 120001 }), /120000 ms/);
  assert.equal(denial(contract, 'bash', { command: 'node --check a.mjs', timeoutMs: 120000 }), undefined);
  assert.match(denial(contract, 'bash', { command: 'node --check a.mjs', sandbox_permissions: 'danger-full-access' }), /Escalation and background jobs are disabled/);
  assert.match(denial(contract, 'bash', { command: 'node --check a.mjs', run_in_background: true }), /Escalation and background jobs are disabled/);
  assert.match(denial(contract, 'read', { file_path: join(ROOT, 'server.mjs') }), /Path is outside the assigned read scope/);
  assert.match(denial(contract, 'write', { file_path: join(workspace, 'not-granted.txt') }), /Path is outside the assigned write scope/);
  const readOnly = normalizeExecution({ workspace });
  assert.deepEqual(toolsFor(readOnly), ['read', 'glob', 'grep']);
  assert.match(denial(readOnly, 'write', { file_path: join(workspace, 'a.txt') }), /Capability not granted/);
  const hard = join(workspace, 'hard.txt');
  await writeFile(hard, 'hard\n');
  await link(hard, join(workspace, 'hard-link.txt'));
  const hardContract = normalizeExecution({ workspace, write_paths: [join(workspace, 'hard-link.txt')] });
  assert.match(denial(hardContract, 'write', { file_path: join(workspace, 'hard-link.txt') }), /Hard-linked files/);
  const dangling = join(workspace, 'dangling.txt');
  await symlink('missing.txt', dangling);
  assert.throws(() => contractFor(workspace, { write_paths: [dangling] }), /Dangling symlink/);
});

test('closeout reservation is about 20%, capped at 12, and works for short budgets', () => {
  assert.deepEqual(closeoutSchedule(60), { total: 60, reserve: 12, closeout_from: 49, final_at: 60, implementation_requests: 48 });
  assert.deepEqual(closeoutSchedule(64), { total: 64, reserve: 12, closeout_from: 53, final_at: 64, implementation_requests: 52 });
  assert.deepEqual(closeoutSchedule(1), { total: 1, reserve: 1, closeout_from: 1, final_at: 1, implementation_requests: 0 });
  assert.deepEqual(closeoutSchedule(2), { total: 2, reserve: 1, closeout_from: 2, final_at: 2, implementation_requests: 1 });
  assert.deepEqual(closeoutSchedule(5), { total: 5, reserve: 1, closeout_from: 5, final_at: 5, implementation_requests: 4 });
});

test('dynamic budget notice shows used/remaining requests, closeout phase, actual deadline and final lockout', async t => {
  const workspace = await makeWorkspace(t);
  await writeFile(join(workspace, 'a.mjs'), 'export {};\n');
  const contract = contractFor(workspace, { max_steps: 60, timeout_seconds: 600 });
  const early = budgetNotice(contract, 1, { now: 1000, deadlineMs: 61000 });
  assert.match(early, /used 1\/60/);
  assert.match(early, /remaining 59/);
  assert.match(early, /reserve: 12/);
  assert.match(early, /49 through 60/);
  assert.match(early, /IMPLEMENTATION PHASE/);
  assert.match(early, /60s remaining/);
  assert.doesNotMatch(early, /FINAL REQUEST/);
  const closeout = budgetNotice(contract, 49, { now: 1000, deadlineMs: 61000 });
  assert.match(closeout, /CLOSEOUT PHASE/);
  assert.match(closeout, /request 49\/60/);
  const final = budgetNotice(contract, 60, { now: 1000, deadlineMs: 61000 });
  assert.match(final, /FINAL REQUEST/);
  assert.match(final, /tools are disabled/);
  assert.match(final, /Submit the final summary/);
  const near = budgetNotice(contract, 10, { now: 1000, deadlineMs: 31000 });
  assert.match(near, /DEADLINE CLOSE/);
  const elapsed = budgetNotice(contract, 10, { now: 2000, deadlineMs: 1000 });
  assert.match(elapsed, /hard deadline has been reached/);
  const shortContract = contractFor(workspace, { max_steps: 1 });
  assert.match(budgetNotice(shortContract, 1, { now: 0, deadlineMs: 10000 }), /FINAL REQUEST/);
  const twoRequestContract = contractFor(workspace, { max_steps: 2 });
  assert.match(budgetNotice(twoRequestContract, 1, { now: 0, deadlineMs: 10000 }), /IMPLEMENTATION PHASE/);
  assert.deepEqual(visibleToolsForRequest(twoRequestContract, 0, ALL_TOOL_SCHEMAS).map(tool => tool.name), ['read', 'glob', 'grep', 'write', 'edit', 'bash']);
  assert.deepEqual(visibleToolsForRequest(twoRequestContract, 1, ALL_TOOL_SCHEMAS), []);
  assert.deepEqual(visibleToolsForRequest(contract, 0, ALL_TOOL_SCHEMAS).map(tool => tool.name), ['read', 'glob', 'grep', 'write', 'edit', 'bash']);
  assert.deepEqual(visibleToolsForRequest(contract, 58, ALL_TOOL_SCHEMAS).map(tool => tool.name), ['read', 'glob', 'grep', 'write', 'edit', 'bash']);
  assert.deepEqual(visibleToolsForRequest(contract, 59, ALL_TOOL_SCHEMAS), []);
  assert.deepEqual(visibleToolsForRequest(shortContract, 0, ALL_TOOL_SCHEMAS), []);
});

test('stateful boundary blocks tools on the final request without adding a request', async t => {
  const workspace = await makeWorkspace(t);
  await writeFile(join(workspace, 'a.mjs'), 'export {};\n');
  const contract = contractFor(workspace, { max_steps: 60, timeout_seconds: 600 });
  const boundary = createBoundary(contract, { now: () => 1000, deadlineMs: 61000 });
  assert.match(boundary.notice(), /used 0\/60/);
  assert.equal(boundary.guard({ name: 'bash', arguments: { command: 'node --check a.mjs' } }), undefined);
  assert.match(boundary.guard({ name: 'bash', arguments: { command: 'node --check a.mjs' } }), /already ran/);
  for (let index = 0; index < 59; index++) boundary.beginRequest();
  assert.equal(boundary.requests, 59);
  assert.deepEqual(boundary.filterTools(ALL_TOOL_SCHEMAS), []);
  const gate = boundary.beginRequest();
  assert.deepEqual(gate, { request: 60, remaining: 0, final: true, closeout: true });
  assert.match(boundary.notice(), /FINAL REQUEST/);
  assert.match(boundary.guard({ name: 'read', arguments: { file_path: join(workspace, 'a.mjs') } }), /FINAL REQUEST/);
  assert.throws(() => boundary.beginRequest(), /budget exhausted/);
});

test('apply registers required dynamic context and filters tool schemas before the final request', async t => {
  const workspace = await makeWorkspace(t);
  await writeFile(join(workspace, 'a.mjs'), 'export {};\n');
  const contract = contractFor(workspace, { max_steps: 2, timeout_seconds: 30 });
  const contractPath = join(workspace, 'contract.json');
  await writeFile(contractPath, JSON.stringify(contract));
  const previousContract = process.env.DSH_DELEGATE_CONTRACT;
  const previousDeadline = process.env.DSH_DELEGATE_DEADLINE_MS;
  process.env.DSH_DELEGATE_CONTRACT = contractPath;
  process.env.DSH_DELEGATE_DEADLINE_MS = String(Date.now() + 30000);
  const handlers = {};
  let contextDefinition;
  const fakeContext = {
    systemPrompt: { context(definition) { contextDefinition = definition; } },
    tools: {
      guard(handler) { handlers.guard = handler; },
      wireSchemas() { return { schemas: [] }; },
    },
    on(event, handler) { handlers[event] = handler; },
    provide() {},
  };
  const originalWrite = process.stderr.write;
  process.stderr.write = () => true;
  t.after(() => {
    process.stderr.write = originalWrite;
    if (previousContract === undefined) delete process.env.DSH_DELEGATE_CONTRACT; else process.env.DSH_DELEGATE_CONTRACT = previousContract;
    if (previousDeadline === undefined) delete process.env.DSH_DELEGATE_DEADLINE_MS; else process.env.DSH_DELEGATE_DEADLINE_MS = previousDeadline;
  });
  apply(fakeContext);
  assert.equal(contextDefinition.required, true);
  assert.equal(contextDefinition.name, 'codex-delegate-budget');
  assert.match(contextDefinition.text(), /used 0\/2/);
  const assemble = handlers['system-prompt/assemble'];
  const request = handlers['agent/request'];
  const next = async () => ({ provider: 'local-test', model: 'local-test' });
  const before = await assemble({}, {}, async () => ({ tools: ALL_TOOL_SCHEMAS }));
  assert.deepEqual(allowedNames(before.tools), ['read', 'glob', 'grep', 'write', 'edit', 'bash']);
  await request({ agent: {} }, next);
  assert.match(contextDefinition.text(), /used 1\/2/);
  assert.match(contextDefinition.text(), /IMPLEMENTATION PHASE/);
  assert.doesNotMatch(contextDefinition.text(), /FINAL REQUEST/);
  const beforeFinal = await assemble({}, {}, async () => ({ tools: ALL_TOOL_SCHEMAS }));
  assert.deepEqual(beforeFinal.tools, []);
  await request({ agent: {} }, next);
  assert.match(contextDefinition.text(), /FINAL REQUEST/);
  assert.match(handlers.guard({ name: 'read', arguments: { file_path: join(workspace, 'a.mjs') } }), /FINAL REQUEST/);
  await assert.rejects(() => request({ agent: {} }, next), /budget exhausted/);
});

test('handoff reports a normal completion with observed writes and verified commands', async t => {
  const workspace = await makeWorkspace(t);
  const contract = contractFor(workspace, { max_steps: 10 });
  const path = join(workspace, 'a.txt');
  const events = [
    sessionEvent(),
    ...writePair(path, 'w1'),
    ...commandPair('node --check a.mjs', { id: 'c1', exit_code: 0 }),
    ...commandPair('node --test flow.test.mjs', { id: 'c2', exit_code: 0 }),
    ...turnAndFinal('Implemented a.txt. All checks pass.'),
  ];
  const handoff = buildHandoff(contract, runOutcome(contract, events, { boundaryCount: 3 }));
  assert.equal(handoff.status, 'completed');
  assert.equal(handoff.stop_reason, 'completed');
  assert.match(handoff.summary, /Implemented a\.txt/);
  assert.equal(handoff.final_text, 'Implemented a.txt. All checks pass.');
  assert.deepEqual(handoff.modified_files.observed.map(entry => entry.path), [path]);
  assert.equal(handoff.modified_files.observed[0].operations, 1);
  assert.equal(handoff.modified_files.diff_available, false);
  assert.deepEqual(handoff.modified_files.command_possible.map(entry => entry.command), ['node --check a.mjs', 'node --test flow.test.mjs']);
  assert.deepEqual(handoff.commands.map(entry => [entry.status, entry.exit_code]), [['succeeded', 0], ['succeeded', 0]]);
  assert.deepEqual(handoff.missing_authorized_checks, []);
  assert.deepEqual(handoff.unresolved_failures, []);
  assert.deepEqual(handoff.blockers, []);
  assert.equal(handoff.verification.acceptance_ready, true);
  assert.equal(handoff.evidence.valid_boundary, true);
  assert.equal(handoff.evidence.valid_calls, true);
  assert.equal(handoff.budget.used_requests, 3);
  assert.equal(handoff.budget.phase, 'implementation');
  assert.ok(handoff.next_steps.length > 0);
  assert.equal(handoff.error, null);
});

test('budget exhaustion with an empty final stays partial, retains evidence and is not called a violation', async t => {
  const workspace = await makeWorkspace(t);
  const contract = contractFor(workspace, { max_steps: 3 });
  const path = join(workspace, 'a.txt');
  const events = [
    sessionEvent(),
    ...writePair(path),
    { type: 'status', phase: 'turn_end', reason: { kind: 'error', error: { message: 'Delegation step budget exhausted' } } },
    { type: 'final', text: '' },
  ];
  const handoff = buildHandoff(contract, runOutcome(contract, events, {
    boundaryCount: 3,
    code: 1,
    stderr: boundaryStderr(contract, 3) + '\nError: Delegation step budget exhausted; no automatic retry.',
  }));
  assert.equal(handoff.status, 'partial');
  assert.notEqual(handoff.status, 'blocked');
  assert.equal(handoff.stop_reason, 'budget_exhausted');
  assert.equal(handoff.final_text, null);
  assert.ok(handoff.summary.length > 0);
  assert.deepEqual(handoff.modified_files.observed.map(entry => entry.path), [path]);
  assert.equal(handoff.budget.used_requests, 3);
  assert.equal(handoff.budget.remaining_requests, 0);
  assert.equal(handoff.budget.final_request_seen, true);
  assert.match(handoff.blockers.join(' '), /normal budget stop, not an authorization violation/);
  assert.equal(handoff.verification.acceptance_ready, false);
  assert.equal(handoff.evidence.events.length, 5);
});

test('an empty final without budget exhaustion is partial and never acceptance-ready', async t => {
  const workspace = await makeWorkspace(t);
  const contract = contractFor(workspace, { commands: [] });
  const path = join(workspace, 'a.txt');
  const events = [
    sessionEvent(),
    ...writePair(path),
    { type: 'status', phase: 'turn_end', reason: { kind: 'completed' } },
    { type: 'final', text: '   ' },
  ];
  const handoff = buildHandoff(contract, runOutcome(contract, events, { boundaryCount: 2 }));
  assert.equal(handoff.status, 'partial');
  assert.equal(handoff.stop_reason, 'empty_final');
  assert.equal(handoff.final_text, null);
  assert.ok(handoff.summary.length > 0);
  assert.deepEqual(handoff.modified_files.observed.map(entry => entry.path), [path]);
  assert.equal(handoff.verification.acceptance_ready, false);
  assert.match(handoff.blockers.join(' '), /final model response was empty/);
});

test('deadline and cancellation preserve partial writes and actual deadline facts', async t => {
  const workspace = await makeWorkspace(t);
  const contract = contractFor(workspace);
  const path = join(workspace, 'a.txt');
  const events = [sessionEvent(), ...writePair(path)];
  const timedOut = buildHandoff(contract, runOutcome(contract, events, {
    boundaryCount: 1,
    stop: { kind: 'deadline', message: 'DeepSeek exceeded its deadline; stopped without retry.' },
    code: null,
    deadline_at: 1_000_000,
    finished_at: 1_000_000,
  }));
  assert.equal(timedOut.status, 'partial');
  assert.equal(timedOut.stop_reason, 'deadline_exceeded');
  assert.deepEqual(timedOut.modified_files.observed.map(entry => entry.path), [path]);
  assert.equal(timedOut.deadline.exceeded, true);
  assert.equal(timedOut.deadline.remaining_ms, 0);
  assert.match(timedOut.blockers.join(' '), /hard deadline/);
  assert.ok(timedOut.next_steps.some(step => /do not automatically redelegate/.test(step)));
  const cancelled = buildHandoff(contract, runOutcome(contract, [sessionEvent(), ...writePair(join(workspace, 'b.txt'), 'w2')], {
    boundaryCount: 1,
    stop: { kind: 'cancelled', message: 'DeepSeek delegation was cancelled; stopped without retry.' },
    code: null,
  }));
  assert.equal(cancelled.status, 'partial');
  assert.equal(cancelled.stop_reason, 'cancelled');
  assert.deepEqual(cancelled.modified_files.observed.map(entry => entry.path), [join(workspace, 'b.txt')]);
  assert.match(cancelled.blockers.join(' '), /cancelled/);
});

test('malformed JSONL keeps the valid prefix as evidence', async t => {
  const workspace = await makeWorkspace(t);
  const contract = contractFor(workspace);
  const path = join(workspace, 'a.txt');
  const valid = [sessionEvent(), ...writePair(path)];
  const parsed = parseEventStream(jsonl(valid) + '\n{"type":"final","text":');
  assert.equal(parsed.events.length, 3);
  assert.equal(parsed.invalid_count, 1);
  const handoff = buildHandoff(contract, runOutcome(contract, [], {
    stdout: jsonl(valid) + '\n{"type":"final","text":',
    boundaryCount: 1,
    code: 1,
  }));
  assert.equal(handoff.status, 'partial');
  assert.equal(handoff.stop_reason, 'invalid_jsonl');
  assert.equal(handoff.evidence.events.length, 3);
  assert.equal(handoff.evidence.invalid_jsonl_count, 1);
  assert.equal(handoff.evidence.transcript.length, 2);
  assert.deepEqual(handoff.modified_files.observed.map(entry => entry.path), [path]);
  assert.match(handoff.blockers.join(' '), /malformed/);
  assert.ok(handoff.next_steps.some(step => /valid evidence prefix/.test(step)));
});

test('model completion claims do not override unresolved failures or missing checks', async t => {
  const workspace = await makeWorkspace(t);
  const failingContract = contractFor(workspace, { commands: ['node --check a.mjs'] });
  const failing = [
    sessionEvent(),
    ...commandPair('node --check a.mjs', { status: 'error', exit_code: 1, output: 'SyntaxError: unexpected token' }),
    ...turnAndFinal('All checks pass. Completed.'),
  ];
  const failedHandoff = buildHandoff(failingContract, runOutcome(failingContract, failing, { boundaryCount: 2 }));
  assert.equal(failedHandoff.status, 'partial');
  assert.equal(failedHandoff.stop_reason, 'unresolved_failures');
  assert.equal(failedHandoff.model_claimed_completion, true);
  assert.equal(failedHandoff.verification.acceptance_ready, false);
  assert.equal(failedHandoff.unresolved_failures.length, 1);
  assert.equal(failedHandoff.commands[0].status, 'failed');
  assert.equal(failedHandoff.commands[0].exit_code, 1);
  assert.match(failedHandoff.blockers.join(' '), /claimed completion/);

  const missingContract = contractFor(workspace);
  const missing = [
    sessionEvent(),
    ...commandPair('node --check a.mjs', { id: 'c1', exit_code: 0 }),
    ...turnAndFinal('Done.'),
  ];
  const missingHandoff = buildHandoff(missingContract, runOutcome(missingContract, missing, { boundaryCount: 2 }));
  assert.equal(missingHandoff.status, 'partial');
  assert.equal(missingHandoff.stop_reason, 'missing_checks');
  assert.deepEqual(missingHandoff.missing_authorized_checks.map(entry => entry.command), ['node --test flow.test.mjs']);
  assert.match(missingHandoff.blockers.join(' '), /not executed/);
  assert.equal(missingHandoff.verification.acceptance_ready, false);
  assert.ok(missingHandoff.next_steps.some(step => /missing authorized check/.test(step)));
});

test('a command without an actual exit code is reported as unknown, not passed', async t => {
  const workspace = await makeWorkspace(t);
  const contract = contractFor(workspace, { commands: ['node --check a.mjs'] });
  const events = [
    sessionEvent(),
    ...commandPair('node --check a.mjs', { exit_code: undefined }),
    ...turnAndFinal('Done.'),
  ];
  const handoff = buildHandoff(contract, runOutcome(contract, events, { boundaryCount: 2 }));
  assert.equal(handoff.commands[0].status, 'succeeded_unverified');
  assert.equal(handoff.commands[0].exit_code, 'unknown');
  assert.equal(handoff.status, 'partial');
  assert.equal(handoff.stop_reason, 'unverified_commands');
  assert.match(handoff.blockers.join(' '), /verified zero exit code/);
  assert.equal(handoff.verification.acceptance_ready, false);
});

test('an unfinished tool call is partial and its write is not claimed as observed', async t => {
  const workspace = await makeWorkspace(t);
  const contract = contractFor(workspace, { commands: [] });
  const path = join(workspace, 'a.txt');
  const events = [
    sessionEvent(),
    { type: 'tool_call', tool: 'write', call_id: 'w1', arguments: { file_path: path, content: 'x' } },
    ...turnAndFinal('Done.'),
  ];
  const handoff = buildHandoff(contract, runOutcome(contract, events, { boundaryCount: 2 }));
  assert.equal(handoff.status, 'partial');
  assert.equal(handoff.stop_reason, 'unfinished_tool_call');
  assert.deepEqual(handoff.modified_files.observed, []);
  assert.deepEqual(handoff.modified_files.attempted, [{ path, tool: 'write', call_id: 'w1', result: 'missing' }]);
  assert.equal(handoff.unfinished_tool_calls.length, 1);
  assert.match(handoff.blockers.join(' '), /without a recorded result/);
});

test('workspace lock and unauthorized commands produce blocked/failed handoffs', async t => {
  const workspace = await makeWorkspace(t);
  const contract = contractFor(workspace, { commands: ['node --check a.mjs'] });
  const locked = buildHandoff(contract, { code: null, stdout: '', stderr: '', stop: { kind: 'workspace_locked', message: 'Workspace locked by another delegation.' }, finished_at: 1_000_000 });
  assert.equal(locked.status, 'blocked');
  assert.equal(locked.stop_reason, 'workspace_locked');
  assert.deepEqual(locked.commands.map(entry => entry.status), ['not_run']);
  assert.deepEqual(locked.missing_authorized_checks.map(entry => entry.reason), ['not_executed']);
  assert.match(locked.blockers.join(' '), /locked/);
  const unauthorized = [
    sessionEvent(),
    ...commandPair('rm -rf /', { id: 'evil', exit_code: 0 }),
    ...turnAndFinal('Done.'),
  ];
  const violated = buildHandoff(contract, runOutcome(contract, unauthorized, { boundaryCount: 2 }));
  assert.equal(violated.status, 'failed');
  assert.equal(violated.stop_reason, 'contract_violation');
  assert.equal(violated.evidence.valid_calls, false);
  assert.match(violated.blockers.join(' '), /contract validation failed/);
});

test('launch failure with no evidence is a non-empty failed handoff', async t => {
  const workspace = await makeWorkspace(t);
  const contract = contractFor(workspace);
  const handoff = buildHandoff(contract, { code: null, stdout: '', stderr: '', stop: { kind: 'launch_failed', message: 'Could not launch the configured DeepSeek Harness.' }, finished_at: 1_000_000 });
  assert.equal(handoff.status, 'failed');
  assert.equal(handoff.stop_reason, 'launch_failed');
  assert.ok(handoff.summary.length > 0);
  assert.deepEqual(handoff.modified_files.observed, []);
  assert.equal(handoff.verification.acceptance_ready, false);
});

test('actual headless input/callId format and canonical bash facts produce a verified handoff', async t => {
  const workspace = await makeWorkspace(t);
  const contract = contractFor(workspace, { commands: ['node --check a.mjs'] });
  const path = join(workspace, 'a.txt');
  const marker = 'unique tool content used to detect transcript duplication';
  const events = [
    { type: 'tool_call', tool: 'write', callId: 'write-1', input: { file_path: path, content: marker } },
    { type: 'tool_result', callId: 'write-1', status: 'completed', result: 'File written' },
    { type: 'tool_call', tool: 'bash', callId: 'command-1', input: { command: contract.commands[0] } },
    { type: 'tool_result', callId: 'command-1', status: 'completed', result: '(no output)' },
    ...turnAndFinal('Done.'),
  ];
  const facts = commandEvidence({ name: 'bash', callId: 'command-1' }, {
    isError: false, value: { kind: 'foreground', exitCode: 0, timedOut: false, aborted: false, signal: null },
  });
  assert.equal(facts.exit_code, 0);
  const outcome = runOutcome(contract, events, { stderr: boundaryStderr(contract, 2) + '\nDSH_MCP_COMMAND ' + JSON.stringify(facts) });
  const handoff = buildHandoff(contract, outcome);
  assert.equal(handoff.status, 'completed');
  assert.deepEqual(handoff.modified_files.observed.map(entry => entry.path), [path]);
  assert.equal(handoff.commands[0].exit_code, 0);
  assert.equal(handoff.evidence.valid_calls, true);
  const payload = evidenceFor(handoff, outcome);
  // The bounded stdout excerpt can repeat a small prefix; full transcripts must not.
  assert.equal(payload.handoff.evidence.transcript, undefined);
  assert.equal(payload.handoff.evidence.events, undefined);
  assert.equal(payload.transcript.filter(event => event.input?.content === marker).length, 1);
});

test('bash completed status with a nonzero exit or timeout cannot pass acceptance', async t => {
  const workspace = await makeWorkspace(t);
  const contract = contractFor(workspace, { commands: ['node --check a.mjs'] });
  for (const value of [
    { kind: 'foreground', exitCode: 1 },
    { kind: 'foreground', exitCode: 0, timedOut: true },
    { kind: 'foreground', exitCode: null, signal: 'SIGTERM' },
  ]) {
    const events = [
      { type: 'tool_call', tool: 'bash', callId: 'c1', input: { command: contract.commands[0] } },
      { type: 'tool_result', callId: 'c1', status: 'completed', result: 'Output' },
      ...turnAndFinal('All tests passed.'),
    ];
    const fact = commandEvidence({ name: 'bash', callId: 'c1' }, { isError: false, value });
    const handoff = buildHandoff(contract, runOutcome(contract, events, { stderr: boundaryStderr(contract, 2) + '\nDSH_MCP_COMMAND ' + JSON.stringify(fact) }));
    assert.equal(handoff.commands[0].status, 'failed');
    assert.equal(handoff.stop_reason, 'unresolved_failures');
    assert.equal(handoff.verification.acceptance_ready, false);
  }
  assert.equal(commandEvidence({ name: 'read', callId: 'c1' }, {}), null);
  assert.equal(commandEvidence({ name: 'bash', callId: 'c1' }, { isError: true }), null);
});

test('unmatched call IDs never borrow another call result', async t => {
  const workspace = await makeWorkspace(t);
  const contract = contractFor(workspace, { commands: [] });
  const events = [
    { type: 'tool_call', tool: 'write', callId: 'unfinished', input: { file_path: join(workspace, 'a.txt'), content: 'x' } },
    { type: 'tool_result', callId: 'different-id', status: 'completed', result: 'OK' },
    ...turnAndFinal(),
  ];
  const handoff = buildHandoff(contract, runOutcome(contract, events));
  assert.equal(handoff.stop_reason, 'unfinished_tool_call');
  assert.equal(handoff.modified_files.observed.length, 0);
  assert.equal(handoff.evidence.orphan_results, 1);
});

test('rejecting an unchanged repeated check preserves its prior result', async t => {
  const workspace = await makeWorkspace(t);
  const contract = contractFor(workspace, { commands: ['node --check a.mjs'] });
  for (const exit_code of [0, 1]) {
    const events = [
      ...commandPair(contract.commands[0], { id: 'first', exit_code }),
      ...commandPair(contract.commands[0], { id: 'duplicate', status: 'error', output: 'Error: This command already ran against the current edits. Reuse its evidence; report a failure instead of repeating it unchanged.' }),
      ...turnAndFinal(),
    ];
    const handoff = buildHandoff(contract, runOutcome(contract, events));
    assert.equal(handoff.commands[0].exit_code, exit_code);
    assert.equal(handoff.commands[0].status, exit_code === 0 ? 'succeeded' : 'failed');
    assert.equal(handoff.verification.acceptance_ready, exit_code === 0);
  }
});

test('deadline summary describes retained evidence instead of stale planning text', async t => {
  const workspace = await makeWorkspace(t);
  const contract = contractFor(workspace, { commands: [] });
  const events = [...writePair(join(workspace, 'a.txt')), { type: 'final', text: 'I will start exploring the workspace.' }];
  const handoff = buildHandoff(contract, runOutcome(contract, events, { stop: { kind: 'deadline', message: 'Deadline reached' } }));
  assert.match(handoff.summary, /hard deadline/);
  assert.match(handoff.summary, /1 file write/);
  assert.doesNotMatch(handoff.summary, /start exploring/);
  assert.match(handoff.final_text, /start exploring/);
});
