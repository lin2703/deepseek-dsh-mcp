import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BASH_DESCRIPTION, apply, createBoundary, denial, normalizeExecution, toolsFor, visibleToolsForRequest,
} from './guard.mjs';
import { TOOL, buildHandoff } from './server.mjs';

const AUTHORIZED = ['node --check check.mjs'];
const UNAUTHORIZED_PROBE = 'python -c "import sys; print(sys.version)"';

// The installed DSH ToolSchema shape is exactly { name, description, parameters }.
// These fixtures deliberately contain the old generic examples and the
// background/escalation knobs that must never reach the model.
const BASH_SCHEMA = {
  name: 'bash',
  description: 'Run a shell command. Example: ls -la, npm install, then inspect the output. Use description to explain the command.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to run. Examples: ls -la, npm install, npm test.' },
      workdir: { type: 'string', description: 'Working directory; defaults to the current directory.' },
      timeoutMs: { type: 'number', description: 'Timeout in milliseconds.' },
      description: { type: 'string', description: 'Clear, concise description of what this command does and why.' },
      run_in_background: { type: 'boolean' },
      sandbox_permissions: { type: 'string' },
    },
    required: ['command', 'description'],
  },
};
const READ_SCHEMA = {
  name: 'read',
  description: 'Read a file.',
  parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
};

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

async function makeContract(t, overrides = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-command-contract-'));
  t.after(async () => { await rm(workspace, { recursive: true, force: true }); });
  return normalizeExecution({
    workspace,
    write_paths: [join(workspace, 'out.txt')],
    commands: AUTHORIZED,
    max_steps: 3,
    timeout_seconds: 30,
    ...overrides,
  });
}

test('model-visible bash schema enumerates exact commands and restricts workdir/timeout without mutating inputs', async t => {
  const contract = await makeContract(t);
  const originalBash = structuredClone(BASH_SCHEMA);
  const originalRead = structuredClone(READ_SCHEMA);
  const tools = [READ_SCHEMA, BASH_SCHEMA];
  const visible = visibleToolsForRequest(contract, 0, tools);

  assert.deepEqual(visible.map(tool => tool.name), ['read', 'bash']);
  // The assembled DSH schema and the tools array are inputs, not scratch space.
  assert.deepEqual(BASH_SCHEMA, originalBash);
  assert.deepEqual(READ_SCHEMA, originalRead);
  assert.equal(visible.find(tool => tool.name === 'read'), READ_SCHEMA, 'non-bash tools must pass through unchanged');

  const bash = visible.find(tool => tool.name === 'bash');
  assert.notEqual(bash, BASH_SCHEMA, 'the bash schema must be a fresh object');
  const parameters = bash.parameters;
  assert.equal(parameters.type, 'object');
  assert.equal(parameters.additionalProperties, false);
  assert.deepEqual(parameters.required, ['command', 'description']);
  assert.deepEqual(parameters.properties.command.enum, AUTHORIZED);
  assert.equal(parameters.properties.command.type, 'string');
  assert.match(parameters.properties.command.description, /verbatim/);
  assert.ok(!parameters.properties.command.enum.includes(UNAUTHORIZED_PROBE));

  // Replace generic guidance while preserving the runtime-required description.
  assert.equal(bash.description, BASH_DESCRIPTION);
  assert.match(bash.description, /authorized/);
  assert.match(bash.description, /not executed/);
  assert.match(bash.description, /dependency/);
  assert.doesNotMatch(bash.description, /npm install|ls -la/);
  assert.equal(parameters.properties.description.type, 'string');
  assert.match(parameters.properties.description.description, /authorized command/);
  assert.doesNotMatch(parameters.properties.description.description, /npm install|ls -la/);
  assert.equal(parameters.properties.run_in_background, undefined);
  assert.equal(parameters.properties.sandbox_permissions, undefined);

  assert.deepEqual(parameters.properties.workdir.enum, [contract.workspace, '.']);
  assert.match(parameters.properties.workdir.description, /workspace/);
  assert.equal(parameters.properties.timeoutMs.type, 'integer');
  assert.equal(parameters.properties.timeoutMs.exclusiveMinimum, 0);
  assert.equal(parameters.properties.timeoutMs.maximum, 120000);
  assert.match(parameters.properties.timeoutMs.description, /0 < timeoutMs <= 120000/);

  // Frozen inputs must not make the rewrite throw or mutate anything.
  const frozenTools = deepFreeze(structuredClone(tools));
  assert.doesNotThrow(() => visibleToolsForRequest(contract, 0, frozenTools));
});

