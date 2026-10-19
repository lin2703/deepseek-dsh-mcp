import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, normalizeExecution } from './guard.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
// Derive the protected credential directory from the real home instead of
// embedding one machine's absolute path in a publishable test.
const PRIVATE_ROOT = join(homedir(), '.codex');

async function makeWorkspace(t) {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-path-scope-'));
  t.after(async () => { await rm(workspace, { recursive: true, force: true }); });
  return workspace;
}

function execution(workspace, read_roots) {
  return { workspace, read_roots };
}

function messageFrom(workspace, read_roots) {
  try {
    normalizeExecution(execution(workspace, read_roots));
  } catch (error) {
    return error.message;
  }
  assert.fail('expected normalizeExecution to reject the read roots');
}

test('missing, broad and protected read_roots have distinct reasons with original index and path', async t => {
  const workspace = await makeWorkspace(t);
  const granted = join(workspace, 'granted.txt');
  await writeFile(granted, 'granted\n');
  const missing = join(workspace, 'missing.txt');

  // A valid duplicate before the failure must not shift the reported index.
  const missingMessage = messageFrom(workspace, [granted, granted, missing]);
  assert.match(missingMessage, /execution\.read_roots\[2\]/);
  assert.ok(missingMessage.includes(missing));
  assert.match(missingMessage, /does not exist/);

  const broadMessage = messageFrom(workspace, [granted, '/tmp']);
  assert.match(broadMessage, /execution\.read_roots\[1\]/);
  assert.ok(broadMessage.includes('"/tmp"'));
  assert.match(broadMessage, /broad root/);

  const privateMessage = messageFrom(workspace, [granted, PRIVATE_ROOT]);
  assert.match(privateMessage, /execution\.read_roots\[1\]/);
  assert.ok(privateMessage.includes(PRIVATE_ROOT));
  assert.match(privateMessage, /protected path/);
  assert.doesNotMatch(privateMessage, /does not exist|broad root/);
  const reasons = [missingMessage, broadMessage, privateMessage];
  assert.equal(new Set(reasons).size, reasons.length, 'each rejection reason must be distinct');
});

test('a symlink is rejected through its canonical target path', async t => {
  const workspace = await makeWorkspace(t);
  const link = join(workspace, 'canonical-link');
  // The protected roots are not mounted in every test sandbox. Prefer the
  // protected target when it exists; otherwise the same canonicalization path
  // is exercised with the broad /tmp root.
  const target = existsSync(PRIVATE_ROOT) ? PRIVATE_ROOT : '/tmp';
  await symlink(target, link);
  const message = messageFrom(workspace, [link]);
  assert.match(message, /execution\.read_roots\[0\]/);
  assert.ok(message.includes(link), 'original input path must remain visible');
  assert.ok(message.includes(realpathSync(target)), 'canonical target must be diagnosable');
  assert.match(message, target === PRIVATE_ROOT ? /protected path/ : /broad root/);
  assert.doesNotMatch(message, /does not exist/);
});

test('relative, invalid and dangling read_roots locate the original array item', async t => {
  const workspace = await makeWorkspace(t);
  assert.throws(
    () => normalizeExecution(execution(workspace, ['relative/path.txt'])),
    error => /execution\.read_roots\[0\]/.test(error.message) && /relative\/path\.txt/.test(error.message) && /absolute path/.test(error.message),
  );
  assert.throws(
    () => normalizeExecution(execution(workspace, [42])),
    error => /execution\.read_roots\[0\]/.test(error.message) && /absolute path/.test(error.message),
  );
  const dangling = join(workspace, 'dangling.txt');
  await symlink('missing.txt', dangling);
  assert.throws(
    () => normalizeExecution(execution(workspace, [dangling])),
    error => /execution\.read_roots\[0\]/.test(error.message) && error.message.includes(dangling) && /dangling symlink/i.test(error.message),
  );
});

test('specific file and directory roots, the implicit workspace and duplicates stay accepted', async t => {
  const workspace = await makeWorkspace(t);
  const file = join(workspace, 'file.txt');
  const directory = join(workspace, 'subdir');
  await writeFile(file, 'x\n');
  await mkdir(directory);
  const contract = normalizeExecution(execution(workspace, [file, directory, file]));
  assert.equal(contract.read_roots[0], contract.workspace, 'workspace remains the implicit first root');
  assert.equal(contract.read_roots.length, 3, 'duplicate explicit roots are deduplicated');
  assert.ok(contract.read_roots.includes(canonical(file)));
  assert.ok(contract.read_roots.includes(canonical(directory)));

  // Workspace and write-path protection rules must remain unchanged.
  assert.throws(() => normalizeExecution({ workspace: '/' }), /specific existing project workspace/);
  assert.throws(() => normalizeExecution({ workspace, write_paths: [join(workspace, '.git')] }), /protected or sealed/);
  assert.throws(() => normalizeExecution({ workspace, write_paths: [join(ROOT, 'outside.txt')] }), /within the workspace/);
});

test('MCP stdio returns -32602 with the specific read_roots reason and exits cleanly', async t => {
  const workspace = await makeWorkspace(t);
  const missing = join(workspace, 'missing.txt');
  const proc = spawn(process.execPath, [join(ROOT, 'server.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => {
    if (proc.exitCode === null && proc.signalCode === null) {
      try { proc.kill('SIGKILL'); } catch { /* Already gone. */ }
    }
  });
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  let stdout = '';
  let stderr = '';
  proc.stderr.on('data', chunk => { stderr += chunk; });

  const response = await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => fail(new Error(`Timed out waiting for the MCP response; stderr: ${stderr}`)), 15000);
    const fail = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    proc.once('error', fail);
    proc.once('exit', code => fail(new Error(`MCP server exited before replying (code ${code}); stderr: ${stderr}`)));
    proc.stdout.on('data', chunk => {
      stdout += chunk;
      const lines = stdout.split('\n');
      stdout = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); }
        catch { fail(new Error(`Invalid JSON-RPC line: ${line}`)); return; }
        if (message.id === 1) {
          settled = true;
          clearTimeout(timer);
          resolve(message);
          return;
        }
      }
    });
    proc.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'deepseek_delegate',
        arguments: {
          task: 'diagnose path validation',
          context: '',
          acceptance: 'return a precise invalid-parameter error',
          execution: execution(workspace, [missing]),
        },
      },
    }) + '\n');
  });

  assert.equal(response.jsonrpc, '2.0');
  assert.equal(response.error?.code, -32602);
  assert.match(response.error.message, /execution\.read_roots\[0\]/);
  assert.ok(response.error.message.includes(missing));
  assert.match(response.error.message, /does not exist/);
  assert.equal(proc.exitCode, null, 'the invalid request must not start a delegation');

  proc.stdin.end();
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* Already gone. */ }
      reject(new Error('MCP server did not exit after stdin closed'));
    }, 15000);
    proc.once('exit', code => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  assert.equal(exitCode, 0);
});
