# Decisions

## ADR-0001: the domain runtime lives here, in memory, behind one interface

The plan names "ActionQ or equivalent" as the owner of the run lifecycle.
Step 4 needs a real owner to project from, so `src/domain.ts` is a minimal
one: created → running → awaiting_input → terminal, claims counted, cancel
as a request, a journal. It is single-process and forgets on restart. That is
acceptable for a reference worker and is *not* HostProto acquiring a task
store (kill gate 3): nothing in hostproto-semantics references it.

## ADR-0002: A2A 1.0 wire facts learned from `@a2a-js/sdk` 1.1.0

1. **Required extensions are enforced.** A card extension with
   `required: true` makes the server reject any call that does not carry
   the URI in `A2A-Extensions` (`ExtensionSupportRequiredError`). The client
   passes it as `RequestOptions.serviceParameters`. The profile is therefore
   a real contract, not documentation.
2. `agentCardHandler` is a router rooted at `/`; mount it with
   `app.use('/.well-known/agent-card.json', …)`, not `app.get`.
3. `TaskStatusUpdateEvent.metadata` is **not** merged into `Task.metadata`
   by the store; task metadata is what the last `task` event carried. Live
   run state is read from the runtime, not from the projection.
4. On a follow-up turn (`INPUT_REQUIRED` → new message with the task id)
   the executor must publish a `task` event first; the SDK rejects a stream
   opening with a status update.
5. `DefaultRequestHandler.cancelTask` calls the executor's `cancelTask` and
   then drains the bus until a terminal event. A cancel while a turn is
   executing is therefore settled by the turn itself at its next safe point;
   a cancel while awaiting input is settled inside `cancelTask`.
6. `ListTasks` filters by `status` and `contextId`; unset filters are the
   zero values (`TASK_STATE_UNSPECIFIED`, `''`).

## ADR-0003: a dialog is an interruption of the assignment

The adapter holds a script dialog open behind a `decision_token`
(`dialog.resolve` intent). At the assignment level that is `INPUT_REQUIRED`
carrying the token and the dialog record; the client's follow-up DataPart
`{decision: accept|dismiss, value?}` becomes the intent. Same shape both
levels, as the responsibility split predicts.

Consequence discovered on the way: a dialog can open at any moment after an
action, and while one is pending the engine blocks evaluation. The worker
therefore settles a page by alternating `observe(dialogs)` with short
host-side `await load_state=idle` calls. The adapter's `await` is all-of; an
any-of (`load_state idle` **or** `event_kind dialog.opened`) would make that
one call. Noted for the adapter; no HostProto change.

## ADR-0004: the worker found an adapter defect, not a semantic one

`dialog.resolve` in hostproto-mcp-playwright computed the default decision
with wrong precedence, turning an explicit `accept` into `dismiss`. Found
because the worker's test accepts where the adapter's own test only
dismissed. Fixed in the adapter with a regression test. The receipt carried
`effects[0].decision`, so the defect was visible on the wire — which is the
receipt design working.