test('the final request hides every tool and no bash schema appears without authorized commands', async t => {
  const contract = await makeContract(t);
  assert.deepEqual(visibleToolsForRequest(contract, 2, [READ_SCHEMA, BASH_SCHEMA]), [], 'request 3 of 3 is summary-only');
  const boundary = createBoundary(contract);
  assert.deepEqual(boundary.filterTools([READ_SCHEMA, BASH_SCHEMA]).map(tool => tool.name), ['read', 'bash']);
  boundary.beginRequest();
  boundary.beginRequest();
  boundary.beginRequest();
  assert.equal(boundary.finalOnly, true);
  assert.deepEqual(boundary.filterTools([READ_SCHEMA, BASH_SCHEMA]), []);

  const readOnly = await makeContract(t, { commands: [] });
  assert.deepEqual(visibleToolsForRequest(readOnly, 0, [READ_SCHEMA, BASH_SCHEMA]).map(tool => tool.name), ['read']);
  assert.match(denial(readOnly, 'bash', { command: UNAUTHORIZED_PROBE }), /Capability not granted/);
});

test('guard still refuses unauthorized commands, composition, escalation/background and bad workdir/timeout', async t => {
  const contract = await makeContract(t);
  assert.equal(denial(contract, 'bash', { command: AUTHORIZED[0] }), undefined);
  assert.equal(denial(contract, 'bash', { command: AUTHORIZED[0], workdir: contract.workspace }), undefined);
  assert.equal(denial(contract, 'bash', { command: AUTHORIZED[0], workdir: '.' }), undefined);
  assert.equal(denial(contract, 'bash', { command: AUTHORIZED[0], timeoutMs: 1 }), undefined);
  assert.equal(denial(contract, 'bash', { command: AUTHORIZED[0], timeoutMs: 120000 }), undefined);

  // A denied Python probe is not executed because it is absent from the exact
  // list. Its quoted semicolon must not be diagnosed as shell composition.
  const probeMessage = denial(contract, 'bash', { command: UNAUTHORIZED_PROBE });
  assert.match(probeMessage, /was not executed/);
  assert.match(probeMessage, /命令未执行/);
  assert.doesNotMatch(probeMessage, /shell composition|;/);

  const composed = `${AUTHORIZED[0]} && python -c "print(1)"`;
  assert.match(denial(contract, 'bash', { command: composed }), /was not executed/);
  assert.match(denial(contract, 'bash', { command: `${AUTHORIZED[0]}; node --test flow.test.mjs` }), /was not executed/);

  for (const extra of [
    { sandbox_permissions: 'danger-full-access' },
    { run_in_background: true },
    { background: true },
    { escalate: true },
  ]) {
    assert.match(denial(contract, 'bash', { command: AUTHORIZED[0], ...extra }), /Escalation and background jobs are disabled/);
  }

  assert.match(denial(contract, 'bash', { command: AUTHORIZED[0], workdir: '/etc' }), /assigned workspace/);
  assert.match(denial(contract, 'read', { file_path: '/etc/passwd' }), /outside the assigned read scope/);
  assert.match(denial(contract, 'write', { file_path: join(contract.workspace, 'not-granted.txt') }), /outside the assigned write scope/);
  for (const timeoutMs of [0, -1, 120001, 1.5, NaN, Infinity, '120000']) {
    const message = denial(contract, 'bash', { command: AUTHORIZED[0], timeoutMs });
    assert.match(message, /greater than 0/, `timeoutMs=${String(timeoutMs)}`);
    assert.match(message, /120000 ms/, `timeoutMs=${String(timeoutMs)}`);
  }

  // denial is read-only: frozen arguments keep their exact shape.
  const args = Object.freeze({ command: AUTHORIZED[0], workdir: '.', timeoutMs: 120000 });
  assert.equal(denial(contract, 'bash', args), undefined);
  assert.deepEqual(args, { command: AUTHORIZED[0], workdir: '.', timeoutMs: 120000 });
});

