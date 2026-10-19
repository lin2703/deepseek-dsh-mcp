// Locate the installed DeepSeek Harness CLI without requiring it at import time.
// Resolution is deliberately lazy: MCP initialize, tools/list and offline tests
// must work even on a machine where DSH is not installed yet.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DSH_PACKAGE = '@deepseek-ai/dsh';
export const DSH_BIN = 'lib/bin.js';
const SELF = dirname(fileURLToPath(import.meta.url));

function regularFile(path) {
  try { return statSync(path).isFile(); }
  catch { return false; }
}

function entry(path, source) {
  let real;
  try { real = realpathSync(path); }
  catch (error) { throw new Error(`DSH entry ${JSON.stringify(path)} cannot be resolved: ${error.message}`); }
  if (!regularFile(real)) throw new Error(`DSH entry ${JSON.stringify(path)} is not a regular file.`);
  return { path: real, source };
}

/** Resolve the bin entry relative to an installed @deepseek-ai/dsh package. */
function packageEntry(packageDir) {
  const manifest = join(packageDir, 'package.json');
  if (!regularFile(manifest)) return null;
  let pkg;
  try { pkg = JSON.parse(readFileSync(manifest, 'utf8')); }
  catch { return null; }
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.dsh;
  if (typeof bin !== 'string' || !bin) return null;
  const candidate = resolve(packageDir, bin);
  return regularFile(candidate) ? candidate : null;
}

/** Project-level module resolution: node_modules/@deepseek-ai/dsh from a start directory. */
function moduleEntry(start) {
  if (typeof start !== 'string' || !isAbsolute(start)) return null;
  try {
    const req = createRequire(join(start, '__dsh_mcp_resolve__.js'));
    // package.json gives the authoritative bin path; exports maps may forbid it,
    // in which case the documented headless entry is tried directly.
    try {
      const manifest = req.resolve(`${DSH_PACKAGE}/package.json`);
      const found = packageEntry(dirname(manifest));
      if (found) return found;
    } catch { /* Try the explicit entry below. */ }
    try {
      const direct = req.resolve(`${DSH_PACKAGE}/${DSH_BIN}`);
      if (regularFile(direct)) return direct;
    } catch { /* Not installed for this project. */ }
  } catch { /* Invalid start directory: treat as no project installation. */ }
  return null;
}

/**
 * PATH lookup through the real entry, so an npm bin symlink becomes the JS
 * file. Only absolute PATH entries are trusted: relative or empty entries would
 * let the task workspace (the current directory) choose the executable.
 */
function pathEntry(env) {
  const value = typeof env?.PATH === 'string' ? env.PATH : typeof env?.Path === 'string' ? env.Path : '';
  for (const directory of value.split(delimiter)) {
    if (!directory || !isAbsolute(directory)) continue;
    const candidate = join(directory, 'dsh');
    try {
      const real = realpathSync(candidate);
      if (regularFile(real)) return real;
    } catch { /* Not in this PATH entry. */ }
  }
  return null;
}

/** Common global-node_modules locations derived from the running node and home. */
function globalEntry() {
  const packageParts = DSH_PACKAGE.split('/');
  const candidates = [
    join(dirname(process.execPath), '..', 'lib', 'node_modules', ...packageParts),
    join(dirname(process.execPath), 'node_modules', ...packageParts),
    join(homedir(), '.local', 'lib', 'node_modules', ...packageParts),
  ];
  for (const packageDir of candidates) {
    const found = packageEntry(packageDir);
    if (found) return found;
  }
  return null;
}

/**
 * Locate the DSH CLI entry. Precedence:
 *   1. DSH_CLI_PATH (absolute file override; invalid values fail loudly)
 *   2. @deepseek-ai/dsh installed next to this adapter (never a task workspace
 *      or the implicit process cwd)
 *   3. the real `dsh` entry found on trusted, absolute PATH entries
 *   4. common global node_modules locations derived from node and home
 */
export function resolveDshCli({ env = process.env, adapterRoot = SELF } = {}) {
  const override = env?.DSH_CLI_PATH;
  if (override !== undefined && override !== '') {
    if (typeof override !== 'string' || !isAbsolute(override) || override.includes('\0')) {
      throw new Error('DSH_CLI_PATH must be an absolute path to the @deepseek-ai/dsh bin entry.');
    }
    return entry(override, 'DSH_CLI_PATH');
  }
  const found = moduleEntry(adapterRoot);
  if (found) return { path: found, source: 'module' };
  const fromPath = pathEntry(env);
  if (fromPath) return { path: fromPath, source: 'PATH' };
  const global = globalEntry();
  if (global) return { path: global, source: 'global' };
  throw new Error(`Could not locate ${DSH_PACKAGE}. Set DSH_CLI_PATH to the absolute path of ${DSH_BIN}, install the package next to this adapter (npm install ${DSH_PACKAGE}), or put dsh on an absolute PATH entry.`);
}

/**
 * Node 22.16 has no import.meta.main, so call the CLI's public runCli export
 * explicitly. console.info is redirected to stderr to keep stdout valid JSONL.
 */
export function dshLaunchScript(cliPath = resolveDshCli().path) {
  if (typeof cliPath !== 'string' || !isAbsolute(cliPath) || cliPath.includes('\0')) {
    throw new Error('The DSH CLI entry must be an absolute file path.');
  }
  const entryPath = resolve(cliPath);
  return `import {runCli} from ${JSON.stringify(pathToFileURL(entryPath).href)}; console.info = (...args) => console.error(...args); process.argv.splice(1, 0, ${JSON.stringify(entryPath)}); await runCli();`;
}

/** Configuration hint for MCP clients and error messages. */
export const DSH_DISCOVERY = Object.freeze({
  override: 'DSH_CLI_PATH',
  package: DSH_PACKAGE,
  entry: DSH_BIN,
  path_command: 'dsh',
});
