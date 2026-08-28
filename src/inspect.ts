// The one skill: inspect_web_application. A resumable run that makes many
// HostProto calls through the MCP adapter and hands back HostProto objects
// verbatim. Interruptions (a missing url, a script dialog waiting on a
// decision) surface as `input_required`; the caller maps them to A2A.
//
// Nothing here is an A2A type. The executor projects.
import { createHash } from 'node:crypto';
import type { DomainRuntime, Run } from './domain.js';
import { HostError, HostProtoHost, HostTerminated } from './mcp.js';
import { assertValid } from './schemas.js';

export interface WorkOrder { schema_version: 'hostproto.work-order/v1'; skill: 'inspect_web_application'; url?: string; max_pages: number; projections: string[] }
type J = Record<string, unknown>;

export interface PageReport { url: string; title: string | null; revision: number; receipt_id: string; console_records: number; targets: number; screenshot: J | null; lossy: boolean }
export interface EvidenceEntry { evidence: J; page: string; bytes: Buffer; mediaType: string }
export type Outcome =
  | { kind: 'completed'; report: J; evidence: EvidenceEntry[] }
  | { kind: 'input_required'; request: J }
  | { kind: 'canceled' }
  | { kind: 'failed'; reason: J };

export interface Progress { (kind: string, data: J): void }

const sha = (b: Buffer | string) => `sha256:${createHash('sha256').update(b).digest('hex')}`;

export class Inspection {
  private handles: J | null = null;
  private readonly receipts: J[] = [];
  private readonly observations: J[] = [];
  private readonly recoveries: J[] = [];
  private readonly pages: PageReport[] = [];
  private readonly evidence: EvidenceEntry[] = [];
  private readonly visited = new Set<string>();
  private readonly clicked = new Set<string>();
  private moved = false;
  private nextTarget: J | null = null;
  private pendingDialog: J | null = null;
  private actions = 0;

  constructor(readonly run: Run, readonly order: WorkOrder, private readonly runtime: DomainRuntime, private readonly host: HostProtoHost) {}

  private get surface(): string { return this.run.host!.surface; }
  private intent(kind: string, extra: J): J {
    this.actions += 1;
    const intent = { schema_version: 'hostproto.intent/v1', action_id: `${this.run.id}/a${String(this.actions).padStart(3, '0')}`, surface: this.surface, kind, ...extra };
    assertValid('intent', intent); return intent;
  }
  private async act(intent: J): Promise<J> {
    const receipt = await this.host.call('hostproto_surface_act', intent, 'receipt');
    this.receipts.push(receipt); this.runtime.journal(this.run, 'receipt', { receipt_id: receipt.receipt_id, outcome: receipt.outcome });
    return receipt;
  }
  private async observe(projections: string[]): Promise<J> {
    const observation = await this.host.call('hostproto_surface_observe', { surface: this.surface, projections }, 'observation');
    this.observations.push(observation); return observation;
  }
  private canceled(): boolean { return this.run.cancel_requested; }

  /** One turn. `answer` is the client's follow-up DataPart when resuming from input_required. */
  async turn(answer: J | undefined, progress: Progress): Promise<Outcome> {
    try { return await this.advance(answer, progress); }
    catch (error) {
      if (error instanceof HostTerminated) {
        const recovery = { schema_version: 'hostproto.recovery/v1', outcome: 'unrecoverable', cause: 'host_terminated', context: this.run.id, checkpoint: null, approval: null };
        assertValid('recovery', recovery); this.recoveries.push(recovery);
        this.run.host = null; return { kind: 'failed', reason: recovery };
      }
      if (error instanceof HostError) { await this.release(); return { kind: 'failed', reason: error.object }; }
      await this.release();
      const object = { schema_version: 'hostproto.error/v1', code: 'host_failed', message: String((error as Error).message ?? error).slice(0, 1024), host_invoked: true, data: { worker: true } };
      assertValid('error', object); return { kind: 'failed', reason: object };
    }
  }

