import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bashToolSchemaFor, loadGuardConfig, normalizeExecution, sandboxArgs } from './guard.mjs';
import { TOOL } from './server.mjs';
import { resolveDshCli, dshLaunchScript } from './runtime.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));

async function tempDir(t, prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  return directory;
}

async function writeFakeDsh(packageDir) {
  await mkdir(join(packageDir, 'lib'), { recursive: true });
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.1-rc.2', bin: { dsh: 'lib/bin.js' } }));
  await writeFile(join(packageDir, 'lib', 'bin.js'), 'export async function runCli() {}\n');
}

function rpc(messages, env) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [join(ROOT, 'server.mjs')], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* Already gone. */ }
      reject(new Error(`MCP server timed out; stderr: ${stderr}`));
    }, 15000);
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', chunk => { stderr += chunk; });
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', chunk => { stdout += chunk; });
    proc.once('error', error => { clearTimeout(timer); reject(error); });
    proc.once('exit', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`MCP server exited ${code}; stderr: ${stderr}`));
      try {
        const responses = stdout.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
        resolve(responses);
      } catch (error) { reject(new Error(`Invalid JSON-RPC output: ${error.message}; stderr: ${stderr}`)); }
    });
    for (const message of messages) proc.stdin.write(JSON.stringify(message) + '\n');
    proc.stdin.end();
  });
}

test('DSH_CLI_PATH is an absolute override and invalid values fail loudly', async t => {
  const directory = await tempDir(t, 'dsh-runtime-override-');
  const bin = join(directory, 'bin.js');
  await writeFile(bin, 'export async function runCli() {}\n');
  const found = resolveDshCli({ cwd: directory, env: { DSH_CLI_PATH: bin, PATH: '' } });
  assert.equal(found.source, 'DSH_CLI_PATH');
  assert.equal(found.path, realpathSync(bin));
  assert.throws(
    () => resolveDshCli({ cwd: directory, env: { DSH_CLI_PATH: 'relative/bin.js', PATH: '' } }),
    /absolute path/,
  );
  assert.throws(
    () => resolveDshCli({ cwd: directory, env: { DSH_CLI_PATH: join(directory, 'missing.js'), PATH: '' } }),
    /cannot be resolved/,
  );
});

