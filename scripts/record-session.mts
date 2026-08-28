// Record one real A2A-carried session as an NDJSON envelope log for an EvidenceSet consumer.
// Receipts arrive verbatim in status updates; observations and evidence refs in the inspection
// and evidence-manifest artifacts. Usage: npx tsx scripts/record-session.mts <out.ndjson>
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Role, type Message } from '@a2a-js/sdk';
import { ClientFactory } from '@a2a-js/sdk/client';
import { createApp } from '../src/app.js';
import { HostProtoHost } from '../src/mcp.js';
import { EXTENSION_URI, dataPart, firstData } from '../src/a2a.js';

const out = process.argv[2]; if (!out) throw new Error('usage: record-session <out.ndjson>');
const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));
const fixture = createServer(async (req, res) => {
  const file = (req.url ?? '/').split('?')[0].replace(/^\//, '') || 'index.html';
  try { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(await readFile(FIXTURES + file)); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise<void>(r => fixture.listen(0, '127.0.0.1', r));
const fixtureBase = `http://127.0.0.1:${(fixture.address() as any).port}/`;
const probe = createServer(); await new Promise<void>(r => probe.listen(0, '127.0.0.1', r));
const port = (probe.address() as any).port; await new Promise<void>(r => probe.close(() => r()));
const workerBase = `http://127.0.0.1:${port}/`;
let host: Promise<HostProtoHost> | undefined;
const app = createApp(workerBase, () => (host ??= HostProtoHost.connect()));
const worker = app.app.listen(port, '127.0.0.1'); await new Promise<void>(r => worker.once('listening', r));
const client = await new ClientFactory().createFromUrl(workerBase);
const declared = { serviceParameters: { 'A2A-Extensions': EXTENSION_URI } };

const lines: string[] = []; let seq = 0;
const emit = (tool: string, args: Record<string, unknown>, structured: unknown, is_error = false) =>
  lines.push(JSON.stringify({ seq: seq++, at: new Date().toISOString(), tool, args, is_error, structured }));

const message: Message = { messageId: randomUUID(), taskId: '', contextId: '', role: Role.ROLE_USER,
  parts: [dataPart({ schema_version: 'hostproto.work-order/v1', skill: 'inspect_web_application', url: `${fixtureBase}index.html` })],
  metadata: undefined, extensions: [EXTENSION_URI], referenceTaskIds: [] };
let taskId = ''; let contextId = ''; let pending: any = null;
const run = async (message: Message) => {
  for await (const r of client.sendMessageStream({ tenant: '', message, configuration: undefined, metadata: undefined }, declared)) {
    const p = r.payload as any; if (!p) continue;
    if (p.$case === 'task') { taskId = p.value.id; contextId = p.value.contextId; }
    if (p.$case === 'statusUpdate') {
      const d = firstData(p.value.status?.message);
      if (d?.schema_version === 'hostproto.receipt/v1') emit('a2a.statusUpdate', { action_id: d.action_id, surface: d.surface, state: p.value.status?.state }, d);
      else emit('a2a.statusUpdate', { state: p.value.status?.state, kind: d?.kind ?? null }, d ?? null);
      pending = d?.kind === 'decision_required' ? d : null;
    }
  }
};
await run(message);
// A script dialog on the second page is INPUT_REQUIRED with a decision token: the decision is carried by A2A, not asserted by the worker.
while (pending) {
  const token = pending.decision_token; pending = null;
  emit('a2a.decision', { taskId, decision_token: token, decision: 'dismiss' }, null);
  await run({ messageId: randomUUID(), taskId, contextId, role: Role.ROLE_USER, parts: [dataPart({ decision: 'dismiss' })], metadata: undefined, extensions: [EXTENSION_URI], referenceTaskIds: [] });
}
const final = await client.getTask({ tenant: '', id: taskId });
const report = firstData({ parts: final.artifacts.find(a => a.name === 'inspection')!.parts } as Message)!;
for (const o of report.observations as any[]) emit('a2a.artifact.inspection', { surface: o.surface, revision: o.revision }, o);
const manifest = firstData({ parts: final.artifacts.find(a => a.name === 'evidence-manifest')!.parts } as Message)!;
for (const e of manifest.entries as any[]) emit('a2a.artifact.evidence-manifest', { page: e.page }, e.evidence);
await (await host)?.close(); await new Promise<void>(r => worker.close(() => r())); fixture.close();
await writeFile(out, lines.join('\n') + '\n');
console.log(`${lines.length} records (task ${taskId}) -> ${out}`);
