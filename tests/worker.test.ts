// Wire-level: a real A2A 1.0 client (ClientFactory, JSON-RPC over HTTP) against
// the real worker, which drives the real hostproto-mcp-playwright adapter over
// stdio and a real Chromium against a loopback fixture. Nothing is mocked.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Role, TaskState, type Message, type Task, type TaskStatusUpdateEvent, type TaskArtifactUpdateEvent } from '@a2a-js/sdk';
import { ClientFactory, type Client } from '@a2a-js/sdk/client';
import { createApp } from '../src/app.js';
import { HostProtoHost } from '../src/mcp.js';
import { EXTENSION_URI, dataPart, firstData } from '../src/a2a.js';
import { validator } from '../src/schemas.js';

const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));
let fixture: Server; let fixtureBase: string;
let worker: Server; let workerBase: string;
let client: Client; let host: Promise<HostProtoHost> | undefined;
let executor: ReturnType<typeof createApp>['executor'];

type Payload = { $case: 'task'; value: Task } | { $case: 'statusUpdate'; value: TaskStatusUpdateEvent } | { $case: 'artifactUpdate'; value: TaskArtifactUpdateEvent } | { $case: 'message'; value: Message };
const userMessage = (data: unknown, taskId = '', contextId = ''): Message => ({ messageId: randomUUID(), taskId, contextId, role: Role.ROLE_USER, parts: [dataPart(data)], metadata: undefined, extensions: [EXTENSION_URI], referenceTaskIds: [] });
const textMessage = (text: string): Message => ({ messageId: randomUUID(), taskId: '', contextId: '', role: Role.ROLE_USER, parts: [{ content: { $case: 'text', value: text }, metadata: undefined, filename: '', mediaType: 'text/plain' }], metadata: undefined, extensions: [], referenceTaskIds: [] });
async function stream(message: Message): Promise<Payload[]> {
  const out: Payload[] = [];
  for await (const r of client.sendMessageStream({ tenant: '', message, configuration: undefined, metadata: undefined }, declared)) if (r.payload) out.push(r.payload as Payload);
  return out;
}
const statuses = (events: Payload[]) => events.filter((e): e is Extract<Payload, { $case: 'statusUpdate' }> => e.$case === 'statusUpdate').map(e => e.value);
const lastState = (events: Payload[]) => statuses(events).at(-1)?.status?.state;
const order = (extra: Record<string, unknown> = {}) => ({ schema_version: 'hostproto.work-order/v1', skill: 'inspect_web_application', ...extra });
// A2A 1.0: a required extension must be declared by the client on each call (`A2A-Extensions`), or the server refuses.
const declared = { serviceParameters: { 'A2A-Extensions': EXTENSION_URI } };
const sha = (b: Buffer) => `sha256:${createHash('sha256').update(b).digest('hex')}`;

