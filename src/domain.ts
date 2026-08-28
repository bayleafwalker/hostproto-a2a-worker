// The domain runtime: the authoritative lifecycle behind every A2A task.
// A2A tasks are projected *from* runs; runs are never derived from A2A
// state. This one is in-memory and single-process — the seam where ActionQ
// or another runtime plugs in is this interface, not the A2A executor.
//
// Correlation, never merger: a run carries the A2A task id and the
// HostProto handles it holds; the A2A task carries the run id in metadata.
import { randomUUID } from 'node:crypto';

export type RunState = 'created' | 'running' | 'awaiting_input' | 'completed' | 'failed' | 'canceled';
export const TERMINAL: ReadonlySet<RunState> = new Set(['completed', 'failed', 'canceled']);
const ALLOWED: Record<RunState, RunState[]> = {
  created: ['running', 'canceled', 'failed'],
  running: ['awaiting_input', 'completed', 'failed', 'canceled'],
  awaiting_input: ['running', 'canceled', 'failed'],
  completed: [], failed: [], canceled: [],
};

export interface JournalEntry { seq: number; at: string; kind: string; data?: unknown }
export interface Run {
  id: string;
  a2a: { task_id: string; context_id: string };
  state: RunState;
  cancel_requested: boolean;
  claims: number;
  created_at: string;
  updated_at: string;
  /** HostProto handles held by this run; cleared on release. */
  host: { host: string; context: string; surface: string } | null;
  journal: JournalEntry[];
}

export class IllegalTransition extends Error {
  constructor(run: Run, to: RunState) { super(`run ${run.id}: ${run.state} -> ${to} is not allowed`); }
}

export class DomainRuntime {
  private readonly runs = new Map<string, Run>();
  private readonly byTask = new Map<string, string>();

  create(taskId: string, contextId: string): Run {
    if (this.byTask.has(taskId)) throw new Error(`task ${taskId} already has a run`);
    const now = new Date().toISOString();
    const run: Run = { id: `run-${randomUUID()}`, a2a: { task_id: taskId, context_id: contextId }, state: 'created', cancel_requested: false, claims: 0, created_at: now, updated_at: now, host: null, journal: [] };
    this.runs.set(run.id, run); this.byTask.set(taskId, run.id);
    this.journal(run, 'created');
    return run;
  }
  get(runId: string): Run | undefined { return this.runs.get(runId); }
  forTask(taskId: string): Run | undefined { const id = this.byTask.get(taskId); return id ? this.runs.get(id) : undefined; }
  list(): Run[] { return [...this.runs.values()]; }

  /** Claim the run for one execution turn. A second concurrent claim is an error, not a retry. */
  claim(run: Run): void {
    if (run.state === 'running') throw new Error(`run ${run.id} is already claimed`);
    this.transition(run, 'running'); run.claims += 1; this.journal(run, 'claimed', { claims: run.claims });
  }
  transition(run: Run, to: RunState): void {
    if (!ALLOWED[run.state].includes(to)) throw new IllegalTransition(run, to);
    run.state = to; run.updated_at = new Date().toISOString(); this.journal(run, `state:${to}`);
  }
  /** Cancellation is a request; the executing turn observes it at its next safe point. */
  requestCancel(run: Run): boolean {
    if (TERMINAL.has(run.state)) return false;
    run.cancel_requested = true; this.journal(run, 'cancel_requested'); return true;
  }
  journal(run: Run, kind: string, data?: unknown): void {
    run.journal.push({ seq: run.journal.length + 1, at: new Date().toISOString(), kind, data });
  }
}
