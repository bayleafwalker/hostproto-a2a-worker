// Small constructors for A2A 1.0 objects. Proto-derived types are verbose;
// these keep the projection code readable. No semantics here.
import { randomUUID } from 'node:crypto';
import { Role, TaskState, type Artifact, type Message, type Part, type Task, type TaskStatus } from '@a2a-js/sdk';

export const EXTENSION_URI = 'https://bayleafwalker.github.io/hostproto-a2a-worker/a2a/work-order/v1';
type J = Record<string, unknown>;

export const dataPart = (value: unknown, metadata?: J): Part => ({ content: { $case: 'data', value }, metadata, filename: '', mediaType: 'application/json' });
export const textPart = (value: string): Part => ({ content: { $case: 'text', value }, metadata: undefined, filename: '', mediaType: 'text/plain' });
export const rawPart = (bytes: Buffer, filename: string, mediaType: string, metadata?: J): Part => ({ content: { $case: 'raw', value: bytes }, metadata, filename, mediaType });

export function agentMessage(taskId: string, contextId: string, parts: Part[], metadata?: J): Message {
  return { messageId: randomUUID(), taskId, contextId, role: Role.ROLE_AGENT, parts, metadata, extensions: [EXTENSION_URI], referenceTaskIds: [] };
}
export function status(state: TaskState, message?: Message): TaskStatus { return { state, message, timestamp: new Date().toISOString() }; }
export function artifact(name: string, description: string, parts: Part[], metadata?: J): Artifact {
  return { artifactId: randomUUID(), name, description, parts, metadata, extensions: [EXTENSION_URI] };
}
/** The first DataPart of a message, or undefined. */
export function firstData(message: Message | undefined): J | undefined {
  for (const part of message?.parts ?? []) if (part.content?.$case === 'data' && part.content.value && typeof part.content.value === 'object') return part.content.value as J;
  return undefined;
}
export function newTask(id: string, contextId: string, userMessage: Message, metadata: J): Task {
  return { id, contextId, status: status(TaskState.TASK_STATE_SUBMITTED), artifacts: [], history: [userMessage], metadata };
}