  private async advance(answer: J | undefined, progress: Progress): Promise<Outcome> {
    if (!this.order.url) {
      const url = typeof answer?.url === 'string' && /^https?:\/\//.test(answer.url) ? answer.url : null;
      if (!url) return { kind: 'input_required', request: { kind: 'work_order_incomplete', missing: ['url'], work_order: this.order } };
      this.order.url = url;
    }
    if (this.canceled()) return this.cancel();
    if (!this.run.host) {
      const handles = await this.host.call('hostproto_context_create', { client: { id: this.run.id }, profile: { mode: 'ephemeral' }, viewport: { width: 1024, height: 768 } }, 'handles');
      const h = handles as { host: { id: string }; context: { id: string }; surface: { id: string } };
      this.run.host = { host: h.host.id, context: h.context.id, surface: h.surface.id }; this.handles = handles;
      this.runtime.journal(this.run, 'handles', this.run.host); progress('handles', handles);
    }
    if (this.pendingDialog) {
      const decision = answer?.decision;
      if (decision !== 'accept' && decision !== 'dismiss') return { kind: 'input_required', request: this.pendingDialog };
      const receipt = await this.act(this.intent('dialog.resolve', { decision_token: this.pendingDialog.decision_token, params: { decision, ...(typeof answer?.value === 'string' ? { value: answer.value } : {}) }, declared_effects: ['dialog.decision'] }));
      progress('receipt', receipt); this.pendingDialog = null;
    }
    while (this.pages.length < this.order.max_pages) {
      if (this.canceled()) return this.cancel();
      if (!this.moved) {
        const receipt = this.pages.length === 0
          ? await this.act(this.intent('navigate', { params: { url: this.order.url, deadline_ms: 20000 }, declared_effects: ['navigation'] }))
          : await this.click();
        if (!receipt) break;
        progress('receipt', receipt); this.moved = true;
      }
      if (this.canceled()) return this.cancel();
      const pending = await this.settle();
      if (pending) {
        this.pendingDialog = { kind: 'decision_required', decision_token: pending.token, dialog: pending, surface: this.surface };
        this.runtime.journal(this.run, 'decision_required', { token: pending.token });
        return { kind: 'input_required', request: this.pendingDialog };
      }
      this.moved = false;
      const observation = await this.observe(this.order.projections);
      const data = observation.data as J;
      const state = (data.state ?? ((await this.observe(['state'])).data as J).state) as { url: string; title?: string };
      if (this.visited.has(state.url)) { if (!(await this.pickNext(data))) break; continue; }
      this.visited.add(state.url);
      let screenshot: J | null = null;
      if (data.screenshot) {
        const shot = data.screenshot as J & { resource: string };
        const { resource, ...ref } = shot; assertValid('evidence-ref', ref);
        const { bytes, mediaType } = await this.host.readResource(resource);
        if (sha(bytes) !== ref.ref) throw new Error(`evidence ${resource} does not match its content address`);
        this.evidence.push({ evidence: ref, page: state.url, bytes, mediaType }); screenshot = ref;
      }
      const bounded = observation.bounded as { lossy: boolean };
      this.pages.push({ url: state.url, title: state.title ?? null, revision: observation.revision as number, receipt_id: String(this.receipts.at(-1)!.receipt_id), console_records: Array.isArray(data.console) ? data.console.length : 0, targets: Array.isArray(data.targets) ? data.targets.length : 0, screenshot, lossy: bounded.lossy });
      progress('page', this.pages.at(-1) as unknown as J);
      if (!(await this.pickNext(data))) break;
    }
    return this.complete();
  }

  /**
   * After an action: wait for the surface to go idle, but a script dialog can
   * open at any moment and blocks the engine, so look for one between short
   * host-side waits. Returns the pending dialog, or null once idle.
   * (The adapter's await is all-of; an any-of would make this one call.)
   */
  private async settle(): Promise<J | null> {
    const deadline = Date.now() + 15000;
    while (true) {
      const dialogs = (await this.observe(['dialogs'])).data as { dialogs: J[] };
      const pending = dialogs.dialogs.find(d => d.status === 'pending');
      if (pending) return pending;
      try { await this.host.call('hostproto_surface_await', { surface: this.surface, conditions: [{ kind: 'load_state', equals: 'idle' }], deadline_ms: 400 }); }
      catch (error) { if (!(error instanceof HostError && error.object.code === 'deadline_exceeded')) throw error; if (Date.now() < deadline) continue; }
      // idle — one last look, since the fixture-style "dialog shortly after load" is the common case
      const after = (await this.observe(['dialogs'])).data as { dialogs: J[] };
      return after.dialogs.find(d => d.status === 'pending') ?? null;
    }
  }

  private async pickNext(data: J): Promise<boolean> {
    const targets = Array.isArray(data.targets) ? data.targets as J[] : ((await this.observe(['targets'])).data as { targets: J[] }).targets;
    const candidate = targets.find(t => t.role === 'link' && (t.actions as string[]).includes('click') && !this.clicked.has(String(t.name)));
    this.nextTarget = candidate ?? null; return candidate !== undefined;
  }

  /** Click the chosen link. A target from an earlier revision is refused by the host before it is touched; that is a reobserve, once. */
  private async click(): Promise<J | null> {
    if (!this.nextTarget) return null;
    const target = this.nextTarget; this.clicked.add(String(target.name));
    try { return await this.act(this.intent('click', { target, declared_effects: ['navigation'] })); }
    catch (error) {
      if (!(error instanceof HostError && error.object.code === 'target_invalidated')) throw error;
      const recovery = { schema_version: 'hostproto.recovery/v1', outcome: 'reobserve_required', cause: 'stale_observation', context: this.run.id, checkpoint: null, approval: null };
      assertValid('recovery', recovery); this.recoveries.push(recovery); this.runtime.journal(this.run, 'recovery', recovery);
      const fresh = ((await this.observe(['targets'])).data as { targets: J[] }).targets.find(t => t.name === target.name && t.role === 'link');
      if (!fresh) return null;
      return await this.act(this.intent('click', { target: fresh, declared_effects: ['navigation'] }));
    }
  }

  private async release(): Promise<void> {
    if (this.run.host && !this.host.terminated) {
      await this.host.call('hostproto_context_close', { context: this.run.host.context }).catch(() => {});
    }
    this.run.host = null;
  }
  private async cancel(): Promise<Outcome> { await this.release(); return { kind: 'canceled' }; }
  private async complete(): Promise<Outcome> {
    await this.release();
    const report = {
      kind: 'inspection', skill: this.order.skill, work_order: this.order, run_id: this.run.id,
      handles: this.handles, pages: this.pages, receipts: this.receipts, recoveries: this.recoveries,
      observations: this.observations.map(o => ({ ...o, data: Object.fromEntries(Object.entries(o.data as J).filter(([k]) => k !== 'dom')) })),
    };
    return { kind: 'completed', report, evidence: this.evidence };
  }
  /** Abort from outside the turn (cancel while awaiting input). */
  async abort(): Promise<void> { await this.release(); }
}
