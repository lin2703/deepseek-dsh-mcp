// Minimal stdio MCP adapter over the installed DeepSeek Harness. No dependencies.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { LIMITS, canonical, closeoutSchedule, denial, normalizeExecution, toolsFor, within } from './guard.mjs';
import { dshLaunchScript, resolveDshCli } from './runtime.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const UNKNOWN = 'unknown';
const MAX_FINAL_TEXT = 4000;
export const TOOL = {
  name: 'deepseek_delegate',
  description: 'Delegate bounded development execution to DeepSeek Harness. Astra plans and accepts; DeepSeek reads/searches code, implements changes and runs the specified checks when execution is supplied. Provide the project constraints, writable paths, exact authorized commands and acceptance criteria. DeepSeek cannot spawn agents, redelegate, escalate permissions or start background jobs. Commands run without network in a scoped filesystem sandbox. read, glob and grep are read-only; write and edit exist only when write_paths are granted; bash exists only for the exact authorized commands. The model-visible bash schema enumerates exactly those authorized command strings: choose one verbatim, use workdir equal to the assigned workspace or ".", set timeoutMs greater than 0 and at most 120000 ms, and do not send background or escalation parameters. A command absent from the enum is refused before execution and reported as not executed; dependency or environment probes belong inside an authorized implementation/check command, not as extra commands. Use read/glob/grep for exploration: granting a file read root does not grant its parent directory. A clearly denied, unexecuted exploratory ls/glob/grep becomes a non-blocking warning only when all required authorized commands actually exited 0 and the same target evidence was later obtained through an authorized read/glob/grep; every other denial remains a failure, and a missing necessary permission must be reported as a blocker. Model request budget: max_steps 1..64 (default 24); hard deadline: timeout_seconds 10..900 (default 600); each command has a hard 120000 ms limit. Commands are matched as exact strings and run one per call: do not concatenate them with &&, ; or |. About 20% of the request budget (at most 12 requests) is reserved for verification and handoff; the final request is summary-only with tools disabled, and no additional model requests are granted. Returns a stable structured handoff with observed writes, actual command results, missing checks, non-blocking warnings and blockers, plus the actual tool transcript and session. Astra reviews the diff and evidence without redoing the implementation or automatically auditing it again. One active task per server/workspace; identical requests share a result. Omit execution only for a backwards-compatible text-only answer.',
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      task: { type: 'string', minLength: 1, maxLength: 8192, description: 'One concrete deliverable owned by DeepSeek.' },
      context: { type: 'string', maxLength: 65536, description: 'Task entry points, necessary context and applicable AGENTS/project constraints. Do not send credentials or unrelated private data.' },
      acceptance: { type: 'string', minLength: 1, maxLength: 8192, description: 'Concrete deliverables and checks. Execution should report modified files, actual commands/results and any unresolved failures.' },
      execution: {
        type: 'object', additionalProperties: false, required: ['workspace'],
        description: 'Astra assigns permissions within the current user authorization and sandbox. This object enables execution; it does not grant a new experiment or an approval bypass.',
        properties: {
          workspace: { type: 'string', description: 'Absolute existing project/task directory; implicit read scope and fixed cwd.' },
          write_paths: { type: 'array', maxItems: 32, items: { type: 'string' }, default: [], description: 'Absolute task-specific files/directories within workspace. Protected/sealed trees, .git/.codex/.agents/.ssh/.aws and hard-linked files are refused. Empty means read-only.' },
          read_roots: { type: 'array', maxItems: 32, items: { type: 'string' }, default: [], description: 'Additional absolute, task-relevant read paths; never credential directories or broad roots. A single-file read root authorizes that file only, not its parent directory.' },
          commands: { type: 'array', maxItems: 16, items: { type: 'string', maxLength: 8192 }, default: [], description: `Exact authorized shell command strings, one command per string (max ${16}). Each call is matched verbatim at the workspace; shell composition (&&, ;, |, substitutions), credentials and network are not authorized. Dependency or environment inspections must be part of these authorized commands, not separate probe commands. Per-command hard limit is 120000 ms. Tests may write only inside write_paths or private /tmp.` },
          max_steps: { type: 'integer', minimum: 1, maximum: 64, default: 24, description: 'Maximum model requests, 1..64. About 20% (at most 12) are reserved for verification and handoff; the final request is summary-only with tools disabled. This is a hard cap, not an extra retry budget.' },
          timeout_seconds: { type: 'integer', minimum: 10, maximum: 900, default: 600, description: 'Hard wall-clock deadline, 10..900 seconds. Closeout hints appear as the deadline approaches; the process is stopped at the deadline without retry.' },
        },
      },
    },
    required: ['task', 'context', 'acceptance'],
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
};
const cache = new Map();
let active = null;
let child = null;
let shuttingDown = false;
let input = null;
const result = (payload, error = false) => ({ content: [{ type: 'text', text: JSON.stringify(payload) }], isError: error });
const send = (message) => { if (!shuttingDown) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n'); };

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const firstDefined = (...values) => values.find(value => value !== undefined && value !== null);
const excerpt = (text, limit = 800) => {
  const value = String(text ?? '').replace(/\0/g, '').trim();
  return value.length > limit ? value.slice(0, limit) + '…' : value;
};
function asText(value) {
  if (value === null || value === undefined || value === false) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || value === true) return String(value);
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join('\n');
  if (isObject(value)) {
    for (const key of ['text', 'content', 'message', 'output', 'result', 'error']) {
      if (value[key] !== undefined && value[key] !== value) {
        const text = asText(value[key]);
        if (text) return text;
      }
    }
  }
  return '';
}
function directExitCode(value) {
  if (!isObject(value)) return undefined;
  for (const key of ['exit_code', 'exitCode']) {
    const raw = value[key];
    if (Number.isInteger(raw)) return raw;
    if (typeof raw === 'string' && /^-?\d+$/.test(raw)) return Number(raw);
  }
  return undefined;
}
function findExitCode(value, depth = 0, seen = new Set()) {
  if (!isObject(value) || depth > 4 || seen.has(value)) return undefined;
  seen.add(value);
  const direct = directExitCode(value);
  if (direct !== undefined) return direct;
  for (const nested of Object.values(value)) {
    const found = findExitCode(nested, depth + 1, seen);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Parse a JSONL stream leniently so a corrupt suffix never discards earlier evidence. */
export function parseEventStream(text) {
  const events = [];
  const invalid_lines = [];
  let invalid_count = 0;
  const lines = String(text ?? '').split(/\r?\n/);
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const value = JSON.parse(line);
      if (!isObject(value)) throw new Error('not a JSON object');
      events.push(value);
    } catch (error) {
      invalid_count++;
      if (invalid_lines.length < 20) invalid_lines.push({ line: index + 1, error: String(error?.message ?? error), excerpt: excerpt(line, 200) });
    }
  });
  return { events, invalid_lines, invalid_count };
}

export function parseBoundaries(text) {
  const boundaries = [];
  const invalid_lines = [];
  for (const [index, line] of String(text ?? '').split(/\r?\n/).entries()) {
    if (!line.startsWith('DSH_MCP_BOUNDARY ')) continue;
    try {
      const value = JSON.parse(line.slice('DSH_MCP_BOUNDARY '.length));
      if (!isObject(value)) throw new Error('not a JSON object');
      boundaries.push(value);
    } catch (error) {
      if (invalid_lines.length < 20) invalid_lines.push({ line: index + 1, error: String(error?.message ?? error), excerpt: excerpt(line, 200) });
    }
  }
  return { boundaries, invalid_lines };
}

