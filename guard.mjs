// dsh capability fence and its command sandbox. No extra agent or runtime service.
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'codex-delegate-boundary';
export const inject = ['tools', 'agents', 'systemPrompt'];
export const LIMITS = Object.freeze({
  max_steps: Object.freeze({ min: 1, max: 64, default: 24 }),
  timeout_seconds: Object.freeze({ min: 10, max: 900, default: 600 }),
  command_timeout_ms: 120000,
  max_commands: 16,
  max_paths: 32,
  max_configured_roots: 32,
});
const PROCESS_STARTED = Date.now();
export const within = (path, root) => path === root || path.startsWith(root + sep);
export function canonical(path) {
  path = resolve(path);
  try {
    lstatSync(path); // Dangling links must fail, not become a lexical grant.
    return realpathSync(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try { if (lstatSync(path).isSymbolicLink()) throw new Error('Dangling symlink'); }
    catch (inner) { if (inner.code !== 'ENOENT') throw inner; }
    const parent = dirname(path);
    if (parent === path) throw error;
    return resolve(canonical(parent), path.slice(parent.length + (parent === '/' ? 0 : 1)));
  }
}

const CREDENTIAL_SEGMENTS = /(?:^|\/)(?:\.git|\.codex|\.agents|\.ssh|\.aws|\.dsh)(?:\/|$)/;

/**
 * Parse an optional JSON array of absolute directory paths. Invalid values,
 * broad roots and credential roots are refused rather than silently ignored.
 * Sealed roots can only add write protection; runtime roots can only add
 * read-only mounts. Neither can grant a write path.
 */
export function parseConfiguredRoots(name, raw, config) {
  if (raw === undefined || raw === null || raw === '') return [];
  const fail = reason => { throw new Error(`${name} ${reason}`); };
  let values;
  try { values = JSON.parse(raw); }
  catch { fail('must be a JSON array of absolute directory paths.'); }
  if (!Array.isArray(values)) fail('must be a JSON array of absolute directory paths.');
  if (values.length > LIMITS.max_configured_roots) fail(`accepts at most ${LIMITS.max_configured_roots} roots.`);
  const roots = [];
  for (const value of values) {
    const shown = typeof value === 'string' ? JSON.stringify(value) : String(value);
    if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) fail(`entry ${shown} must be an absolute path.`);
    let path;
    try { path = canonical(value); }
    catch (error) { fail(`entry ${shown} cannot be resolved: ${error.message}`); }
    if (config.broad.includes(path)) fail(`entry ${shown} is a broad root (${JSON.stringify(path)}); choose a specific path.`);
    if (CREDENTIAL_SEGMENTS.test(path) || config.private.some(root => within(path, root) || within(root, path))) {
      fail(`entry ${shown} overlaps a protected credential directory; credentials are not mounted or sealed.`);
    }
    let stat;
    try { stat = statSync(path); }
    catch (error) { fail(`entry ${shown} does not exist: ${error.message}`); }
    if (!stat.isDirectory()) fail(`entry ${shown} is not a directory.`);
    if (!roots.includes(path)) roots.push(path);
  }
  return roots;
}

/** Home-derived protection plus explicit JSON-array environment configuration. */
export function loadGuardConfig(env = process.env) {
  const home = canonical(env.HOME || homedir());
  const privateRoots = [join(home, '.codex'), join(home, '.dsh'), join(home, '.ssh'), join(home, '.aws')];
  const broad = [...new Set(['/', '/home', home, '/tmp', '/usr', '/etc', '/var', '/opt'])];
  const context = { home, private: privateRoots, broad };
  const sealed = parseConfiguredRoots('DSH_MCP_SEALED_ROOTS', env.DSH_MCP_SEALED_ROOTS, context);
  const runtime = parseConfiguredRoots('DSH_MCP_RUNTIME_ROOTS', env.DSH_MCP_RUNTIME_ROOTS, context);
  const system = [...new Set(['/usr', '/bin', '/lib', '/lib64', '/etc', ...runtime])];
  return Object.freeze({ home, private: Object.freeze(privateRoots), sealed: Object.freeze(sealed), broad: Object.freeze(broad), system: Object.freeze(system), runtime: Object.freeze(runtime) });
}
const CONFIG = loadGuardConfig();
const privatePath = (path, config = CONFIG) => config.private.some(root => within(path, root));
const protectedWrite = (path, config = CONFIG) => [...config.private, ...config.sealed].some(root => within(path, root) || within(root, path)) || CREDENTIAL_SEGMENTS.test(path);

