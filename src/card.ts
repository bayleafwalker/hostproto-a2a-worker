// One Agent Card, one skill. The HostProto profile extension is required:
// its params pin the semantics commit and bundle digests so a client can
// verify every HostProto object it receives against the same schemas.
import type { AgentCard } from '@a2a-js/sdk';
import { EXTENSION_URI } from './a2a.js';
import { pinned } from './schemas.js';
import { PROFILE } from './executor.js';

export const VERSION = '0.0.1';
export const JSONRPC_PATH = '/a2a/jsonrpc';

export function agentCard(baseUrl: string): AgentCard {
  return {
    name: 'hostproto-a2a-worker',
    description: 'Performs delegated inspections of a web application through a HostProto browser/v1 host. Returns receipts, observations and content-addressed evidence, never free-form claims.',
    supportedInterfaces: [{ url: new URL(JSONRPC_PATH, baseUrl).href, protocolBinding: 'JSONRPC', tenant: '', protocolVersion: '1.0' }],
    provider: { organization: 'bayleafwalker', url: 'https://github.com/bayleafwalker/hostproto-a2a-worker' },
    version: VERSION,
    documentationUrl: 'https://github.com/bayleafwalker/hostproto-semantics',
    capabilities: {
      streaming: true, pushNotifications: false, extendedAgentCard: false,
      extensions: [{
        uri: EXTENSION_URI, required: true,
        description: 'Messages to this agent carry one DataPart satisfying hostproto-work-order/v1. Status messages and artifacts carry hostproto-semantics objects verbatim (receipt/v1, observation/v1, evidence-ref/v1, error/v1, recovery/v1), validated against the pinned bundles.',
        params: { semantics: pinned.repository, commit: pinned.commit, bundles: pinned.sha256, profiles: [PROFILE], work_order_contract: 'contracts/work-order.schema.json' },
      }],
    },
    securitySchemes: {}, securityRequirements: [],
    defaultInputModes: ['application/json'], defaultOutputModes: ['application/json', 'image/png'],
    skills: [{
      id: 'inspect_web_application', name: 'Inspect a web application',
      description: 'Open the given URL in an ephemeral browser context, observe it, follow up to max_pages links, and return a page report with HostProto receipts and observations plus an evidence manifest of screenshots. Script dialogs and a missing url interrupt the task with INPUT_REQUIRED.',
      tags: ['hostproto', 'browser', 'inspection', 'evidence'],
      examples: ['{"schema_version":"hostproto.work-order/v1","skill":"inspect_web_application","url":"https://example.org/","max_pages":3}'],
      inputModes: ['application/json'], outputModes: ['application/json', 'image/png'], securityRequirements: [],
    }],
    signatures: [],
  };
}