export function parseRunOutput(outcome = {}) {
  const stdout = parseEventStream(outcome.stdout);
  const stderr = parseBoundaries(outcome.stderr);
  const facts = parseEventStream(String(outcome.stderr ?? '').split(/\r?\n/)
    .filter(line => line.startsWith('DSH_MCP_COMMAND '))
    .map(line => line.slice('DSH_MCP_COMMAND '.length)).join('\n'));
  const commandFacts = new Map(facts.events.filter(entry => typeof entry.call_id === 'string').map(entry => [entry.call_id, entry]));
  const events = stdout.events.map(event => {
    const fact = event.type === 'tool_result' ? commandFacts.get(event.callId ?? event.call_id) : null;
    return fact ? { ...event, command_evidence: fact } : event;
  });
  return { ...stdout, events, boundaries: stderr.boundaries, invalid_boundaries: [...stderr.invalid_lines, ...facts.invalid_lines] };
}

function normalizeCall(event, index) {
  const data = isObject(event.data) ? event.data : {};
  const tool = firstDefined(event.tool, event.name, data.tool, data.name);
  const rawArguments = firstDefined(event.input, event.arguments, event.args, data.input, data.arguments, data.args, {});
  let args = rawArguments;
  if (typeof rawArguments === 'string') {
    try { args = JSON.parse(rawArguments); }
    catch { args = { raw: rawArguments }; }
  }
  return {
    index,
    tool: typeof tool === 'string' ? tool : null,
    args: isObject(args) ? args : {},
    call_id: firstDefined(event.call_id, event.callId, event.id, data.call_id, data.callId, data.id) ?? null,
    result: null,
    event,
  };
}

function normalizeResult(event, index) {
  const data = isObject(event.data) ? event.data : {};
  const tool = firstDefined(event.tool, event.name, data.tool, data.name);
  const status = firstDefined(event.status, data.status);
  const errorValue = firstDefined(event.is_error, event.isError, event.error, data.is_error, data.isError, data.error);
  const command = event.command_evidence;
  const topExit = directExitCode(event) ?? directExitCode(data);
  const evidenceExit = findExitCode(command);
  // Canonical command evidence and a top-level exit code must not silently
  // disagree. A conflict is itself a failure; keep the nonzero value visible
  // instead of letting the first zero found by a recursive scan win.
  const exitCodeConflict = topExit !== undefined && evidenceExit !== undefined && topExit !== evidenceExit;
  const exit_code = exitCodeConflict
    ? (evidenceExit !== 0 ? evidenceExit : topExit)
    : (evidenceExit !== undefined ? evidenceExit : topExit);
  // Actual execution facts outrank human-readable output text: a real zero
  // exit is a success even if the output happens to look like a refusal, but a
  // real nonzero exit, timeout, signal or explicit structured error is always a
  // failure. Structured status/error is not ordinary output text.
  const factFailed = Boolean(command && (command.timed_out === true || command.aborted === true || command.signal || command.stopped || command.isError === true || command.is_error === true));
  const executionFailed = factFailed || exitCodeConflict || (Number.isInteger(exit_code) && exit_code !== 0);
  const structuredError = status === 'error' || status === 'failed' || event.ok === false || errorValue === true
    || (errorValue !== undefined && errorValue !== null && errorValue !== false)
    || command?.isError === true || command?.is_error === true;
  const isError = executionFailed || structuredError;
  const executedClean = !isError && Number.isInteger(exit_code);
  const isSuccess = !isError && (executedClean || status === 'success' || status === 'ok' || status === 'completed' || event.ok === true);
  const text = excerpt(asText(firstDefined(event.result, event.content, event.output, event.message, data.result, data.content, data.output, data.message, event.error, data.error)), 800);
  const observedExecution = Number.isInteger(exit_code) || Boolean(command);
  // A denial is only a pre-execution refusal. Once any execution fact exists
  // (including command evidence with an unknown exit code), refusal-like output
  // is an ordinary execution result and can never masquerade as unexecuted.
  const denied = isError && !observedExecution && /(?:Capability not granted|Escalation and background jobs are disabled|Command is outside Astra|Use the assigned workspace|Per-command (?:limit|timeoutMs)|FINAL REQUEST|Path is outside the assigned|Path resolution failed|Hard-linked files are not writable|This command already ran)/i.test(text);
  return {
    index,
    tool: typeof tool === 'string' ? tool : null,
    call_id: firstDefined(event.call_id, event.callId, event.id, data.call_id, data.callId, data.id) ?? null,
    status: typeof status === 'string' ? status : null,
    outcome: isError ? 'error' : isSuccess ? 'success' : 'unknown',
    exit_code,
    exit_code_conflict: exitCodeConflict,
    structured_error: structuredError,
    denied,
    text,
    event,
  };
}

function pairTranscript(events) {
  const calls = [];
  const results = [];
  events.forEach((event, index) => {
    if (event?.type === 'tool_call' || event?.type === 'tool/call') calls.push(normalizeCall(event, index));
    else if (event?.type === 'tool_result' || event?.type === 'tool/result') results.push(normalizeResult(event, index));
  });
  const used = new Set();
  // Pairing is strict: same call id (or both absent), a compatible tool name,
  // and a result that appears after the call. Missing result tool names are
  // tolerated because real headless logs can omit them; a mismatched name is
  // never evidence for the call.
  const compatible = (call, candidate) => call.tool === null || candidate.tool === null || call.tool === candidate.tool;
  for (const call of calls) {
    const match = results.findIndex((candidate, index) => !used.has(index)
      && candidate.index > call.index
      && compatible(call, candidate)
      && (call.call_id === null ? candidate.call_id === null : candidate.call_id === call.call_id));
    if (match >= 0) {
      call.result = results[match];
      used.add(match);
    }
  }
  // Two complete call/result pairs can otherwise pair "successfully" while
  // reusing one call id. That is contradictory evidence, not two executions.
  const duplicate_pairs = [];
  const byCallId = new Map();
  for (const call of calls) {
    if (call.call_id === null || call.call_id === undefined) continue;
    const key = String(call.call_id);
    const group = byCallId.get(key) ?? [];
    group.push(call);
    byCallId.set(key, group);
  }
  for (const [call_id, group] of byCallId) {
    const complete = group.filter(call => call.result);
    if (complete.length < 2) continue;
    duplicate_pairs.push({
      call_id,
      tool: complete.find(call => call.tool !== null)?.tool ?? null,
      call_indexes: complete.map(call => call.index),
      result_indexes: complete.map(call => call.result.index),
    });
  }
  return { calls, results, orphan_results: results.filter((_, index) => !used.has(index)), duplicate_pairs };
}

function targetKey(call) {
  if (call.tool === 'bash') return `command:${call.args.command ?? ''}`;
  const path = firstDefined(call.args.file_path, call.args.path);
  if (typeof path === 'string') return `path:${path}`;
  return `${call.tool ?? 'unknown'}:${JSON.stringify(call.args)}`;
}

const SIMPLE_LS_FLAG = /^-(?:a|l|al|la)$/;
const SIMPLE_PATH = /^(?:\/|[A-Za-z0-9._@+])[A-Za-z0-9._/@+-]*$/;
// A later ordinary success must never erase these explicit capability/scope
// refusals; only pre-execution exploratory denials have a recovery path.
const SEVERE_DENIAL = /Escalation and background jobs are disabled|Capability not granted|Hard-linked files are not writable|Path is outside the assigned write scope|Use the assigned workspace|Per-command timeoutMs/i;

