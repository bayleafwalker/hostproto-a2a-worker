# hostproto-a2a-worker

The HostProto A2A host-worker (hostproto-semantics plan, step 4): **one Agent
Card, one skill**, A2A tasks projected from domain runs, the HostProto MCP
adapter used internally, evidence as A2A artifacts. Protocol **A2A 1.0**
(`@a2a-js/sdk` 1.1.0, JSON-RPC binding); host semantics come from
[hostproto-semantics](https://github.com/bayleafwalker/hostproto-semantics),
pinned by digest; the browser comes from
[hostproto-mcp-playwright](https://github.com/bayleafwalker/hostproto-mcp-playwright)
over MCP 2026-07-28.

## What it does

| A2A | HostProto / domain |
| --- | --- |
| Agent Card, extension `hostproto-work-order/v1` (`required: true`, params pin the semantics commit and every bundle digest) | the profile: messages carry one DataPart per `contracts/work-order.schema.json`; replies carry HostProto objects verbatim |
| skill `inspect_web_application` | one delegated assignment = one domain run = many MCP calls (`context_create`, `act`, `await`, `observe`, `context_close`) |
| `Task` (`metadata['hostproto.run_id']`) | `Run` in the domain runtime — the authoritative lifecycle; the task is its projection, never the reverse |
| `WORKING` status updates | each `receipt/v1` and the `handles/v1`, as they happen |
| `INPUT_REQUIRED` | a work order that validates but has no `url`; a script dialog holding a `decision_token` — the same shape as the adapter's `dialog.resolve` |
| `CANCELED` | `cancel_requested` on the run, honoured at the next safe point; the browser context is released |
| `REJECTED` | no DataPart or a work order that fails the contract — nothing attempted |
| `FAILED` | the adapter's `error/v1` verbatim (`host_invoked` honest), or `recovery/v1 {unrecoverable, host_terminated}` when the adapter process is gone |
| artifact `inspection` | pages visited; `handles/v1`, every `receipt/v1`, `observation/v1` (dom stripped), `recovery/v1` |
| artifact `evidence-manifest` | `evidence-ref/v1` entries; each raw part is the bytes the ref content-addresses |
| `ListTasks`, `GetTask`, `CancelTask`, `SubscribeToTask` | A2A's, backed by the run |

A stale target (`target_invalidated`, refused before the engine is touched)
is recorded as `recovery/v1 {reobserve_required, stale_observation}` and the
worker re-observes once. That is HostProto doing its job, not an escape hatch.

## Kill gates, checked here

- Gate 4: a click or a dialog decision is a primitive inside one task. The card has one skill.
- Gate 5: one task makes many MCP calls; no MCP call is wrapped in a task of its own.
- Gate 3: the run store is the worker's domain runtime, not HostProto's. `src/domain.ts` is the seam for ActionQ.

## Run

```sh
npm ci
npm run schemas                        # pinned bundles, digest-verified
# sibling checkout of hostproto-mcp-playwright with its own `npm ci`, chromium and schemas
HOSTPROTO_MCP_DIR=../hostproto-mcp-playwright npm test
PORT=4310 npm start                    # card at http://127.0.0.1:4310/.well-known/agent-card.json
```

Clients must declare the extension on each call (`A2A-Extensions:
https://hostproto.invalid/a2a/work-order/v1`); the server refuses otherwise.