export function normalizeExecution(raw, config = CONFIG) {
  if (raw === undefined) return null; // Backwards-compatible text-only call.
  const keys = ['workspace', 'write_paths', 'read_roots', 'commands', 'max_steps', 'timeout_seconds'];
  if (!raw || Array.isArray(raw) || typeof raw !== 'object' || Object.keys(raw).some(k => !keys.includes(k))) throw new Error('Invalid execution object.');
  const absolute = value => {
    if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) throw new Error('Execution paths must be absolute.');
    return canonical(value);
  };
  const workspace = absolute(raw.workspace);
  if (config.broad.includes(workspace) || privatePath(workspace, config) || !statSync(workspace).isDirectory()) throw new Error('Choose a specific existing project workspace.');
  const paths = (value = []) => {
    if (!Array.isArray(value) || value.length > LIMITS.max_paths) throw new Error(`At most ${LIMITS.max_paths} paths are allowed.`);
    return [...new Set(value.map(absolute))];
  };
  const write_paths = paths(raw.write_paths);
  if (write_paths.some(path => !within(path, workspace) || protectedWrite(path, config))) throw new Error('Write scopes must be within the workspace and exclude protected or sealed trees.');
  // Keep the caller's original array index even though the workspace is added
  // implicitly and duplicate roots are removed afterwards. A symlink is
  // diagnosed through its canonical target, not just its lexical name.
  const rawReadRoots = raw.read_roots === undefined ? [] : raw.read_roots;
  if (!Array.isArray(rawReadRoots) || rawReadRoots.length > LIMITS.max_paths) throw new Error(`At most ${LIMITS.max_paths} paths are allowed.`);
  const readEntries = rawReadRoots.map((value, index) => {
    const field = `execution.read_roots[${index}]`;
    const shown = typeof value === 'string' ? JSON.stringify(value) : String(value);
    if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) throw new Error(`Read scope ${field} ${shown} must be an absolute path.`);
    let path;
    try {
      path = canonical(value);
    } catch (error) {
      const reason = /Dangling symlink/.test(String(error?.message)) ? 'is a dangling symlink' : 'cannot be resolved';
      throw new Error(`Read scope ${field} ${shown} ${reason}: ${error?.message ?? error}.`);
    }
    if (config.broad.includes(path)) throw new Error(`Read scope ${field} ${shown} resolves to broad root ${JSON.stringify(path)}; choose a specific existing task path.`);
    if (privatePath(path, config)) throw new Error(`Read scope ${field} ${shown} resolves to protected path ${JSON.stringify(path)}; private directories are not readable.`);
    if (!existsSync(path)) throw new Error(`Read scope ${field} ${shown} does not exist.`);
    return path;
  });
  const read_roots = [...new Set([workspace, ...readEntries])];
  const commands = raw.commands ?? [];
  if (!Array.isArray(commands) || commands.length > LIMITS.max_commands || commands.some(cmd => typeof cmd !== 'string' || !cmd.trim() || cmd.length > 8192 || cmd.includes('\0'))) throw new Error(`Provide at most ${LIMITS.max_commands} exact authorized command strings; each string is one command and shell composition is not authorized.`);
  const max_steps = raw.max_steps ?? LIMITS.max_steps.default;
  const timeout_seconds = raw.timeout_seconds ?? LIMITS.timeout_seconds.default;
  if (!Number.isInteger(max_steps) || max_steps < LIMITS.max_steps.min || max_steps > LIMITS.max_steps.max || !Number.isInteger(timeout_seconds) || timeout_seconds < LIMITS.timeout_seconds.min || timeout_seconds > LIMITS.timeout_seconds.max) {
    throw new Error(`Execution budget is outside the supported range (max_steps ${LIMITS.max_steps.min}..${LIMITS.max_steps.max}, timeout_seconds ${LIMITS.timeout_seconds.min}..${LIMITS.timeout_seconds.max}).`);
  }
  return { workspace, write_paths, read_roots, commands: [...new Set(commands)], max_steps, timeout_seconds };
}
export function toolsFor(contract) {
  return contract ? ['read', 'glob', 'grep', ...(contract.write_paths.length ? ['write', 'edit'] : []), ...(contract.commands.length ? ['bash'] : [])] : [];
}