/** Conservative ls parser: only ls, -a/-l flags, simple paths and one trailing 2>&1. */
function parseSimpleLs(command) {
  if (typeof command !== 'string' || !command || command !== command.trim()) return null;
  let body = command;
  if (/\s+2>&1$/.test(body)) body = body.replace(/\s+2>&1$/, '');
  if (!body || !/^[A-Za-z0-9._/@+ -]+$/.test(body)) return null;
  const tokens = body.split(/\s+/);
  if (tokens.shift() !== 'ls') return null;
  const targets = [];
  for (const token of tokens) {
    if (SIMPLE_LS_FLAG.test(token)) continue;
    if (!SIMPLE_PATH.test(token) || token.split('/').includes('..')) return null;
    targets.push(token);
  }
  return targets;
}

function resolvedTarget(contract, raw) {
  try { return canonical(resolve(contract?.workspace ?? '.', raw || '.')); }
  catch { return null; }
}

function explicitFileReadRoots(contract) {
  const roots = [];
  for (const root of contract?.read_roots ?? []) {
    try { if (statSync(root).isFile()) roots.push(root); }
    catch { /* A vanished root is no longer evidence of an explicit file grant. */ }
  }
  return roots;
}

/** Every ls target must be inside a read root or be an explicit single-file root's parent. */
function allowedLsTargets(contract, targets) {
  const roots = contract?.read_roots ?? [];
  const parents = new Set(explicitFileReadRoots(contract).map(root => dirname(root)));
  const resolved = (targets.length ? targets : ['.']).map(raw => resolvedTarget(contract, raw));
  if (resolved.some(target => !target)) return null;
  if (resolved.some(target => !roots.some(root => within(target, root)) && !parents.has(target))) return null;
  return resolved;
}

/** Only the direct parent of an explicitly granted file is a recoverable enumeration target. */
function enumerationTarget(contract, call) {
  const raw = firstDefined(call.args?.file_path, call.args?.path);
  if (typeof raw !== 'string' || !raw) return null;
  const target = resolvedTarget(contract, raw);
  if (!target) return null;
  const files = explicitFileReadRoots(contract).filter(root => dirname(root) === target);
  return files.length > 0 ? { target, files } : null;
}

function hasExecutionEvidence(result) {
  const fact = result?.event?.command_evidence;
  // Canonical command evidence proves an execution happened even when its exit
  // code is unknown; such a result is never an unexecuted duplicate rejection.
  return Number.isInteger(result?.exit_code) || Boolean(fact);
}

/** A real command outcome, including timeout/signal or a structured conflict, always beats refusal-like text. */
function executionFailure(result) {
  const fact = result?.event?.command_evidence;
  return result?.exit_code_conflict === true
    || result?.structured_error === true
    || (Number.isInteger(result?.exit_code) && result.exit_code !== 0)
    || Boolean(fact && (fact.timed_out === true || fact.aborted === true || fact.signal || fact.stopped));
}

/**
 * Only an unexecuted boundary rejection of an unchanged repeat may inherit the
 * prior result. A duplicate-looking message with a real execution fact was an
 * actual run and must stay a failure.
 */
function isGuardDuplicate(result) {
  return Boolean(result) && result.denied && !hasExecutionEvidence(result)
    && /This command already ran against the current edits/i.test(result.text);
}

/** Classify only pre-execution exploratory denials with a strictly recoverable shape. */
function recoverableDenial(call, contract) {
  const result = call?.result;
  if (!result || result.outcome !== 'error' || !result.denied || hasExecutionEvidence(result)) return null;
  if (call.args?.sandbox_permissions || call.args?.run_in_background) return null;
  if (call.tool === 'bash') {
    if (!result.text.includes("Command is outside Astra's execution contract")) return null;
    if ((contract?.commands ?? []).includes(call.args?.command)) return null;
    // Recovery is only for workspace exploration: a foreign workdir or an
    // out-of-contract timeout/background request remains a failure.
    if (resolvedTarget(contract, call.args?.workdir ?? '.') !== contract?.workspace) return null;
    if (call.args?.timeoutMs !== undefined && (!Number.isInteger(call.args.timeoutMs) || call.args.timeoutMs <= 0 || call.args.timeoutMs > LIMITS.command_timeout_ms)) return null;
    const targets = parseSimpleLs(call.args?.command);
    if (targets === null) return null;
    const resolved = allowedLsTargets(contract, targets);
    return resolved ? { kind: 'ls', targets: resolved } : null;
  }
  if (call.tool === 'glob' || call.tool === 'grep') {
    if (!result.text.includes('Path is outside the assigned read scope')) return null;
    const enumeration = enumerationTarget(contract, call);
    return enumeration ? { kind: 'enumeration', targets: [enumeration.target], files: enumeration.files } : null;
  }
  return null;
}

function successfulReadTarget(call, contract) {
  if (!call?.result || call.result.outcome !== 'success' || !['read', 'glob', 'grep'].includes(call.tool)) return null;
  const explicit = firstDefined(call.args?.file_path, call.args?.path);
  // glob/grep default to the workspace exactly as guard.denial does.
  const raw = typeof explicit === 'string' && explicit ? explicit : ['glob', 'grep'].includes(call.tool) ? '.' : null;
  if (typeof raw !== 'string') return null;
  // The replacement must satisfy the same guard contract as a fresh call; a
  // success string alone (e.g. escalate, background or out-of-scope) never counts.
  if (denial(contract, call.tool, call.args ?? {})) return null;
  const target = resolvedTarget(contract, raw);
  if (!target) return null;
  return (contract?.read_roots ?? []).some(root => within(target, root)) ? target : null;
}

function targetRelated(denial, alternativeTarget) {
  if (denial.kind === 'enumeration') return denial.files.includes(alternativeTarget);
  return denial.targets.some(target => {
    if (alternativeTarget === target) return true;
    try { return statSync(target).isDirectory() && within(alternativeTarget, target); }
    catch { return false; }
  });
}

/**
 * Recover only denials that indisputably happened before execution and were
 * later replaced by a successful read/glob/grep through an authorized path.
 */
function recoverableWarnings(calls, contract) {
  const recovered = [];
  calls.forEach((call, index) => {
    const denial = recoverableDenial(call, contract);
    if (!denial) return;
    const alternatives = [];
    for (const candidate of calls.slice(index + 1)) {
      if (candidate.call_id === null || candidate.call_id === undefined) continue;
      const target = successfulReadTarget(candidate, contract);
      if (!target || !targetRelated(denial, target)) continue;
      alternatives.push({ call_id: candidate.call_id, tool: candidate.tool, target });
    }
    if (alternatives.length === 0) return;
    recovered.push({
      call,
      warning: {
        tool: call.tool,
        call_id: call.call_id,
        target: targetKey(call),
        message: excerpt(call.result.text || `Tool ${call.tool ?? 'unknown'} failed`, 300),
        targets: denial.targets,
        alternative_call_id: alternatives[0].call_id,
        alternative_call_ids: [...new Set(alternatives.map(entry => entry.call_id))],
        alternatives,
        reason: 'recoverable_exploration_denial',
      },
    });
  });
  return recovered;
}