beforeAll(async () => {
  fixture = createHttpServer(async (req, res) => {
    const file = (req.url ?? '/').split('?')[0].replace(/^\//, '') || 'index.html';
    try { const body = await readFile(FIXTURES + file); res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(body); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(r => fixture.listen(0, '127.0.0.1', r));
  fixtureBase = `http://127.0.0.1:${(fixture.address() as { port: number }).port}/`;

  // Bind first, then build the app on the port the OS chose: the card's interface URL must be real.
  const probe = createHttpServer(); await new Promise<void>(r => probe.listen(0, '127.0.0.1', r));
  const port = (probe.address() as { port: number }).port; await new Promise<void>(r => probe.close(() => r()));
  workerBase = `http://127.0.0.1:${port}/`;
  const app = createApp(workerBase, () => (host ??= HostProtoHost.connect()));
  executor = app.executor;
  worker = app.app.listen(port, '127.0.0.1');
  await new Promise<void>(r => worker.once('listening', r));
  client = await new ClientFactory().createFromUrl(workerBase);
});
afterAll(async () => {
  await (await host)?.close();
  await new Promise<void>(r => worker?.close(() => r()));
  await new Promise<void>(r => fixture?.close(() => r()));
});

describe('agent card', () => {
  it('advertises one skill and a required hostproto profile extension pinned to the semantics commit', async () => {
    const card = await (await fetch(`${workerBase}.well-known/agent-card.json`)).json() as Record<string, any>;
    expect(card.skills.map((s: any) => s.id)).toEqual(['inspect_web_application']);
    const ext = card.capabilities.extensions.find((e: any) => e.uri === EXTENSION_URI);
    expect(ext.required).toBe(true);
    expect(ext.params.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(Object.keys(ext.params.bundles)).toContain('receipt');
    expect(card.supportedInterfaces[0]).toMatchObject({ protocolBinding: 'JSONRPC', protocolVersion: '1.0' });
  });
});

describe('a delegated inspection', () => {
  let taskId: string; let contextId: string; let final: Task;

  it('interrupts with INPUT_REQUIRED when the work order is valid but not executable', async () => {
    const events = await stream(userMessage(order({ max_pages: 2 })));
    expect(events[0].$case).toBe('task');
    taskId = (events[0] as any).value.id; contextId = (events[0] as any).value.contextId;
    expect((events[0] as any).value.metadata['hostproto.run_id']).toMatch(/^run-/);
    expect(lastState(events)).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    const request = firstData(statuses(events).at(-1)!.status!.message)!;
    expect(request.kind).toBe('work_order_incomplete');
    expect(request.missing).toEqual(['url']);
    expect(executor.runtime.forTask(taskId)!.state).toBe('awaiting_input');
  });

  it('resumes on the same task, makes many HostProto calls, and completes with artifacts', async () => {
    const events = await stream(userMessage({ url: `${fixtureBase}index.html` }, taskId, contextId));
    expect(events[0].$case).toBe('task');
    expect(lastState(events)).toBe(TaskState.TASK_STATE_COMPLETED);
    // progress statuses carry receipts verbatim
    const receipts = statuses(events).map(s => firstData(s.status?.message)).filter(d => d?.schema_version === 'hostproto.receipt/v1');
    expect(receipts.length).toBeGreaterThanOrEqual(2);
    for (const r of receipts) expect(validator('receipt')(r)).toBe(true);
    expect(receipts.map(r => r!.outcome)).toEqual(receipts.map(() => 'completed'));
    final = await client.getTask({ tenant: '', id: taskId });
    expect(final.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(final.artifacts.map(a => a.name).sort()).toEqual(['evidence-manifest', 'inspection']);
    expect(executor.runtime.forTask(taskId)!.state).toBe('completed');
    expect(executor.runtime.forTask(taskId)!.host).toBeNull();
  });

  it('the inspection artifact holds valid HostProto objects and visited more than one page by clicking a fresh target', () => {
    const report = firstData({ parts: final.artifacts.find(a => a.name === 'inspection')!.parts } as Message)!;
    expect(validator('handles')(report.handles)).toBe(true);
    for (const r of report.receipts as unknown[]) expect(validator('receipt')(r)).toBe(true);
    for (const o of report.observations as unknown[]) expect(validator('observation')(o)).toBe(true);
    const pages = report.pages as Array<Record<string, unknown>>;
    expect(pages.length).toBeGreaterThanOrEqual(2);
    expect(pages[0].url).toBe(`${fixtureBase}index.html`);
    expect(pages[0].console_records).toBe(1);
    expect((report.receipts as any[]).some(r => r.effects?.[0]?.kind === 'click')).toBe(true);
    // one click is one primitive inside one task: it is not a skill and not a task of its own
    expect(final.artifacts.length).toBe(2);
  });

  it('the evidence manifest is content-addressed and every ref resolves to the bytes it names', async () => {
    const manifest = final.artifacts.find(a => a.name === 'evidence-manifest')!;
    const index = firstData({ parts: manifest.parts } as Message)!;
    const entries = index.entries as Array<{ evidence: Record<string, unknown>; part: number; page: string }>;
    expect(entries.length).toBeGreaterThanOrEqual(2);
    for (const entry of entries) {
      expect(validator('evidence-ref')(entry.evidence)).toBe(true);
      const part = manifest.parts[entry.part];
      expect(part.content?.$case).toBe('raw');
      const bytes = Buffer.from((part.content as any).value as string | Buffer, 'base64');
      expect(sha(bytes)).toBe(entry.evidence.ref);
      expect(bytes.length).toBe(entry.evidence.size_bytes);
    }
  });

  it('lists the task through A2A, backed by the domain runtime', async () => {
    const listed = await client.listTasks({ tenant: '', contextId: '', status: TaskState.TASK_STATE_COMPLETED, pageToken: '' });
    expect(listed.tasks.map(t => t.id)).toContain(taskId);
    expect(executor.runtime.list().map(r => r.a2a.task_id)).toContain(taskId);
  });
});

describe('interruptions and terminal states', () => {
  it('a script dialog becomes INPUT_REQUIRED with the decision token; the decision resolves it', async () => {
    const first = await stream(userMessage(order({ url: `${fixtureBase}confirm.html`, max_pages: 1, projections: ['state', 'screenshot'] })));
    expect(lastState(first)).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    const request = firstData(statuses(first).at(-1)!.status!.message)!;
    expect(request.kind).toBe('decision_required');
    expect(typeof request.decision_token).toBe('string');
    const task = (first[0] as any).value as Task;
    const second = await stream(userMessage({ decision: 'accept' }, task.id, task.contextId));
    expect(lastState(second)).toBe(TaskState.TASK_STATE_COMPLETED);
    const resolve = statuses(second).map(s => firstData(s.status?.message)).find(d => d?.schema_version === 'hostproto.receipt/v1')!;
    expect((resolve.effects as any[])[0]).toMatchObject({ kind: 'dialog.decision', decision: 'accept' });
  });

  it('cancels while awaiting input: the run is canceled and the context released', async () => {
    const events = await stream(userMessage(order()));
    const task = (events[0] as any).value as Task;
    const canceled = await client.cancelTask({ tenant: '', id: task.id });
    expect(canceled.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
    expect(executor.runtime.forTask(task.id)!.state).toBe('canceled');
  });

  it('cancels mid-run at the next safe point', async () => {
    const gen = client.sendMessageStream({ tenant: '', message: userMessage(order({ url: `${fixtureBase}index.html`, max_pages: 10 })), configuration: undefined, metadata: undefined }, declared);
    const firstEvent = (await gen.next()).value!;
    const task = (firstEvent.payload as any).value as Task;
    // wait for the first receipt, then cancel
    for await (const r of gen) { const d = r.payload?.$case === 'statusUpdate' ? firstData(r.payload.value.status?.message) : undefined; if (d?.schema_version === 'hostproto.receipt/v1') break; }
    const canceled = await client.cancelTask({ tenant: '', id: task.id });
    expect(canceled.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
    const run = executor.runtime.forTask(task.id)!;
    expect(run.state).toBe('canceled'); expect(run.host).toBeNull();
    expect(run.journal.some(j => j.kind === 'cancel_requested')).toBe(true);
  });

  it('rejects a message without the profile DataPart: nothing was attempted', async () => {
    const events = await stream(textMessage('inspect example.org please'));
    expect(lastState(events)).toBe(TaskState.TASK_STATE_REJECTED);
    expect(firstData(statuses(events).at(-1)!.status!.message)!.kind).toBe('work_order_rejected');
  });

  it('fails with error/v1 verbatim when the host cannot perform the navigation', async () => {
    const events = await stream(userMessage(order({ url: 'http://127.0.0.1:9/' })));
    expect(lastState(events)).toBe(TaskState.TASK_STATE_FAILED);
    const error = firstData(statuses(events).at(-1)!.status!.message)!;
    expect(validator('error')(error)).toBe(true);
    expect(error.host_invoked).toBe(true);
  });
});
