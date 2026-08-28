# Agent guidance

- Never copy a schema in. Change `hostproto-semantics.lock.json` and run `npm run schemas`. The only schema this repo owns is `contracts/work-order.schema.json` — the skill's input, not a HostProto semantic.
- Never hand-write a TypeScript interface for a HostProto type; validate with `assertValid` against the bundle. Objects from the adapter are re-validated on receipt and passed through verbatim.
- One skill. A new primitive (a click, a step, a dialog decision) is never a new skill and never a new task — that is kill gate 4/5.
- The domain runtime (`src/domain.ts`) is authoritative. The A2A task is a projection: `src/executor.ts` maps run outcomes to A2A states and never decides host matters. `src/inspect.ts` holds the workflow and knows nothing about A2A.
- Tests are wire-level (`tests/worker.test.ts`): real A2A client, real worker, real adapter over stdio, real Chromium. Keep them that way.
- Record every wire fact learned about A2A 1.0 or the SDK in `docs/DECISIONS.md` with the SDK version.