function commandEntry(command, calls) {
  const matching = calls.filter(call => call.tool === 'bash' && call.args.command === command);
  if (matching.length === 0) {
    return { command, authorized: true, status: 'not_run', result: 'not_run', exit_code: UNKNOWN, call_id: null, attempts: 0, output_excerpt: '' };
  }
  // Only a genuine guard duplicate (no execution fact) may reuse the prior
  // result. A real later run, even one whose output contains the duplicate
  // sentence, remains the latest attempt and its exit code decides the status.
  const call = matching.findLast(entry => !isGuardDuplicate(entry.result)) ?? matching.at(-1);
  const result = call.result;
  if (!result) {
    return { command, authorized: true, status: 'unfinished', result: 'unfinished', exit_code: UNKNOWN, call_id: call.call_id, attempts: matching.length, output_excerpt: '' };
  }
  let status;
  let outcome;
  if (hasExecutionEvidence(result)) {
    if (executionFailure(result)) {
      status = 'failed';
      outcome = 'error';
    } else if (Number.isInteger(result.exit_code)) {
      status = 'succeeded';
      outcome = 'success';
    } else {
      // Execution is proven, but no usable exit code remains. Report it as
      // unverified rather than as an unexecuted/denied duplicate.
      status = 'unknown';
      outcome = 'unknown';
    }
  } else if (isGuardDuplicate(result)) {
    // Defensive fallback when the only matching call is a duplicate rejection.
    status = 'not_executed';
    outcome = 'denied';
  } else if (result.denied) {
    status = 'not_executed';
    outcome = 'denied';
  } else if (result.outcome === 'error') {
    status = 'failed';
    outcome = 'error';
  } else if (result.outcome === 'success') {
    status = 'succeeded_unverified';
    outcome = 'success';
  } else {
    status = 'unknown';
    outcome = 'unknown';
  }
  return {
    command,
    authorized: true,
    status,
    result: outcome,
    exit_code: Number.isInteger(result.exit_code) ? result.exit_code : UNKNOWN,
    call_id: call.call_id,
    attempts: matching.length,
    output_excerpt: result.text,
  };
}

function normalizeStop(outcome) {
  const raw = outcome?.stop;
  if (isObject(raw)) return { kind: String(raw.kind ?? 'stopped'), message: String(raw.message ?? '') };
  if (typeof raw === 'string' && raw) return { kind: 'stopped', message: raw };
  if (outcome?.timed_out === true) return { kind: 'deadline', message: 'DeepSeek exceeded its deadline; stopped without retry.' };
  if (outcome?.cancelled === true) return { kind: 'cancelled', message: 'DeepSeek delegation was cancelled; stopped without retry.' };
  const failed = typeof outcome?.failed === 'string' ? outcome.failed : '';
  if (!failed) return null;
  if (/deadline|exceeded its deadline/i.test(failed)) return { kind: 'deadline', message: failed };
  if (/cancel/i.test(failed)) return { kind: 'cancelled', message: failed };
  if (/output exceeded|response limit/i.test(failed)) return { kind: 'output_limit', message: failed };
  if (/could not launch|launch/i.test(failed)) return { kind: 'launch_failed', message: failed };
  return { kind: 'stopped', message: failed };
}

const CLAIM = /\b(?:done|complete(?:d)?|finished|all (?:checks|tests) pass(?:ed)?|acceptance (?:met|satisfied))\b|完成|已通过|全部通过/i;
const NOT_CLAIM = /\bnot\s+(?:done|complete|finished)\b|未完成/i;

function makeSummary({ status, stop_reason, final_text, observed, commandEntries, missing, unresolved, budget, validEvents, orphanCount = 0, duplicateCount = 0 }) {
  if (final_text && status === 'completed') {
    return excerpt(final_text, MAX_FINAL_TEXT);
  }
  const writes = observed.length;
  const commands = commandEntries.filter(entry => entry.status === 'succeeded').length;
  switch (stop_reason) {
    case 'budget_exhausted':
      return excerpt(`Model request budget exhausted after ${budget.used_requests}/${budget.max_steps} requests before a final summary. Observed ${writes} file write(s) and ${commands} successful authorized command(s); ${missing.length} authorized check(s) missing.`, MAX_FINAL_TEXT);
    case 'deadline_exceeded':
      return excerpt(`Delegation hit its hard deadline after ${budget.used_requests}/${budget.max_steps} requests. Observed ${writes} file write(s) and ${commands} successful authorized command(s); partial evidence was retained for handoff.`, MAX_FINAL_TEXT);
    case 'cancelled':
      return excerpt(`Delegation was cancelled after ${budget.used_requests}/${budget.max_steps} requests. Observed ${writes} file write(s); partial evidence was retained and no retry was attempted.`, MAX_FINAL_TEXT);
    case 'invalid_jsonl':
      return excerpt(`The DSH output stream contained malformed JSONL. Kept ${validEvents} valid event(s), ${writes} observed write(s) and ${commands} successful authorized command(s); no missing evidence was invented.`, MAX_FINAL_TEXT);
    case 'empty_final':
      return 'The final model response was empty. No completion can be accepted from model text; inspect the retained transcript and observed writes instead.';
    case 'missing_final':
      return `The delegation ended without a final model response after ${budget.used_requests}/${budget.max_steps} requests. Only executed tool evidence is reported.`;
    case 'unfinished_tool_call':
      return 'At least one tool call started without a recorded result. Treat its effect as unverified and inspect the partial evidence before continuing.';
    case 'unresolved_failures':
      return `The delegation has ${unresolved.length} unresolved tool/command failure(s); it is not acceptance-ready.`;
    case 'unpaired_results':
      return `The transcript contains ${orphanCount} tool result(s) that cannot be paired with a tool call by call id, tool name and time order. Completion cannot be accepted from contradictory or orphaned evidence.`;
    case 'duplicate_evidence':
      return `The transcript contains ${duplicateCount} complete tool call/result pair(s) that reuse the same call id. Duplicate complete pairs are contradictory evidence; completion cannot be accepted from them.`;
    case 'missing_checks':
      return `The delegation did not execute ${missing.length} authorized check(s); it is not acceptance-ready.`;
    case 'unverified_commands':
      return 'Authorized command results lack a verified zero exit code; they are reported as unknown and are not accepted as passing checks.';
    case 'workspace_locked':
      return 'The workspace is locked by another delegation. No new execution was started and no lock was removed.';
    case 'launch_failed':
      return 'The configured DeepSeek Harness could not be launched; no execution evidence was produced.';
    case 'contract_violation':
      return 'The run violated its execution contract (unexpected capability, boundary mismatch or unauthorized call); no success is reported.';
    case 'process_error':
      return 'The DSH process exited with a nonzero status before a complete handoff; inspect the retained evidence.';
    case 'turn_error':
      return 'The model turn ended with an error instead of a completed final response; inspect the retained evidence.';
    case 'completed':
      return excerpt(`Delegation completed with ${writes} observed file write(s) and ${commands} successful authorized command(s). Review observed writes and actual command results; the adapter does not generate a diff.`, MAX_FINAL_TEXT);
    default:
      return excerpt(`Delegation ended as ${status} (${stop_reason}) with ${validEvents} valid event(s). Inspect the retained evidence; no automatic retry was performed.`, MAX_FINAL_TEXT);
  }
}