export const BASH_DESCRIPTION = 'Run exactly one command authorized for this delegation. Select command verbatim from the enum; any other command is refused before execution, and that refusal states the command was not executed. Do not send dependency, version, environment or discovery probes as extra commands: perform any needed inspection inside an already-authorized implementation or check command. workdir must be the assigned workspace or "."; when supplied, timeoutMs must be an integer greater than 0 and at most 120000 ms. Background jobs, escalation, extra parameters and shell composition are not available.';

/**
 * Rewrite only the model-visible bash ToolSchema. The installed DSH shape is
 * { name, description, parameters: <JSON Schema object> }. Return a fresh
 * object so the assembled schema supplied by DSH is never mutated, and leave
 * every non-bash tool untouched.
 */
export function bashToolSchemaFor(contract, tool = {}) {
  const commands = [...(contract?.commands ?? [])];
  return {
    ...tool,
    name: 'bash',
    description: BASH_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['command', 'description'],
      properties: {
        description: {
          type: 'string',
          description: 'A short description of the authorized command selected below.',
        },
        command: {
          type: 'string',
          enum: commands,
          description: 'Exactly one command string authorized for this delegation, selected verbatim from this enum. A command not listed here is refused and is not executed; no replacement or expanded command is authorized.',
        },
        workdir: {
          type: 'string',
          enum: [contract?.workspace, '.'],
          description: 'The assigned workspace path or "." (the workspace is the fixed cwd); any other workdir is refused before execution.',
        },
        timeoutMs: {
          type: 'integer',
          exclusiveMinimum: 0,
          maximum: LIMITS.command_timeout_ms,
          description: 'Optional per-command limit with 0 < timeoutMs <= 120000 ms (120 seconds). Zero, negative, non-integer or larger values are refused before execution.',
        },
      },
    },
  };
}

/** Reserve closeout requests inside the fixed budget; this never adds requests. */
export function closeoutSchedule(maxSteps) {
  const total = Number.isInteger(maxSteps) && maxSteps > 0 ? Math.min(LIMITS.max_steps.max, maxSteps) : LIMITS.max_steps.default;
  // About 20% of the fixed budget, rounded up, capped at 12. The reserve always
  // includes the final summary request; a one-request budget is summary-only.
  const reserve = Math.min(12, Math.max(1, Math.ceil(total * 0.2)));
  return {
    total,
    reserve,
    closeout_from: Math.max(1, total - reserve + 1),
    final_at: total,
    implementation_requests: Math.max(0, total - reserve),
  };
}

