import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeExecution, toolsFor } from './guard.mjs';
import { buildHandoff } from './server.mjs';

async function setup(t) {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-owner-check-'));
  t.after(() => rm(workspace, {recursive:true,force:true}));
  await writeFile(join(workspace,'input.txt'),'normal task input');
  return normalizeExecution({workspace,commands:['node --check check.mjs'],max_steps:4,timeout_seconds:30});
}
function pair(tool,id,input,status='completed',result='OK',extra={}) {
  return [{type:'tool_call',tool,callId:id,input},
    {type:'tool_result',tool,callId:id,status,result,...extra}];
}
function finish(c,events) {
  const stdout=[...events,{type:'status',phase:'turn_end',reason:{kind:'completed'}},{type:'final',text:'Done; checks passed.'}].map(JSON.stringify).join('\n');
  const stderr='DSH_MCP_BOUNDARY '+JSON.stringify({agents:1,requests:1,allowed_tools:toolsFor(c)});
  return buildHandoff(c,{code:0,stdout,stderr});
}
const outside="Error: Command is outside Astra's execution contract. Commands are matched as exact strings; shell composition (&&, ;, |, substitutions) is not authorized.";
const check=c=>pair('bash','check',{command:c.commands[0]},'completed','OK',{exit_code:0});

test('a rejected escalation is not erased by a later ordinary success of the same command',async t=>{
  const c=await setup(t);
  const h=finish(c,[...pair('bash','escalation',{command:c.commands[0],sandbox_permissions:'require_escalated'},'error','Error: Escalation and background jobs are disabled; report the blocker instead of retrying.'),...check(c)]);
  assert.notEqual(h.status,'completed');
  assert.equal(h.unresolved_failures[0]?.call_id,'escalation');
});

test('a denied ls with a foreign workdir is not described as recovered workspace exploration',async t=>{
  const c=await setup(t);
  const h=finish(c,[...pair('bash','ls',{command:'ls -la',workdir:'/etc'},'error',outside),...pair('read','alternative',{file_path:join(c.workspace,'input.txt')}),...check(c)]);
  assert.equal(h.warnings.length,0);
  assert.notEqual(h.status,'completed');
});

test('an alternative read that violates the guard cannot justify a recovery warning',async t=>{
  const c=await setup(t);
  const h=finish(c,[...pair('bash','ls',{command:'ls -la'},'error',outside),...pair('read','alternative',{file_path:join(c.workspace,'input.txt'),sandbox_permissions:'require_escalated'}),...check(c)]);
  assert.equal(h.warnings.length,0);
  assert.notEqual(h.status,'completed');
});

test('a successful authorized default-workspace glob supplies replacement evidence',async t=>{
  const c=await setup(t);
  const h=finish(c,[...pair('bash','ls',{command:'ls -la'},'error',outside),...pair('glob','alternative',{pattern:'*.txt'}),...check(c)]);
  assert.equal(h.status,'completed');
  assert.equal(h.warnings.length,1);
  assert.equal(h.warnings[0].alternative_call_id,'alternative');
});