/** Build the stable, structured handoff for every terminal state. */
export function buildHandoff(contract, outcome = {}, parsed = parseRunOutput(outcome)) {
  const events = parsed.events ?? [];
  const invalidCount = (parsed.invalid_count ?? 0) + (parsed.invalid_boundaries?.length ?? 0);
  const { calls, results, orphan_results, duplicate_pairs } = pairTranscript(events);
  const session = events.find(event => event.type === 'session') ?? null;
  const final = events.findLast(event => event.type === 'final') ?? null;
  const turn = events.findLast(event => event.type === 'status' && event.phase === 'turn_end') ?? null;
  const boundary = (parsed.boundaries ?? []).at(-1) ?? null;
  const finalText = final ? excerpt(asText(firstDefined(final.text, final.message, final.data?.text, final.data?.message, final.content)), MAX_FINAL_TEXT) : '';
  const stop = normalizeStop(outcome);
  const maxSteps = contract?.max_steps ?? 1;
  const allowed = toolsFor(contract);
  const validBoundary = Boolean(boundary) && (parsed.boundaries ?? []).length === boundary.requests && boundary.requests <= maxSteps && (parsed.boundaries ?? []).every((entry, index) => entry.agents === 1 && entry.requests === index + 1 && JSON.stringify(entry.allowed_tools) === JSON.stringify(allowed));
  const turnCompleted = turn?.reason?.kind === 'completed';

  const observedMap = new Map();
  const attempted = [];
  for (const call of calls) {
    if (call.tool !== 'write' && call.tool !== 'edit') continue;
    const path = firstDefined(call.args.file_path, call.args.path);
    if (typeof path !== 'string' || !path) continue;
    if (call.result?.outcome === 'success') {
      const entry = observedMap.get(path) ?? { path, tool: call.tool, call_id: call.call_id, operations: 0 };
      entry.tool = call.tool;
      entry.call_id = call.call_id;
      entry.operations++;
      observedMap.set(path, entry);
    } else {
      attempted.push({ path, tool: call.tool, call_id: call.call_id, result: call.result?.outcome ?? 'missing' });
    }
  }
  const observed = [...observedMap.values()];

  const commandEntries = (contract?.commands ?? []).map(command => commandEntry(command, calls));
  const missing = [];
  for (const entry of commandEntries) {
    if (entry.status === 'not_run') missing.push({ command: entry.command, reason: 'not_executed' });
    else if (entry.status === 'unfinished') missing.push({ command: entry.command, reason: 'no_result' });
    else if (entry.status === 'not_executed') missing.push({ command: entry.command, reason: 'guard_denied' });
  }
  const unverifiedCommands = commandEntries.filter(entry => entry.status === 'unknown' || entry.status === 'succeeded_unverified');
  // Recovery never invents a pass: at least one required check must have an
  // actual zero exit, and every required check must be verified successful.
  const checksPassed = commandEntries.length > 0 && commandEntries.every(entry => entry.status === 'succeeded' && entry.exit_code === 0);
  const recovered = checksPassed ? recoverableWarnings(calls, contract) : [];
  const warnings = recovered.map(entry => entry.warning);
  const recoveredCalls = new Set(recovered.map(entry => entry.call));
  const validCalls = calls.every(call => call.tool !== null && allowed.includes(call.tool) && (call.tool !== 'bash' || (contract?.commands ?? []).includes(call.args.command) || recoveredCalls.has(call)));

  const unfinished = calls.filter(call => !call.result).map(call => ({ tool: call.tool, call_id: call.call_id, target: targetKey(call) }));
  const unresolved = [];
  calls.forEach((call, index) => {
    if (call.result?.outcome !== 'error') return;
    if (recoveredCalls.has(call)) return;
    // Ignore only a true pre-execution duplicate rejection; a real failing run
    // whose text imitates that rejection must stay unresolved.
    if (isGuardDuplicate(call.result)) return;
    const failure = () => ({ tool: call.tool, call_id: call.call_id, target: targetKey(call), message: excerpt(call.result.text || `Tool ${call.tool ?? 'unknown'} failed`, 300) });
    if (call.result.denied && SEVERE_DENIAL.test(call.result.text)) {
      unresolved.push(failure());
      return;
    }
    const laterSuccess = calls.slice(index + 1).some(candidate => candidate.result?.outcome === 'success' && candidate.tool === call.tool && targetKey(candidate) === targetKey(call));
    if (!laterSuccess) unresolved.push(failure());
  });

  const budgetExhausted = !turnCompleted && ((boundary && boundary.requests >= maxSteps) || /Delegation step budget exhausted|step budget exhausted/i.test(String(outcome.stderr ?? '')));
  let stop_reason;
  if (stop?.kind === 'workspace_locked') stop_reason = 'workspace_locked';
  else if (stop?.kind === 'launch_failed') stop_reason = 'launch_failed';
  else if (stop?.kind === 'cancelled') stop_reason = 'cancelled';
  else if (stop?.kind === 'deadline') stop_reason = 'deadline_exceeded';
  else if (stop?.kind === 'output_limit') stop_reason = 'output_limit';
  else if (stop && stop.kind !== 'stopped') stop_reason = stop.kind;
  else if (budgetExhausted) stop_reason = 'budget_exhausted';
  else if (invalidCount > 0) stop_reason = 'invalid_jsonl';
  else if (!final) stop_reason = 'missing_final';
  else if (!finalText) stop_reason = 'empty_final';
  else if (unfinished.length > 0) stop_reason = 'unfinished_tool_call';
  else if (unresolved.length > 0) stop_reason = 'unresolved_failures';
  else if (duplicate_pairs.length > 0) stop_reason = 'duplicate_evidence';
  else if (orphan_results.length > 0) stop_reason = 'unpaired_results';
  else if (!validBoundary || !validCalls) stop_reason = 'contract_violation';
  else if (missing.length > 0) stop_reason = 'missing_checks';
  else if (unverifiedCommands.length > 0) stop_reason = 'unverified_commands';
  else if (!turnCompleted) stop_reason = 'turn_error';
  else if (outcome.code !== 0) stop_reason = 'process_error';
  else if (stop) stop_reason = 'stopped';
  else stop_reason = 'completed';

  const hasEvidence = calls.length > 0 || results.length > 0 || observed.length > 0 || finalText.length > 0;
  let status;
  if (stop_reason === 'workspace_locked') status = 'blocked';
  else if (stop_reason === 'completed') status = 'completed';
  else if (stop_reason === 'launch_failed' || stop_reason === 'contract_violation') status = 'failed';
  else status = hasEvidence ? 'partial' : 'failed';

  const schedule = closeoutSchedule(maxSteps);
  const usedRequests = boundary?.requests ?? 0;
  const budget = {
    max_steps: maxSteps,
    used_requests: usedRequests,
    remaining_requests: Math.max(0, maxSteps - usedRequests),
    reserve: schedule.reserve,
    closeout_from: schedule.closeout_from,
    final_at: schedule.final_at,
    final_request_seen: usedRequests >= maxSteps,
    phase: usedRequests >= maxSteps ? 'final' : usedRequests >= schedule.closeout_from ? 'closeout' : 'implementation',
  };
  const finishedAt = Number.isFinite(outcome.finished_at) ? outcome.finished_at : Date.now();
  const deadlineAt = Number.isFinite(outcome.deadline_at) ? outcome.deadline_at : null;
  const deadline = {
    timeout_seconds: contract?.timeout_seconds ?? null,
    deadline_at: deadlineAt === null ? null : new Date(deadlineAt).toISOString(),
    remaining_ms: deadlineAt === null ? null : Math.max(0, deadlineAt - finishedAt),
    exceeded: stop?.kind === 'deadline' || (deadlineAt !== null && finishedAt >= deadlineAt),
  };
  const commandPossible = [];
  const seenCommands = new Set();
  for (const call of calls) {
    if (call.tool !== 'bash' || typeof call.args.command !== 'string') continue;
    if (seenCommands.has(call.args.command)) continue;
    seenCommands.add(call.args.command);
    commandPossible.push({ command: call.args.command, call_id: call.call_id, result: call.result?.outcome ?? 'unknown' });
  }
  const completionClaim = Boolean(finalText) && CLAIM.test(finalText) && !NOT_CLAIM.test(finalText);
  const blockers = [];
  const addBlocker = text => { if (text && !blockers.includes(text)) blockers.push(text); };
  if (stop?.message) addBlocker(stop.message);
  switch (stop_reason) {
    case 'workspace_locked': addBlocker('The workspace is locked by another delegation; no execution was started.'); break;
    case 'launch_failed': addBlocker('The configured DeepSeek Harness could not be launched.'); break;
    case 'budget_exhausted': addBlocker('The model request budget was exhausted before verification/handoff completed; this is a normal budget stop, not an authorization violation.'); break;
    case 'deadline_exceeded': addBlocker('The hard deadline was reached and the process was stopped without automatic retry.'); break;
    case 'cancelled': addBlocker('The delegation was cancelled; no automatic retry was performed.'); break;
    case 'output_limit': addBlocker('The bounded output limit was reached and the process was stopped.'); break;
    case 'invalid_jsonl': addBlocker('The DSH output stream was malformed; the valid prefix was retained and no missing events were invented.'); break;
    case 'empty_final': addBlocker('The final model response was empty; no completion can be accepted from it.'); break;
    case 'missing_final': addBlocker('No final model response was received.'); break;
    case 'unfinished_tool_call': addBlocker(`Tool call(s) started without a recorded result: ${unfinished.map(call => `${call.tool ?? 'unknown'}${call.call_id ? ` (${call.call_id})` : ''}`).join(', ')}.`); break;
    case 'unresolved_failures': addBlocker(`Unresolved tool/command failure(s): ${unresolved.map(call => `${call.tool ?? 'unknown'}${call.call_id ? ` (${call.call_id})` : ''}`).join(', ')}.`); break;
    case 'missing_checks': addBlocker(`Authorized check(s) were not executed: ${missing.map(entry => JSON.stringify(entry.command)).join(', ')}.`); break;
    case 'unverified_commands': addBlocker('Authorized command results do not include a verified zero exit code; they are recorded as unknown, not as passing checks.'); break;
    case 'contract_violation': addBlocker('Execution contract validation failed (unexpected capability, boundary mismatch or unauthorized call).'); break;
    case 'turn_error': addBlocker(`The model turn ended with ${turn?.reason?.kind ?? 'an error'} instead of completion.`); break;
    case 'process_error': addBlocker(`The DSH process exited with code ${outcome.code ?? UNKNOWN}.`); break;
    default: break;
  }
  if (stop_reason !== 'completed' && finalText && completionClaim && (unresolved.length > 0 || missing.length > 0 || unfinished.length > 0)) {
    addBlocker('The model claimed completion, but unresolved failures or missing authorized checks remain; do not report acceptance complete.');
  }
  if (orphan_results.length > 0) addBlocker(`Unpaired tool result(s) could not be matched to a call by call id, tool name and time order: ${orphan_results.map(entry => `${entry.tool ?? 'unknown'}${entry.call_id ? ` (${entry.call_id})` : ''}`).join(', ')}. These results are not treated as evidence.`);
  if (duplicate_pairs.length > 0) addBlocker(`Duplicate complete tool call/result pair(s) share call id(s) ${[...new Set(duplicate_pairs.map(entry => JSON.stringify(entry.call_id)))].join(', ')}. Duplicate complete pairs are contradictory evidence and are not accepted.`);
  for (const entry of commandEntries) if (entry.status === 'failed') addBlocker(`Authorized command did not succeed: ${JSON.stringify(entry.command)} (exit_code ${entry.exit_code}).`);
  for (const entry of unverifiedCommands) addBlocker(`Authorized command result could not be verified: ${JSON.stringify(entry.command)}.`);
  if (unfinished.length > 0) addBlocker(`Tool call(s) started without a recorded result: ${unfinished.map(call => `${call.tool ?? 'unknown'}${call.call_id ? ` (${call.call_id})` : ''}`).join(', ')}.`);
  if (unresolved.length > 0) addBlocker(`Unresolved tool/command failure(s): ${unresolved.map(call => `${call.tool ?? 'unknown'}${call.call_id ? ` (${call.call_id})` : ''}`).join(', ')}.`);
  if (missing.length > 0) addBlocker(`Authorized check(s) were not executed: ${missing.map(entry => JSON.stringify(entry.command)).join(', ')}.`);
  if (outcome.forced) addBlocker('Forced termination may have left child processes; the workspace lock was retained until ownership is confirmed.');

  const next_steps = [];
  const addNext = text => { if (text && !next_steps.includes(text)) next_steps.push(text); };
  if (status === 'completed') {
    addNext('Review handoff.modified_files.observed and handoff.commands; the adapter does not generate a full diff.');
  } else {
    if (observed.length > 0) addNext(`Review observed writes (${observed.map(entry => entry.path).join(', ')}); command side effects remain unverified.`);
    if (missing.length > 0) addNext(`Run the missing authorized check(s) exactly as supplied: ${missing.map(entry => JSON.stringify(entry.command)).join(', ')}.`);
    if (unresolved.length > 0) addNext('Inspect the failing outputs, fix the cause, and re-run only the exact authorized command after a relevant source change; do not repeat an unchanged failure.');
    if (orphan_results.length > 0) addNext('Reconcile the unpaired tool result(s) with their actual calls in the retained transcript; do not treat orphaned, duplicated or contradictory evidence as a passing check.');
    if (duplicate_pairs.length > 0) addNext(`Reconcile duplicate complete call/result pairs for call id(s) ${[...new Set(duplicate_pairs.map(entry => JSON.stringify(entry.call_id)))].join(', ')}; do not treat either duplicate as passing evidence.`);
    if (unfinished.length > 0) addNext('Confirm whether unfinished tool calls took effect by inspecting their partial output and the target files before continuing.');
    if (stop_reason === 'budget_exhausted' || stop_reason === 'deadline_exceeded') addNext('Astra should inspect the retained evidence after confirming execution stopped, then finish the specific gap or choose at most one bounded correction; do not automatically redelegate with a fresh budget.');
    if (stop_reason === 'cancelled') addNext('Confirm all command processes stopped and inspect the retained evidence before starting any new delegation.');
    if (stop_reason === 'invalid_jsonl') addNext('Recover the valid evidence prefix from handoff.evidence.events; do not reconstruct missing events from model text.');
    if (stop_reason === 'empty_final' || stop_reason === 'missing_final') addNext('Inspect the transcript and observed writes; do not treat the missing/empty final as completion.');
    if (stop_reason === 'workspace_locked') addNext('Confirm the original execution has stopped and inspect its handoff; do not remove a stale lock without checking owner.json.');
    if (outcome.forced) addNext('Confirm all original command processes stopped and inspect the retained workspace lock before taking over.');
    if (next_steps.length === 0) addNext('Inspect handoff.evidence and choose the smallest safe follow-up; no automatic retry was performed.');
  }

  const summary = makeSummary({ status, stop_reason, final_text: finalText, observed, commandEntries, missing, unresolved, budget, validEvents: events.length, orphanCount: orphan_results.length, duplicateCount: duplicate_pairs.length, blockers });
  const handoff = {
    version: 1,
    status,
    stop_reason,
    summary,
    final_text: finalText || null,
    model_claimed_completion: completionClaim,
    modified_files: {
      observed,
      attempted,
      command_possible: commandPossible,
      diff_available: false,
      note: 'Observed entries are successful write/edit tool calls. Command side effects are possible but unverified; no full diff is generated.',
    },
    commands: commandEntries,
    missing_authorized_checks: missing,
    unresolved_failures: unresolved,
    duplicate_pairs,
    warnings,
    unfinished_tool_calls: unfinished,
    unverified_commands: unverifiedCommands.map(entry => entry.command),
    blockers,
    next_steps,
    budget,
    deadline,
    verification: {
      acceptance_ready: status === 'completed',
      model_claimed_completion: completionClaim,
      unresolved_failures: unresolved.length,
      missing_authorized_checks: missing.length,
      warnings: warnings.length,
      unfinished_tool_calls: unfinished.length,
      unpaired_results: orphan_results.length,
      duplicate_pairs: duplicate_pairs.length,
      commands_succeeded: commandEntries.filter(entry => entry.status === 'succeeded').length,
      commands_failed: commandEntries.filter(entry => entry.status === 'failed').length,
      commands_unverified: unverifiedCommands.length,
    },
    evidence: {
      session,
      boundary,
      boundaries: parsed.boundaries ?? [],
      valid_boundary: validBoundary,
      valid_calls: validCalls,
      turn,
      final,
      tool_calls: calls.length,
      tool_errors: results.filter(entry => entry.outcome === 'error').length,
      orphan_results: orphan_results.length,
      duplicate_pairs,
      transcript: events.filter(event => event?.type === 'tool_call' || event?.type === 'tool_result' || event?.type === 'tool/call' || event?.type === 'tool/result'),
      events,
      invalid_jsonl_lines: parsed.invalid_lines ?? [],
      invalid_jsonl_count: parsed.invalid_count ?? 0,
      invalid_boundary_lines: parsed.invalid_boundaries ?? [],
      exit_code: outcome.code ?? null,
      forced: Boolean(outcome.forced),
      stdout_excerpt: excerpt(outcome.stdout, 2000),
      stderr_excerpt: excerpt(outcome.stderr, 2000),
    },
  };
  handoff.error = handoff.status === 'completed' ? null : `Delegation ${handoff.status} (${handoff.stop_reason}). ${handoff.blockers[0] ?? handoff.summary.split('\n')[0] ?? 'Inspect the retained evidence.'} No automatic retry.`;
  return handoff;
}

