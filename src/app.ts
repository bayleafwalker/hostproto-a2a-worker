// Express wiring: the card at its well-known path, JSON-RPC 1.0 transport
// against one DefaultRequestHandler, InMemoryTaskStore for A2A's projection
// (the domain runtime stays authoritative).
import express from 'express';
import { DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import { agentCard, JSONRPC_PATH } from './card.js';
import { HostWorkerExecutor } from './executor.js';
import type { HostProtoHost } from './mcp.js';

export function createApp(baseUrl: string, host: () => Promise<HostProtoHost>) {
  const executor = new HostWorkerExecutor(host);
  const handler = new DefaultRequestHandler(agentCard(baseUrl), new InMemoryTaskStore(), executor);
  const app = express();
  app.use('/.well-known/agent-card.json', agentCardHandler({ agentCardProvider: handler }));
  app.use(JSONRPC_PATH, jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));
  app.get('/healthz', (_req, res) => { res.json({ ok: true, runs: executor.runtime.list().map(r => ({ id: r.id, state: r.state, task: r.a2a.task_id })) }); });
  return { app, executor, handler };
}