test('adapter-local module and absolute PATH discovery find the real DSH entry', async t => {
  const adapter = await tempDir(t, 'dsh-runtime-adapter-');
  await writeFakeDsh(join(adapter, 'node_modules', '@deepseek-ai', 'dsh'));
  const fromModule = resolveDshCli({ env: { PATH: '' }, adapterRoot: adapter });
  assert.equal(fromModule.source, 'module');
  assert.equal(fromModule.path, realpathSync(join(adapter, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')));

  const binDir = await tempDir(t, 'dsh-runtime-path-');
  const executable = join(binDir, 'dsh');
  await writeFile(executable, '#!/usr/bin/env node\n');
  const empty = await tempDir(t, 'dsh-runtime-empty-');
  const fromPath = resolveDshCli({ env: { PATH: `:${binDir}` }, adapterRoot: empty });
  assert.equal(fromPath.source, 'PATH');
  assert.equal(fromPath.path, realpathSync(executable));
});

test('a delegated workspace package and relative PATH entry cannot supply the DSH CLI', async t => {
  const workspace = await tempDir(t, 'dsh-runtime-workspace-');
  await writeFakeDsh(join(workspace, 'node_modules', '@deepseek-ai', 'dsh'));
  const adapter = await tempDir(t, 'dsh-runtime-adapter-empty-');
  const trustedBin = await tempDir(t, 'dsh-runtime-trusted-path-');
  const trustedEntry = join(trustedBin, 'dsh');
  await writeFile(trustedEntry, 'export async function runCli() {}\n');
  // The task directory must never be searched, even when passed as "cwd".
  // A controlled PATH fallback keeps this test valid with or without a global
  // DSH installation, while the old workspace-first resolver selects the fake.
  const fromWorkspace = resolveDshCli({ cwd: workspace, env: { PATH: trustedBin }, adapterRoot: adapter });
  assert.equal(fromWorkspace.source, 'PATH');
  assert.equal(fromWorkspace.path, realpathSync(trustedEntry));

  const binDir = await tempDir(t, 'dsh-runtime-relative-path-');
  await writeFile(join(binDir, 'dsh'), '#!/usr/bin/env node\n');
  const relativeEntry = relative(process.cwd(), binDir);
  assert.ok(!relativeEntry.startsWith('/'), 'test PATH entry must be relative');
  const fromRelativePath = resolveDshCli({ env: { PATH: `${relativeEntry}:${trustedBin}` }, adapterRoot: adapter });
  assert.equal(fromRelativePath.source, 'PATH');
  assert.equal(fromRelativePath.path, realpathSync(trustedEntry));
});


test('launch script calls runCli explicitly without import-time resolution', () => {
  const script = dshLaunchScript('/opt/example/dsh/lib/bin.js');
  assert.match(script, /import \{runCli\} from "file:\/\/\/opt\/example\/dsh\/lib\/bin\.js"/);
  assert.match(script, /process\.argv\.splice\(1, 0, "\/opt\/example\/dsh\/lib\/bin\.js"\)/);
  assert.match(script, /await runCli\(\)/);
  assert.throws(() => dshLaunchScript('relative/bin.js'), /absolute file path/);
});

test('sealed and runtime roots are validated and never grant write access', async t => {
  const workspace = await tempDir(t, 'dsh-guard-config-');
  const sealed = join(workspace, 'sealed');
  const runtime = join(workspace, 'runtime');
  await mkdir(sealed);
  await mkdir(runtime);
  await writeFile(join(sealed, 'secret.txt'), 'x\n');
  const env = {
    ...process.env,
    DSH_MCP_SEALED_ROOTS: JSON.stringify([sealed]),
    DSH_MCP_RUNTIME_ROOTS: JSON.stringify([runtime]),
  };
  const config = loadGuardConfig(env);
  assert.deepEqual(config.sealed, [realpathSync(sealed)]);
  assert.ok(config.system.includes(realpathSync(runtime)));

  assert.throws(
    () => normalizeExecution({ workspace, write_paths: [join(sealed, 'secret.txt')] }, config),
    /protected or sealed/,
  );
  const contract = normalizeExecution({ workspace, commands: ['true'] }, config);
  assert.equal(contract.read_roots.length, 1, 'runtime roots are mounts, not model read roots');
  assert.deepEqual(contract.write_paths, []);
  const args = sandboxArgs(contract, 'true', config);
  const runtimeRoot = realpathSync(runtime);
  assert.ok(args.includes(runtimeRoot), 'configured runtime root is mounted');
  const roBind = args.indexOf(runtimeRoot);
  assert.equal(args[roBind - 1], '--ro-bind');
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--bind') assert.notEqual(args[index + 1], runtimeRoot, 'runtime roots must never be writable');
  }

  assert.throws(() => loadGuardConfig({ ...process.env, DSH_MCP_SEALED_ROOTS: 'not-json' }), /JSON array/);
  assert.throws(() => loadGuardConfig({ ...process.env, DSH_MCP_RUNTIME_ROOTS: JSON.stringify(['/']) }), /broad root/);
  assert.throws(
    () => loadGuardConfig({ ...process.env, DSH_MCP_RUNTIME_ROOTS: JSON.stringify([join(homedir(), '.ssh')]) }),
    /credential directory/,
  );
});

test('v1.2.2 metadata and model-visible bash enum survive an offline handshake', async t => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.version, '1.2.2');
  assert.equal(pkg.type, 'module');
  assert.match(pkg.scripts.start, /server\.mjs/);
  assert.match(pkg.scripts.test, /node --test/);

  const workspace = await tempDir(t, 'dsh-mcp-metadata-');
  const contract = normalizeExecution({ workspace, commands: ['node --check server.mjs', 'node --test'] });
  const schema = bashToolSchemaFor(contract, { name: 'bash', description: 'old', parameters: { type: 'object' } });
  assert.deepEqual(schema.parameters.properties.command.enum, contract.commands);
  assert.deepEqual(schema.parameters.properties.workdir.enum, [contract.workspace, '.']);
  assert.equal(schema.parameters.properties.timeoutMs.maximum, 120000);
  assert.equal(schema.parameters.additionalProperties, false);
  assert.match(TOOL.description, /model-visible bash schema enumerates exactly those authorized command strings/);
  assert.match(TOOL.description, /refused before execution and reported as not executed/);

  const responses = await rpc([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ], { DSH_CLI_PATH: '', PATH: '' });
  const initialize = responses.find(message => message.id === 1);
  const list = responses.find(message => message.id === 2);
  assert.equal(initialize.result.serverInfo.version, '1.2.2');
  assert.equal(initialize.result.serverInfo.name, 'deepseek-dsh');
  assert.equal(list.result.tools.length, 1);
  assert.equal(list.result.tools[0].name, 'deepseek_delegate');
  assert.match(list.result.tools[0].description, /model-visible bash schema/);
  assert.match(readFileSync(join(ROOT, 'README.md'), 'utf8'), /当前版本：\*\*1\.2\.2\*\*/);
});

test('a missing DSH entry fails the delegation with a structured launch_failed handoff', async t => {
  const workspace = await tempDir(t, 'dsh-mcp-missing-');
  const responses = await rpc([
    {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: {
        name: 'deepseek_delegate',
        arguments: {
          task: 'probe lazy DSH resolution',
          context: '',
          acceptance: 'return a structured launch failure instead of crashing',
          execution: { workspace },
        },
      },
    },
  ], { DSH_CLI_PATH: join(workspace, 'missing-dsh-bin.js'), PATH: '' });
  const response = responses.find(message => message.id === 1);
  assert.equal(response.result.isError, true);
  const handoff = JSON.parse(response.result.content[0].text);
  const payload = handoff.handoff ?? handoff;
  assert.equal(payload.status, 'failed');
  assert.equal(payload.stop_reason, 'launch_failed');
  assert.match(payload.error, /Could not locate the configured DeepSeek Harness/);
});