export function evidenceFor(handoff, outcome) {
  // Keep large tool inputs/results once in the compatibility transcript.
  const { events, transcript, ...metadata } = handoff.evidence;
  return {
    session: handoff.evidence.session,
    boundary: handoff.evidence.boundary,
    tool_calls: handoff.evidence.tool_calls,
    tool_errors: handoff.evidence.tool_errors,
    transcript: handoff.evidence.transcript,
    turn: handoff.evidence.turn,
    final: handoff.evidence.final,
    handoff: { ...handoff, evidence: { ...metadata, non_tool_events: events.filter(event => !transcript.includes(event)), transcript_location: 'transcript' } },
    exit_code: outcome.code ?? null,
    execution_stopped: typeof outcome.forced === 'boolean' ? !outcome.forced : null,
    ...(outcome.forced ? { lock: outcome.lock, warning: 'Forced termination: workspace lock retained. Confirm all original command processes have stopped before taking over.' } : {}),
  };
}

function stopChild() {
  if (!child?.pid || child.stopping) return;
  const proc = child;
  proc.stopping = true;
  // Let dsh dispose its systemd-managed subprocess scopes before releasing ownership.
  try { proc.kill('SIGTERM'); } catch { /* Already exited. */ }
  const timer = setTimeout(() => {
    proc.forcedStop = true;
    try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* Already exited. */ }
  }, 10000);
  timer.unref();
  proc.once('close', () => clearTimeout(timer));
}

