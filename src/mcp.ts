// The HostProto MCP adapter, used internally. One MCP client over stdio to
// hostproto-mcp-playwright, pinned to 2026-07-28. Every structured result is
// checked against the bundle it claims before the worker trusts it.
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { assertValid } from './schemas.js';

export const MCP_PROTOCOL_REVISION = '2026-07-28';

/** An `error/v1` returned by the adapter. Carried verbatim into A2A. */
export class HostError extends Error {
  constructor(public readonly object: Record<string, unknown>) { super(String(object.message ?? object.code)); }
}
/** The adapter process is gone: `recovery/v1 { unrecoverable, host_terminated }` territory. */
export class HostTerminated extends Error {}

export interface HostOptions { cwd?: string; command?: string; args?: string[] }

export class HostProtoHost {
  private closed = false;
  private constructor(private readonly client: Client, private readonly transport: StdioClientTransport) {}

  static async connect(options: HostOptions = {}): Promise<HostProtoHost> {
    const cwd = options.cwd ?? process.env.HOSTPROTO_MCP_DIR ?? fileURLToPath(new URL('../../hostproto-mcp-playwright/', import.meta.url));
    const transport = new StdioClientTransport({ command: options.command ?? 'npx', args: options.args ?? ['tsx', 'src/stdio.ts'], cwd, stderr: 'pipe' });
    const client = new Client({ name: 'hostproto-a2a-worker', version: '0.0.1' });
    client.setVersionNegotiation({ mode: { pin: MCP_PROTOCOL_REVISION } });
    await client.connect(transport);
    const host = new HostProtoHost(client, transport);
    transport.onclose = () => { host.closed = true; };
    return host;
  }
  get terminated(): boolean { return this.closed; }
  get serverName(): string | undefined { return this.client.getServerVersion()?.name; }

  /** Call a tool; `expect` names the bundle a success must satisfy. */
  async call<T extends Record<string, unknown> = Record<string, unknown>>(name: string, args: Record<string, unknown>, expect?: string): Promise<T> {
    if (this.closed) throw new HostTerminated('adapter transport is closed');
    let result;
    try { result = await this.client.callTool({ name, arguments: args }); }
    catch (error) { if (this.closed) throw new HostTerminated(String((error as Error).message)); throw error; }
    const sc = result.structuredContent as Record<string, unknown> | undefined;
    if (result.isError) {
      if (sc && sc.schema_version === 'hostproto.error/v1') { assertValid('error', sc); throw new HostError(sc); }
      throw new Error(`tool ${name} failed without error/v1: ${JSON.stringify(result.content)}`);
    }
    if (!sc) throw new Error(`tool ${name} returned no structuredContent`);
    if (expect) assertValid(expect, sc);
    return sc as T;
  }
  async readResource(uri: string): Promise<{ mediaType: string; bytes: Buffer }> {
    if (this.closed) throw new HostTerminated('adapter transport is closed');
    const { contents } = await this.client.readResource({ uri });
    const first = contents[0] as { mimeType?: string; blob?: string; text?: string };
    return { mediaType: first.mimeType ?? 'application/octet-stream', bytes: first.blob ? Buffer.from(first.blob, 'base64') : Buffer.from(first.text ?? '', 'utf8') };
  }
  async close(): Promise<void> { if (!this.closed) { this.closed = true; await this.client.close().catch(() => {}); } }
}
