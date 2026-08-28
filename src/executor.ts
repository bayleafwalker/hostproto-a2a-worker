// The A2A executor: projection of a domain run onto an A2A task. It parses
// the work order, owns the run ↔ task correlation, maps skill outcomes to
// A2A states, and emits HostProto objects verbatim as parts. It never makes
// a host decision itself.
import { TaskState, type Task } from '@a2a-js/sdk';
import type { AgentExecutor, ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server';
import { DomainRuntime, TERMINAL, type Run } from './domain.js';
import { Inspection, type WorkOrder } from './inspect.js';
import type { HostProtoHost } from './mcp.js';
import { errorsOf, pinned } from './schemas.js';
import { agentMessage, artifact, dataPart, firstData, newTask, rawPart, status, textPart } from './a2a.js';

type J = Record<string, unknown>;
export const PROFILE = 'browser/v1';

export class HostWorkerExecutor implements AgentExecutor {
  readonly runtime = new DomainRuntime();
  private readonly inspections = new Map<string, Inspection>();

  constructor(private readonly host: () => Promise<HostProtoHost>) {}

  private metadata(run: Run): J {
    return { 'hostproto.run_id': run.id, 'hostproto.run_state': run.state, 'hostproto.profile': PROFILE, 'hostproto.semantics_commit': pinned.commit, ...(run.host ? { 'hostproto.context': run.host.context, 'hostproto.surface': run.host.surface } : {}) };
  }

  async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId } = ctx;
    const publishStatus = (state: TaskState, parts: Parameters<typeof agentMessage>[2] | null, run?: Run) => {
      bus.publish({ kind: 'statusUpdate', data: { taskId, contextId, status: status(state, parts ? agentMessage(taskId, contextId, parts) : undefined), metadata: run ? this.metadata(run) : undefined } });
    };

    let inspection = this.inspections.get(taskId);
    let answer: J | undefined;
    if (!inspection) {
      const order = firstData(ctx.userMessage);
      const problem = !order ? 'no DataPart: the hostproto-work-order/v1 profile is required' : errorsOf('contract:work-order', order);
      if (problem) {
        // A malformed assignment is rejected, not failed: nothing was attempted.
        bus.publish({ kind: 'task', data: newTask(taskId, contextId, ctx.userMessage, { 'hostproto.profile': PROFILE }) });
        publishStatus(TaskState.TASK_STATE_REJECTED, [dataPart({ kind: 'work_order_rejected', reason: problem, contract: 'contracts/work-order.schema.json' })]);
        return;
      }
      const run = this.runtime.create(taskId, contextId);
      inspection = new Inspection(run, order as unknown as WorkOrder, this.runtime, await this.host());
      this.inspections.set(taskId, inspection);
      bus.publish({ kind: 'task', data: newTask(taskId, contextId, ctx.userMessage, this.metadata(run)) });
    } else {
      // Follow-up turn on an interrupted task: the run resumes, the task is re-stated first.
      const task = ctx.task as Task;
      bus.publish({ kind: 'task', data: { ...task, status: status(TaskState.TASK_STATE_WORKING), history: [...task.history, ctx.userMessage], metadata: this.metadata(inspection.run) } });
      answer = firstData(ctx.userMessage);
    }
    const run = inspection.run;
    if (TERMINAL.has(run.state)) { publishStatus(run.state === 'canceled' ? TaskState.TASK_STATE_CANCELED : TaskState.TASK_STATE_FAILED, [textPart(`run is ${run.state}`)], run); return; }
    this.runtime.claim(run);
    publishStatus(TaskState.TASK_STATE_WORKING, null, run);

    const outcome = await inspection.turn(answer, (kind, data) => {
      // Progress is a non-terminal status carrying the HostProto object that just happened.
      if (kind === 'receipt' || kind === 'handles') publishStatus(TaskState.TASK_STATE_WORKING, [dataPart(data, { hostproto: kind })], run);
    });

    switch (outcome.kind) {
      case 'input_required':
        this.runtime.transition(run, 'awaiting_input');
        publishStatus(TaskState.TASK_STATE_INPUT_REQUIRED, [dataPart(outcome.request, { hostproto: 'interruption' })], run);
        return;
      case 'canceled':
        this.runtime.transition(run, 'canceled'); this.inspections.delete(taskId);
        publishStatus(TaskState.TASK_STATE_CANCELED, [textPart('canceled at a safe point; the browser context was released')], run);
        return;
      case 'failed': {
        this.runtime.transition(run, 'failed'); this.inspections.delete(taskId);
        const sv = String(outcome.reason.schema_version);
        publishStatus(TaskState.TASK_STATE_FAILED, [dataPart(outcome.reason, { hostproto: sv.includes('recovery') ? 'recovery' : 'error' })], run);
        return;
      }
      case 'completed': {
        const manifestParts = [dataPart({ kind: 'evidence-manifest', run_id: run.id, entries: outcome.evidence.map((e, i) => ({ evidence: e.evidence, page: e.page, part: i + 1 })) }, { hostproto: 'evidence-manifest' }),
          ...outcome.evidence.map((e, i) => rawPart(e.bytes, `evidence-${String(i + 1).padStart(3, '0')}.${e.mediaType === 'image/png' ? 'png' : 'bin'}`, e.mediaType, { evidence_ref: e.evidence.ref }))];
        bus.publish({ kind: 'artifactUpdate', data: { taskId, contextId, artifact: artifact('evidence-manifest', 'hostproto.evidence-ref/v1 entries; each raw part is the content the ref addresses', manifestParts, { 'hostproto.run_id': run.id }), append: false, lastChunk: true, metadata: undefined } });
        bus.publish({ kind: 'artifactUpdate', data: { taskId, contextId, artifact: artifact('inspection', 'pages visited; hostproto receipt/v1, observation/v1, recovery/v1 verbatim', [dataPart(outcome.report, { hostproto: 'inspection' })], { 'hostproto.run_id': run.id }), append: false, lastChunk: true, metadata: undefined } });
        this.runtime.transition(run, 'completed'); this.inspections.delete(taskId);
        publishStatus(TaskState.TASK_STATE_COMPLETED, [textPart(`inspected ${(outcome.report.pages as unknown[]).length} page(s)`)], run);
        return;
      }
    }
  }

  async cancelTask(taskId: string, bus: ExecutionEventBus): Promise<void> {
    const run = this.runtime.forTask(taskId);
    const inspection = this.inspections.get(taskId);
    if (!run || !inspection) return;
    if (!this.runtime.requestCancel(run)) return;
    if (run.state === 'awaiting_input' || run.state === 'created') {
      // No turn is executing; settle it here.
      await inspection.abort();
      this.runtime.transition(run, 'canceled'); this.inspections.delete(taskId);
      bus.publish({ kind: 'statusUpdate', data: { taskId, contextId: run.a2a.context_id, status: status(TaskState.TASK_STATE_CANCELED, agentMessage(taskId, run.a2a.context_id, [textPart('canceled while awaiting input')])), metadata: this.metadata(run) } });
    }
    // Otherwise the executing turn observes the request at its next safe point and publishes CANCELED itself.
  }
}