async function delegate(args, signal, contract) {
  // Resolve DSH only when a delegation is actually requested. initialize,
  // tools/list and text-only deployments stay usable without DSH installed.
  let launch;
  try {
    launch = dshLaunchScript(resolveDshCli().path);
  } catch (error) {
    const failed = buildHandoff(contract, { code: null, stdout: '', stderr: '', stop: { kind: 'launch_failed', message: `Could not locate the configured DeepSeek Harness: ${error.message}` }, finished_at: Date.now() });
    return result({ ...evidenceFor(failed, { code: null }), error: failed.error }, true);
  }
  const directory = await mkdtemp(join(tmpdir(), 'codex-deepseek-'));
  let lock;
  let releaseLock = true;
  try {
    if (contract) {
      const candidate = join(tmpdir(), 'codex-dsh-lock-' + process.getuid() + '-' + createHash('sha256').update(contract.workspace).digest('hex').slice(0, 24));
      try { await mkdir(candidate, { mode: 0o700 }); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const blocked = buildHandoff(contract, { code: null, stdout: '', stderr: '', stop: { kind: 'workspace_locked', message: 'This workspace is locked by another delegation. Do not duplicate work or remove a stale lock before confirming the original execution has stopped.' }, forced: false, finished_at: Date.now() });
        return result({ ...evidenceFor(blocked, { code: null }), error: blocked.error, lock: candidate }, true);
      }
      lock = candidate;
      await writeFile(join(lock, 'owner.json'), JSON.stringify({ server_pid: process.pid, workspace: contract.workspace, started: new Date().toISOString() }), { mode: 0o600 });
    }
    const contractPath = join(directory, 'contract.json');
    if (contract) await writeFile(contractPath, JSON.stringify(contract), { mode: 0o600 });
    const persona = contract
      ? 'You execute one development task assigned by Astra. Read the relevant files, implement the requested change inside the write scopes, run the supplied checks, and report the changed files and actual results. read, glob and grep are read-only; write and edit require write_paths; bash requires exact authorized commands. Explore with read/glob/grep: a file read grant does not include its parent directory, and only already-authorized replacement paths may continue. A denied exploratory ls/glob/grep is only a non-blocking warning when the same target was later read through an authorized path and every required command actually exited 0; otherwise report the missing permission as a blocker. Commands are exact strings, one per call: do not combine them with &&, ;, | or substitutions, and do not raise the 120000 ms per-command limit. Choose every bash command verbatim from the model-visible command enum; any command absent from that enum is refused before execution and was not executed. Put dependency or environment checks inside an already-authorized implementation/check command instead of sending extra probe commands. Use workdir equal to the assigned workspace or ".", and timeoutMs greater than 0 and at most 120000. The supplied project constraints apply. You own this implementation; Astra plans and accepts it. Do not redelegate, launch agents, change permissions, edit tests to hide failures, expand scope, start research experiments, or perform a second general audit. If a required path or command is missing, or subprocess infrastructure fails, report the exact blocker and stop. Do not retry the same command without a relevant source change, change its timeout to retry, or request escalation. Stop when acceptance is met. Do not claim unexecuted tests passed. Your model-request budget and actual hard deadline are shown in runtime context: when the closeout phase starts, stop new implementation, verify only already-authorized checks, and prepare the handoff. On the final request tools are disabled, so return a concise final summary with observed changed files, actual commands/results (use unknown when absent), unresolved failures, blockers and next steps. Never claim a check passed unless its result is in the transcript.'
      : 'You are a text-only DeepSeek development delegate. Complete exactly the supplied subtask using only its context. Return the requested code, patch, or analysis. Do not execute tools, read files, delegate, expand scope, or claim to have run tests. Astra integrates and verifies your answer.';
    const overlay = [
      '- id: tools\n  config:\n    mode: native',
      `- id: sandbox-policy\n  config:\n    mode: ${contract ? 'workspace-write' : 'read-only'}`,
      ...(contract ? [
        `- id: sandbox\n  config:\n    runnerCommand: ${JSON.stringify([process.execPath, join(ROOT, 'guard.mjs'), '--sandbox', contractPath])}\n    runnerFailureSignatures: ["DSH_EXECUTOR_SANDBOX:", "bwrap:"]`,
        '- id: tool-bash\n  config:\n    enableRunInBackground: false\n    promoteOnTimeout: false',
      ] : []),
      '- id: headless-runner\n  inject: [headlessStartup, codexDelegateBoundary]',
      ...['agent-instructions', 'skill-filesystem', 'session-title-llm', 'goal-round-driver', 'llm-retry'].map(id => `- id: ${id}\n  disabled: true`),
      `- id: system-prompt\n  config:\n    personaPrefix: ${JSON.stringify(persona)}`,
      `- insert:\n    - id: codex-delegate-boundary\n      name: ${JSON.stringify(join(ROOT, 'guard.mjs'))}`,
    ].join('\n') + '\n';
    const patch = join(directory, 'delegate.yml');
    await writeFile(patch, overlay, { mode: 0o600 });
    const timeoutMs = (contract?.timeout_seconds ?? 180) * 1000;
    const deadlineAt = Date.now() + timeoutMs;
    if (signal.aborted) {
      const cancelled = buildHandoff(contract, { code: null, stdout: '', stderr: '', stop: { kind: 'cancelled', message: 'DeepSeek delegation was cancelled before launch; no retry.' }, deadline_at: deadlineAt, finished_at: Date.now() });
      return result({ ...evidenceFor(cancelled, { code: null }), error: cancelled.error }, true);
    }
    const outcome = await new Promise((resolveOutcome) => {
      let proc;
      try {
        proc = spawn(process.execPath, ['--input-type=module', '-e', launch, '--', '--profile', 'headless', '--patch', patch, '--json', '-'], {
          cwd: contract?.workspace ?? directory, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, DSH_TOOLS_MODE: 'native', DSH_PERMISSION_MODE: contract ? 'workspace-write' : 'read-only', DSH_DELEGATE_CONTRACT: contract ? contractPath : '', ...(contract ? { DSH_DELEGATE_DEADLINE_MS: String(deadlineAt) } : {}) },
        });
      } catch (error) {
        resolveOutcome({ code: null, stdout: '', stderr: '', stop: { kind: 'launch_failed', message: `Could not launch the configured DeepSeek Harness: ${error.message}` }, deadline_at: deadlineAt, finished_at: Date.now(), forced: false });
        return;
      }
      child = proc;
      let stdout = '';
      let stderr = '';
      let stop = null;
      const cancel = () => { stop ??= { kind: 'cancelled', message: 'DeepSeek delegation was cancelled; stopped without retry.' }; stopChild(); };
      if (signal.aborted) cancel();
      else signal.addEventListener('abort', cancel, { once: true });
      const timer = setTimeout(() => {
        stop ??= { kind: 'deadline', message: 'DeepSeek exceeded its deadline; stopped without retry.' };
        stopChild();
      }, Math.max(0, deadlineAt - Date.now()));
      for (const [stream, which] of [[proc.stdout, 'stdout'], [proc.stderr, 'stderr']]) {
        stream.setEncoding('utf8');
        stream.on('data', text => {
          if (which === 'stdout') stdout += text; else stderr += text;
          if (stdout.length + stderr.length > 2 * 1024 * 1024) {
            stop ??= { kind: 'output_limit', message: 'DeepSeek output exceeded the bounded response limit; stopped.' };
            stopChild();
          }
        });
      }
      proc.stdin.on('error', () => {});
      proc.on('error', error => { stop ??= { kind: 'launch_failed', message: `Could not launch the configured DeepSeek Harness: ${error.message}` }; });
      proc.on('close', code => {
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        child = null;
        resolveOutcome({ code, stdout, stderr, stop, forced: !!proc.forcedStop, deadline_at: deadlineAt, finished_at: Date.now() });
      });
      try { proc.stdin.end(JSON.stringify({ ...args, ...(contract ? { execution: contract } : {}) })); }
      catch (error) {
        stop ??= { kind: 'launch_failed', message: `Could not send the delegation request: ${error.message}` };
        stopChild();
      }
    });
    releaseLock = !outcome.forced;
    const parsed = parseRunOutput(outcome);
    const handoff = buildHandoff(contract, outcome, parsed);
    const evidence = evidenceFor(handoff, { ...outcome, forced: outcome.forced, lock });
    if (handoff.status === 'completed') return result(evidence);
    return result({ ...evidence, error: handoff.error ?? 'Delegation did not complete; inspect the retained evidence.' }, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
    if (lock && releaseLock) await rm(lock, { recursive: true, force: true });
  }
}

