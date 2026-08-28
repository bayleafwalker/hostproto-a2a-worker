import { createApp } from './app.js';
import { HostProtoHost } from './mcp.js';

const port = Number(process.env.PORT ?? 4310);
const baseUrl = process.env.BASE_URL ?? `http://127.0.0.1:${port}/`;
let host: Promise<HostProtoHost> | undefined;
const { app } = createApp(baseUrl, () => (host ??= HostProtoHost.connect()));
app.listen(port, () => { console.error(`hostproto-a2a-worker: card at ${baseUrl}.well-known/agent-card.json`); });