test('system-prompt/assemble rewrites the real ToolSchema and withholds all tools on the final request', async t => {
  const contract = await makeContract(t);
  const contractPath = join(contract.workspace, 'contract.json');
  await writeFile(contractPath, JSON.stringify(contract));
  const previous = process.env.DSH_DELEGATE_CONTRACT;
  process.env.DSH_DELEGATE_CONTRACT = contractPath;
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_DELEGATE_CONTRACT;
    else process.env.DSH_DELEGATE_CONTRACT = previous;
  });

  const handlers = {};
  const fakeContext = {
    systemPrompt: { context() {} },
    tools: { guard(handler) { handlers.guard = handler; }, wireSchemas() { return { schemas: [] }; } },
    on(event, handler) { handlers[event] = handler; },
    provide() {},
  };
  const originalWrite = process.stderr.write;
  process.stderr.write = () => true;
  t.after(() => { process.stderr.write = originalWrite; });
  apply(fakeContext);

  const tools = [READ_SCHEMA, BASH_SCHEMA];
  const assemble = handlers['system-prompt/assemble'];
  const assembled = await assemble({}, {}, async () => ({ tools }));
  const bash = assembled.tools.find(tool => tool.name === 'bash');
  assert.deepEqual(bash.parameters.properties.command.enum, AUTHORIZED);
  assert.deepEqual(bash.parameters.properties.workdir.enum, [contract.workspace, '.']);
  assert.equal(assembled.tools.find(tool => tool.name === 'read'), READ_SCHEMA);
  assert.deepEqual(tools, [READ_SCHEMA, BASH_SCHEMA]);

  const next = async () => ({ provider: 'local-test', model: 'local-test' });
  await handlers['agent/request']({ agent: {} }, next);
  await handlers['agent/request']({ agent: {} }, next);
  const final = await assemble({}, {}, async () => ({ tools }));
  assert.deepEqual(final.tools, []);
});

test('an invalid-timeout denial is not masked by a later corrected run', async t => {
  const contract = await makeContract(t);
  const denialText = denial(contract, 'bash', { command: AUTHORIZED[0], timeoutMs: 0 });
  const events = [
    { type: 'session', id: 'command-contract-session' },
    { type: 'tool_call', tool: 'bash', call_id: 'bad-timeout', arguments: { command: AUTHORIZED[0], timeoutMs: 0 } },
    { type: 'tool_result', tool: 'bash', call_id: 'bad-timeout', status: 'error', output: denialText },
    { type: 'tool_call', tool: 'bash', call_id: 'good', arguments: { command: AUTHORIZED[0] } },
    { type: 'tool_result', tool: 'bash', call_id: 'good', status: 'success', exit_code: 0 },
    { type: 'status', phase: 'turn_end', reason: { kind: 'completed' } },
    { type: 'final', text: 'Done.' },
  ];
  const allowed = toolsFor(contract);
  const stderr = Array.from({ length: 2 }, (_, index) => 'DSH_MCP_BOUNDARY ' + JSON.stringify({
    agents: 1, requests: index + 1, tools: allowed.length, allowed_tools: allowed, provider: 'local-test', model: 'local-test',
  })).join('\n');
  const handoff = buildHandoff(contract, {
    code: 0,
    stdout: events.map(event => JSON.stringify(event)).join('\n'),
    stderr,
    stop: null,
    finished_at: 1_000_000,
    deadline_at: 1_120_000,
  });
  assert.equal(handoff.commands[0].status, 'succeeded');
  assert.equal(handoff.status, 'partial');
  assert.equal(handoff.stop_reason, 'unresolved_failures');
  assert.ok(handoff.unresolved_failures.some(entry => entry.call_id === 'bad-timeout'));
  assert.equal(handoff.verification.acceptance_ready, false);
});

test('public tool guidance points the model at the enumerated bash contract', () => {
  assert.match(TOOL.description, /model-visible bash schema enumerates exactly/);
  assert.match(TOOL.description, /reported as not executed/);
  assert.match(TOOL.description, /dependency or environment probes/);
  assert.match(TOOL.inputSchema.properties.execution.properties.commands.description, /not separate probe commands/);
});