async function dispatch(message) {
  const { id, method, params = {} } = message;
  if (method === 'notifications/cancelled') {
    if (active?.ids.has(params.requestId)) active.controller.abort();
    return;
  }
  if (id === undefined) return;
  if (method === 'initialize') {
    const versions = ['2024-11-05', '2025-03-26', '2025-06-18'];
    send({ id, result: { protocolVersion: versions.includes(params.protocolVersion) ? params.protocolVersion : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'deepseek-dsh', version: '1.2.2' } } });
  } else if (method === 'ping') send({ id, result: {} });
  else if (method === 'tools/list') send({ id, result: { tools: [TOOL] } });
  else if (method === 'tools/call') {
    const args = params.arguments;
    if (params.name !== TOOL.name || !args || Array.isArray(args) || typeof args !== 'object' || Object.keys(args).some(k => !['task', 'context', 'acceptance', 'execution'].includes(k)) ||
        ['task', 'context', 'acceptance'].some(k => typeof args[k] !== 'string' || args[k].length > TOOL.inputSchema.properties[k].maxLength) || !args.task.trim() || !args.acceptance.trim()) {
      send({ id, error: { code: -32602, message: 'Use task, context, acceptance strings and an optional execution object within the tool schema.' } });
      return;
    }
    let contract;
    try { contract = normalizeExecution(args.execution); }
    catch (error) { send({ id, error: { code: -32602, message: error.message } }); return; }
    const key = createHash('sha256').update(JSON.stringify([args.task, args.context, args.acceptance, contract])).digest('hex');
    if (!cache.has(key)) {
      if (active || cache.size >= 32) {
        send({ id, result: result({ error: active ? 'Another subtask is already running. Await its result; do not duplicate work.' : 'This MCP process reached its 32-subtask limit.' }, true) });
        return;
      }
      active = { key, ids: new Set([id]), controller: new AbortController() };
      cache.set(key, delegate(args, active.controller.signal, contract).catch(error => {
        const handoff = buildHandoff(contract, { code: null, stdout: '', stderr: '', stop: { kind: 'launch_failed', message: `Local delegate runtime failed: ${String(error?.message ?? error)}` }, finished_at: Date.now() });
        return result({ ...evidenceFor(handoff, { code: null }), error: 'Local delegate runtime failed; no automatic retry.' }, true);
      }).finally(() => { active = null; }));
    } else if (active?.key === key) active.ids.add(id);
    send({ id, result: await cache.get(key) });
  } else send({ id, error: { code: -32601, message: 'Method not found' } });
}

export function start() {
  input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', line => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); }
    catch { send({ id: null, error: { code: -32700, message: 'Parse error' } }); return; }
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      send({ id: message?.id ?? null, error: { code: -32600, message: 'Invalid request' } }); return;
    }
    dispatch(message).catch(() => send({ id: message.id ?? null, error: { code: -32603, message: 'Internal error' } }));
  });
  input.on('close', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return input;
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  active?.controller.abort();
  stopChild();
  input?.close();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) start();