export function deadlineFromEnv(env = process.env) {
  const raw = Number(env?.DSH_DELEGATE_DEADLINE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : null;
}

/**
 * Model-visible budget/deadline context. Used requests are those already sent,
 * so before a request the caller passes the completed count; after admission it
 * passes the count including the request that is about to run.
 */
export function budgetNotice(contract, requests, options = {}) {
  const schedule = closeoutSchedule(contract?.max_steps ?? 1);
  const used = Math.max(0, Math.floor(Number(requests) || 0));
  const remaining = Math.max(0, schedule.total - used);
  const now = options.now ?? Date.now();
  const timeoutSeconds = contract?.timeout_seconds ?? LIMITS.timeout_seconds.default;
  const envDeadline = Object.hasOwn(options, 'deadlineMs') ? options.deadlineMs : deadlineFromEnv(options.env);
  const deadline = envDeadline ?? PROCESS_STARTED + timeoutSeconds * 1000;
  const remainingMs = Math.max(0, deadline - now);
  const remainingSeconds = Math.ceil(remainingMs / 1000);
  const nearDeadlineMs = Math.min(120000, Math.max(15000, timeoutSeconds * 1000 * 0.2));
  const final = used >= schedule.final_at;
  const closeout = used >= schedule.closeout_from;
  const lines = [
    `DSH model-request budget: used ${used}/${schedule.total}; remaining ${remaining}.`,
    schedule.reserve === 1
      ? `Closeout reserve: 1 request (request ${schedule.final_at}), reserved for the final summary and handoff.`
      : `Closeout reserve: ${schedule.reserve} request(s), reserved for verification and handoff from request ${schedule.closeout_from} through ${schedule.final_at}. Do not spend that reserve on new implementation scope.`,
  ];
  if (final) lines.push(`FINAL REQUEST (${used}/${schedule.total}): tools are disabled for this request. Do not call tools or start new work. Submit the final summary now: observed changed files, actual commands/results, unresolved failures, blockers and next steps.`);
  else if (closeout) lines.push(`CLOSEOUT PHASE (request ${used}/${schedule.total}): stop new implementation. Verify the delivered changes against acceptance, run only already-authorized checks, and prepare the handoff. Request ${schedule.final_at} is summary-only with tools disabled.`);
  else if (schedule.reserve === 1) lines.push(`IMPLEMENTATION PHASE (request ${used}/${schedule.total}): finish the smallest correct change and verify it before request ${schedule.final_at}, which is summary-only with tools disabled.`);
  else lines.push(`IMPLEMENTATION PHASE (request ${used}/${schedule.total}): finish the smallest correct change; leave requests ${schedule.closeout_from}-${schedule.final_at} for verification and handoff.`);
  lines.push(`Actual hard deadline: about ${remainingSeconds}s remaining (deadline ${new Date(deadline).toISOString()}).`);
  if (remainingMs <= nearDeadlineMs) {
    lines.push(remainingMs === 0
      ? 'DEADLINE CLOSE: the hard deadline has been reached; do not start new work or new commands. Return the final summary immediately so the evidence remains parseable.'
      : `DEADLINE CLOSE: only about ${remainingSeconds}s remain. Stop implementation now, verify minimally with already-authorized checks, and submit the final summary before the hard stop.`);
  }
  return lines.join('\n');
}

/** Tools visible to a numbered request; the final request is summary-only. */
export function visibleToolsForRequest(contract, requests, tools) {
  if (!contract) return [];
  const schedule = closeoutSchedule(contract.max_steps);
  const nextRequest = Math.max(1, Math.floor(Number(requests) || 0) + 1);
  if (nextRequest >= schedule.final_at) return [];
  const allowed = toolsFor(contract);
  return (tools ?? [])
    .filter(tool => allowed.includes(tool?.name))
    .map(tool => tool?.name === 'bash' ? bashToolSchemaFor(contract, tool) : tool);
}

export function denial(contract, tool, args = {}) {
  const available = toolsFor(contract);
  if (!available.includes(tool)) return `Capability not granted (available: ${available.join(', ') || 'none'}). Do not retry through another tool; report the missing authorization.`;
  try {
    if (args.sandbox_permissions || args.sandboxPermissions || args.run_in_background || args.runInBackground || args.background || args.escalate || args.escalation) return 'Escalation and background jobs are disabled; the command was not executed. Report the blocker instead of retrying.';
    if (tool === 'bash') {
      if (!contract.commands.includes(args.command)) return 'Command is outside Astra\'s execution contract and was not executed (命令未执行). Commands are matched as exact strings, one command per call. No alternative command or expanded scope is authorized. Report the missing command instead of retrying.';
      if (canonical(resolve(contract.workspace, args.workdir ?? '.')) !== contract.workspace) return 'Use the assigned workspace as workdir; other directories are not authorized. The command was not executed.';
      if (args.timeoutMs !== undefined && (!Number.isInteger(args.timeoutMs) || args.timeoutMs <= 0 || args.timeoutMs > LIMITS.command_timeout_ms)) return `Per-command timeoutMs must be an integer greater than 0 and at most ${LIMITS.command_timeout_ms} ms (120 seconds); the command was not executed and a larger or zero timeout is not authorized.`;
      return;
    }
    const path = canonical(resolve(contract.workspace, args.file_path ?? args.path ?? '.'));
    const writing = tool === 'write' || tool === 'edit';
    const roots = writing ? contract.write_paths : contract.read_roots;
    if (privatePath(path) || !roots.some(root => within(path, root)) || (writing && protectedWrite(path))) {
      return `Path is outside the assigned ${writing ? 'write' : 'read'} scope${roots.length ? ` (${roots.join(', ')})` : ' (none granted)'}. Report the missing path instead of retrying.`;
    }
    if (writing && existsSync(path) && statSync(path).isFile() && statSync(path).nlink > 1) return 'Hard-linked files are not writable through delegation; use a normal file inside the write scope.';
  } catch { return 'Path resolution failed (missing, dangling symlink or inaccessible); no tool execution permitted.'; }
}

/** Stateful boundary used by the plugin and by provider-free hook tests. */
export function createBoundary(contract, options = {}) {
  const schedule = closeoutSchedule(contract?.max_steps ?? 1);
  const timeoutSeconds = contract?.timeout_seconds ?? LIMITS.timeout_seconds.default;
  const now = options.now ?? (() => Date.now());
  const configuredDeadline = Object.hasOwn(options, 'deadlineMs') ? options.deadlineMs : undefined;
  const deadlineMs = configuredDeadline !== undefined ? configuredDeadline : (deadlineFromEnv(options.env) ?? PROCESS_STARTED + timeoutSeconds * 1000);
  let requests = 0;
  let finalOnly = false;
  let revision = 0;
  const commandsRun = new Set();
  return {
    contract,
    schedule,
    get requests() { return requests; },
    get finalOnly() { return finalOnly; },
    get deadlineMs() { return deadlineMs; },
    notice() { return budgetNotice(contract, requests, { now: now(), deadlineMs }); },
    beginRequest() {
      if (requests + 1 > schedule.final_at) throw new Error('Delegation step budget exhausted; no automatic retry.');
      requests++;
      finalOnly = requests >= schedule.final_at;
      return { request: requests, remaining: schedule.final_at - requests, final: finalOnly, closeout: requests >= schedule.closeout_from };
    },
    filterTools(tools) { return visibleToolsForRequest(contract, requests, tools); },
    guard(exec) {
      if (finalOnly) return 'FINAL REQUEST: tools are disabled; submit the final summary without tool calls.';
      const reason = denial(contract, exec?.name, exec?.arguments ?? {});
      if (reason) return reason;
      if (exec.name === 'bash') {
        const key = JSON.stringify([revision, exec.arguments.command]);
        if (commandsRun.has(key)) return 'This command already ran against the current edits. Reuse its evidence; report a failure instead of repeating it unchanged.';
        commandsRun.add(key);
      } else if (['write', 'edit'].includes(exec.name)) revision++;
    },
  };
}

// The headless JSON stream omits bash's canonical exit code. Preserve only
// execution facts from the public tools/result hook, never infer zero from text.
export function commandEvidence(exec, result) {
  if (exec?.name !== 'bash' || typeof exec.callId !== 'string') return null;
  const value = result?.value;
  if (result?.isError || value?.kind !== 'foreground') return null;
  return {
    call_id: exec.callId,
    exit_code: Number.isInteger(value.exitCode) ? value.exitCode : null,
    timed_out: value.timedOut === true,
    aborted: value.aborted === true,
    signal: typeof value.signal === 'string' ? value.signal : null,
    stopped: typeof value.stopped === 'string' ? value.stopped : null,
  };
}

// The packaged sandbox-local plugin calls this via its public runnerCommand seam.
// Rebuild the mount view; do not inherit its broader workspace-write profile.
export function sandboxArgs(contract, command, config = CONFIG) {
  if (!contract || !contract.commands.includes(command)) throw new Error('Unapproved command.');
  const args = ['--unshare-net', '--unshare-pid', '--new-session', '--die-with-parent', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp'];
  const roots = [...new Set([...config.system.filter(existsSync), ...contract.read_roots])].sort((a, b) => a.length - b.length);
  for (const root of roots) {
    if (canonical(root) !== root && !config.system.includes(root)) throw new Error('Read scope changed to a symlink.');
    args.push('--ro-bind', root, root);
  }
  for (const path of contract.write_paths) {
    if (canonical(path) !== path || protectedWrite(path, config)) throw new Error('Write scope changed.');
    if (existsSync(path)) args.push('--bind', path, path);
  }
  // No host credentials or inherited API tokens enter the command environment.
  args.push('--setenv', 'PATH', '/usr/bin:/bin', '--setenv', 'HOME', '/tmp', '--setenv', 'TMPDIR', '/tmp', '--setenv', 'PYTHONDONTWRITEBYTECODE', '1', '--chdir', contract.workspace, '--', '/bin/bash', '-c', command);
  return args;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--sandbox') {
  try {
    const contract = JSON.parse(readFileSync(process.argv[3], 'utf8'));
    const argv = process.argv.slice(process.argv.indexOf('--', 4) + 1);
    if (argv.length !== 3 || !['bash', '/bin/bash', '/usr/bin/bash'].includes(argv[0]) || argv[1] !== '-c') throw new Error('Unsupported command launcher.');
    process.execve('/usr/bin/bwrap', ['/usr/bin/bwrap', ...sandboxArgs(contract, argv[2])], { PATH: '/usr/bin:/bin' });
  } catch (error) {
    process.stderr.write('DSH_EXECUTOR_SANDBOX: ' + error.message + '\n');
    process.exit(1);
  }
}

export function apply(ctx) {
  const contract = process.env.DSH_DELEGATE_CONTRACT ? JSON.parse(readFileSync(process.env.DSH_DELEGATE_CONTRACT, 'utf8')) : null;
  const boundary = createBoundary(contract);
  const allowed = toolsFor(contract);
  let agents = 0;
  if (contract) {
    // required:true keeps the operational closeout facts visible even when
    // optional runtime-context snapshots are disabled. The provider runs again
    // after agent/request admission, so the model sees this request's count.
    ctx.systemPrompt.context({
      name: 'codex-delegate-budget',
      order: 500,
      required: true,
      text: () => boundary.notice(),
    });
  }
  ctx.tools.guard(exec => boundary.guard(exec));
  ctx.on('tools/result', (exec, result) => {
    const evidence = commandEvidence(exec, result);
    if (evidence) process.stderr.write('DSH_MCP_COMMAND ' + JSON.stringify(evidence) + '\n');
  });
  ctx.on('agent/created', ({ agent }) => {
    if (++agents !== 1) throw new Error('Nested agents are disabled for MCP delegation.');
    agent.ctx.tools.presentAs('native');
    agent.ctx.tools.restrict({ allow: allowed });
  });
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembled = await next();
    return { ...assembled, tools: boundary.filterTools(assembled.tools) };
  }, { prepend: true });
  ctx.on('agent/request', async ({ agent }, next) => {
    boundary.beginRequest();
    if (ctx.tools.wireSchemas(agent).schemas.some(tool => !allowed.includes(tool.name))) throw new Error('Unexpected capability; refusing the model request.');
    const config = await next();
    process.stderr.write('DSH_MCP_BOUNDARY ' + JSON.stringify({ agents, requests: boundary.requests, tools: allowed.length, allowed_tools: allowed, provider: config.provider, model: config.model }) + '\n');
    return config;
  });
  ctx.provide('codexDelegateBoundary', true);
}
