# Plan: GitHub Copilot Provider Integration

## TL;DR
Add `"copilot"` as a second provider kind alongside Codex. GitHub Copilot CLI exposes an ACP (Agent Client Protocol) server via `copilot --acp --stdio` — NDJSON over stdio, the same transport pattern as `codex app-server`. This means the adapter architecture mirrors `CodexAppServerManager` almost exactly: spawn subprocess, wrap with `@agentclientprotocol/sdk`, map ACP events to canonical `ProviderRuntimeEvent`s. The agentic loop (tool execution, approval flows, conversation state) is handled by the `copilot` binary itself. Auth is assumed to be managed externally by the user's installed `gh` / Copilot CLI state. Target: full agentic coding parity with Codex.

---

## Phase 1: Contracts — Schemas & Types
*Unblocks all other work. No dependencies.*

1. In `packages/contracts/src/orchestration.ts`: change `ProviderKind = Schema.Literal("codex")` → `Schema.Literals(["codex", "copilot"])`. Update `DEFAULT_PROVIDER_KIND` to remain `"codex"`. Confirm all `satisfies Record<ProviderKind, ...>` tables in model.ts still compile.

2. In `packages/contracts/src/model.ts`:
   - Add `CopilotModelOptions` schema (`Schema.Struct({})` — no extra options for phase 1)
   - Add `copilot` entry to `ProviderModelOptions.codex/copilot`
   - Add Copilot model list to `MODEL_OPTIONS_BY_PROVIDER`: `gpt-4o`, `claude-3.5-sonnet`, `o3-mini`
   - Add `DEFAULT_MODEL_BY_PROVIDER.copilot = "gpt-4o"`
   - Add empty `MODEL_SLUG_ALIASES_BY_PROVIDER.copilot = {}`
   - Add `REASONING_EFFORT_OPTIONS_BY_PROVIDER.copilot = []` and `DEFAULT_REASONING_EFFORT_BY_PROVIDER.copilot = null`

3. In `packages/contracts/src/ws.ts`: add new WS method constants under `WS_METHODS`:
   - `"copilot.auth.initiateDeviceFlow"` → retained compatibility method; the server currently responds with a typed unsupported error because T3 Code does not own sign-in
   - `"copilot.auth.getStatus"` → returns `{ authenticated: boolean, login?: string }`
   - `"copilot.auth.signOut"` → retained compatibility method; the server currently responds with a typed unsupported error because sign-out is managed externally

---

## Phase 2: Auth Infrastructure — CLI-Owned Auth State
*Depends on Phase 1. Can be developed in parallel with Phase 3.*

4. Create `apps/server/src/copilotAuthManager.ts` (Effect service):
   - `initiateDeviceFlow()`: returns a typed unsupported error explaining that T3 Code does not own GitHub/Copilot sign-in
   - `pollForAccessToken(deviceCode, interval)`: returns a typed unsupported error for the same reason
   - `getAccessToken()`: shells out to `gh auth token`; returns `null` when the CLI is unauthenticated
   - `getStatus()`: returns `{ authenticated, login }` from `gh auth status`
   - `signOut()`: returns a typed unsupported error directing the user to `gh auth logout` / Copilot CLI auth management
   - `getCopilotToken()`: exchanges the existing GitHub CLI access token for a short-lived Copilot API token via `GET https://api.github.com/copilot_internal/v2/token` (auto-refresh when expired — tokens last ~5 min); cache in memory

5. Add WS handlers for the three auth methods in `apps/server/src/wsServer.ts`, routing to `CopilotAuthManager`.

---

## Phase 3: ACP Session Manager
*Depends on Phase 1 only. No dependency on Phase 2 — auth is handled by the `copilot` CLI binary itself.*

6. Add `@agentclientprotocol/sdk` as a dependency to `apps/server/package.json`.

7. Create `apps/server/src/copilotAcpManager.ts` (mirrors `CodexAppServerManager`):
   - Plain `EventEmitter` class owning one `copilot --acp --stdio` process per session
   - Spawn: `child_process.spawn("copilot", ["--acp", "--stdio"], { stdio: ["pipe", "pipe", "pipe"], cwd })`
   - Wrap stdin/stdout with `acp.ndJsonStream()` from `@agentclientprotocol/sdk`
   - Create `acp.ClientSideConnection` with a client impl that bridges ACP callbacks to EventEmitter events:
     - `client.sessionUpdate({ update })` → emit canonical `ProviderEvent` based on `update.sessionUpdate` kind:
       - `"agent_message_chunk"` + content type `"text"` → `content.delta`
       - `"agent_message_chunk"` + content type `"tool_call"` → `item.started` / `item.updated`
       - session lifecycle updates → `session.state.changed`
     - `client.requestPermission(params)` → emit `request.opened`; return a Promise that resolves when the user calls `respondToRequest()` (same pending-approvals Map pattern as Codex)
   - ACP lifecycle methods exposed:
     - `startSession(input)`: `connection.initialize(...)` → `connection.newSession({ cwd, mcpServers: [] })` → store `sessionId` as `resumeCursor`
     - `sendTurn(input)`: `connection.prompt({ sessionId, prompt: [{ type: "text", text }] })`; `stopReason !== "end_turn"` emits an aborted/error event
     - `interruptTurn(threadId)`: `connection.cancelPrompt({ sessionId })` if the ACP SDK supports it, otherwise kill and restart
     - `respondToRequest(threadId, requestId, decision)`: resolve/reject pending Promise in approvals Map → ACP `requestPermission` returns `{ outcome: { outcome: "accepted" | "cancelled" } }`
     - `stopSession(threadId)`: close stdin, `SIGTERM`; emit `session.exited`
     - `stopAll()`: iterate all sessions
   - Per-session context:
     ```
     CopilotAcpSessionContext {
       threadId, cwd,
       sessionId: string,           // ACP sessionId from newSession()
       connection: ClientSideConnection,
       child: ChildProcess,
       pendingApprovals: Map<ApprovalRequestId, { resolve, reject }>
       status: "starting" | "ready" | "running" | "error"
     }
     ```

---

## Phase 4: Copilot Adapter (Service + Layer)
*Depends on Phase 3. Auth (Phase 2) is a prerequisite only for the WS auth surface — the adapter itself does not depend on it.*

8. Create `apps/server/src/provider/Services/CopilotAdapter.ts`:
   - `CopilotAdapterShape extends ProviderAdapterShape<ProviderAdapterError>` with `provider: "copilot"`
   - `CopilotAdapter` service tag

9. Create `apps/server/src/provider/Layers/CopilotAdapter.ts` (mirrors `CodexAdapter`):
   - `makeCopilotAdapter(options?)` — wraps `CopilotAcpManager`
   - Implements all 12 `ProviderAdapterShape` methods as `Effect.tryPromise` wrappers around `CopilotAcpManager` methods
   - `mapToRuntimeEvents(event)` — translates ACP `sessionUpdate` payloads to canonical `ProviderRuntimeEvent`:
     - `"agent_message_chunk"` / text → `content.delta { streamKind: "assistant_text" }`
     - `"agent_message_chunk"` / tool → `item.started`, `item.updated`, `item.completed`
     - permission requests → `request.opened`, `request.resolved`
     - session state changes → `session.state.changed`
     - prompt completion → `turn.completed` / `turn.aborted`
   - `streamEvents` — `Stream.fromQueue(runtimeEventQueue)` fed by manager event emitter (same pattern as `CodexAdapter`)
   - Capabilities: `{ sessionModelSwitch: "restart-session" }` — ACP sessions are tied to a running process; model change requires a new spawn
   - `readThread` / `rollbackThread`: ACP does not expose a thread-read API; store a lightweight `turns: TurnId[]` summary in `runtimePayload` for rollback bookkeeping; full history lives inside the Copilot process
   - Exports `CopilotAdapterLive` and `makeCopilotAdapterLive(options?)`

---

## Phase 5: Server Registration
*Depends on Phase 4.*

10. Update `apps/server/src/provider/Layers/ProviderAdapterRegistry.ts`:
    - Import and add `CopilotAdapter` alongside `CodexAdapter` in the adapters array inside `makeProviderAdapterRegistry()`

11. Update `apps/server/src/serverLayers.ts` → `makeServerProviderLayer()`:
    - Add `CopilotAdapterLive` to the layer composition
    - Add `CopilotAuthManager` to `makeServerRuntimeServicesLayer()`

---

## Phase 6: Web UI
*Depends on Phase 1 (new ProviderKind). Parallel with Phases 2–5.*

12. Update `apps/web/src/session-logic.ts`:
    - Change `ProviderPickerKind = ProviderKind | "claudeCode" | "cursor"` → remove `"claudeCode"` from stub (it becomes real later) and add `"copilot"` to real options
    - Add `{ value: "copilot", label: "GitHub Copilot", available: true }` to `PROVIDER_OPTIONS`

13. Update `apps/web/src/routes/_chat.settings.tsx` (and possibly create a new settings section):
   - Add "GitHub Copilot" settings section showing auth status (authenticated / not authenticated, GitHub login name)
   - When unauthenticated, show clear guidance that auth must already exist in the user's `gh` / Copilot CLI environment; do not start a browser/device-flow from T3 Code
   - Provide a refresh/recheck action around `copilot.auth.getStatus` so the UI can pick up external auth changes
   - Do not show in-app sign-out unless the product explicitly wants to surface the unsupported-state message from `copilot.auth.signOut`

14. Update `apps/web/src/nativeApi.ts` (or `wsNativeApi.ts`) to expose the three new auth WS methods via typed NativeApi wrappers.

15. Wire Copilot model options in thread creation UI — the `MODEL_OPTIONS_BY_PROVIDER.copilot` models should appear in the model picker when provider is `"copilot"`.

---

## Relevant Files

**New files:**
- `apps/server/src/copilotAuthManager.ts` — CLI-auth status lookup (`gh auth status` / `gh auth token`), unsupported auth-management methods, Copilot token exchange/cache
- `apps/server/src/copilotAcpManager.ts` — spawns `copilot --acp --stdio`, wraps `@agentclientprotocol/sdk`, maps ACP events to `ProviderEvent`s (mirrors `CodexAppServerManager`)
- `apps/server/src/provider/Services/CopilotAdapter.ts` — service tag + shape type
- `apps/server/src/provider/Layers/CopilotAdapter.ts` — full adapter implementation (mirrors `CodexAdapter`)

**Modified files:**
- `packages/contracts/src/orchestration.ts` — add `"copilot"` to `ProviderKind`
- `packages/contracts/src/model.ts` — Copilot models + options
- `packages/contracts/src/ws.ts` — auth WS methods
- `apps/server/src/wsServer.ts` — auth WS handlers
- `apps/server/src/serverLayers.ts` — wire Copilot adapter + auth manager
- `apps/server/src/provider/Layers/ProviderAdapterRegistry.ts` — register Copilot adapter
- `apps/web/src/session-logic.ts` — add copilot to PROVIDER_OPTIONS
- `apps/web/src/nativeApi.ts` / `wsNativeApi.ts` — expose auth methods
- `apps/web/src/routes/_chat.settings.tsx` — Copilot auth settings UI

---

## Verification

Each section maps to the phase it covers. All automated tests must live in the codebase and pass with `bun run test`. Manual checks are the minimum bar for shipping each phase.

---

### Phase 1 — Contracts

**Automated (`packages/contracts/src/orchestration.test.ts`):**
- `Schema.decodeUnknownSync(ProviderKind)("copilot")` does not throw
- `Schema.decodeUnknownSync(ProviderKind)("unknown-provider")` throws a `ParseError`
- `DEFAULT_PROVIDER_KIND === "codex"` (existing default unchanged)
- `MODEL_OPTIONS_BY_PROVIDER.copilot` is a non-empty array (type-level: `satisfies Record<ProviderKind, ...>` compile check)
- `DEFAULT_MODEL_BY_PROVIDER.copilot === "gpt-4o"`
- `DEFAULT_REASONING_EFFORT_BY_PROVIDER.copilot === null`

**CI gate:**
- `bun typecheck` passes in `packages/contracts` with no new errors — confirms all `satisfies Record<ProviderKind, ...>` tables have a `copilot` entry

---

### Phase 2 — Auth Manager

**Automated (`apps/server/src/copilotAuthManager.test.ts`):**
- `getStatus()` returns `{ authenticated: false }` when `gh auth status` reports no logged-in account
- `getStatus()` returns `{ authenticated: true, login: "octocat" }` when `gh auth status` reports an active account
- `getAccessToken()` returns the existing token from `gh auth token`
- `getAccessToken()` returns a typed error when `gh` is missing from PATH
- `initiateDeviceFlow()` fails with a typed unsupported error explaining auth must be managed outside T3 Code
- `pollForAccessToken()` fails with a typed unsupported error explaining device flow is unsupported
- `signOut()` fails with a typed unsupported error explaining sign-out must be managed outside T3 Code
- `getCopilotToken()` exchanges the existing `gh` token and caches the Copilot token

**WS handler smoke test (`apps/server/src/wsServer.test.ts`):**
- `copilot.auth.getStatus` is a registered WS method (assert it appears in the method dispatch table)
- Calling `copilot.auth.getStatus` over a test WS connection returns a response matching `{ authenticated: boolean }`

---

### Phase 3 — ACP Manager

**Automated (`apps/server/src/copilotAcpManager.test.ts`):**

Stub the `child_process.spawn` call to return a fake process backed by a pair of in-memory `PassThrough` streams (same technique used in `CodexAppServerManager` tests). Feed pre-recorded NDJSON ACP frames into the fake stdout.

- `startSession()` emits a `session.state.changed` event with status `"ready"` after the ACP `initialize` + `newSession` handshake completes
- `sendTurn()` with a scripted ACP response containing two `agent_message_chunk` text frames emits two `content.delta` events with the correct `delta` strings, followed by one `turn.completed`
- `sendTurn()` with a scripted ACP response containing a `tool_call` chunk followed by a text reply emits `item.started`, `item.completed`, and then `content.delta`
- `respondToRequest()` with `decision = "accept"` resolves the pending `requestPermission` Promise; the resolved `outcome.outcome` is `"accepted"`
- `respondToRequest()` with `decision = "decline"` resolves with `outcome.outcome = "cancelled"`
- `stopSession()` sends `SIGTERM` to the child process and emits `session.exited`
- `stopSession()` on an unknown `threadId` does not throw
- `startSession()` when `spawn` throws `ENOENT` (binary not found) emits `session.state.changed` with status `"error"` and a message containing `"copilot"` (not an unhandled rejection)

---

### Phase 4 — Copilot Adapter

**Automated (`apps/server/src/provider/Layers/CopilotAdapter.test.ts`):**

Use a fake `CopilotAcpManager` (same pattern as `CodexAdapter.test.ts`).

- `adapter.provider === "copilot"`
- `adapter.capabilities.sessionModelSwitch === "restart-session"`
- `startSession()` resolves to a `ProviderSession` with `provider: "copilot"` and `status: "ready"`
- `sendTurn()` collects the `streamEvents` stream; from the scripted manager, assert the stream yields at least one `content.delta` event before `turn.completed`
- `interruptTurn()` calls `manager.interruptTurn()` exactly once
- `stopSession()` removes the session so that `hasSession()` returns `false` afterward
- `listSessions()` returns the session started by `startSession()`

**Integration test (`apps/server/integration/providerService.integration.test.ts`):**

Reuse `TestProviderAdapter` harness (or add a copilot-flavoured variant):

- Dispatch `thread.turn.start` command with `provider: "copilot"` and a scripted single-turn response; assert the orchestration read model eventually shows a `messages` array with one assistant message containing the scripted text
- Assert `session.status` transitions: `"starting"` → `"ready"` → `"running"` → `"ready"` across the turn lifecycle
- Assert `turn.completed` event is emitted after the scripted response

---

### Phase 5 — Server Registration

**Automated (`apps/server/src/provider/Layers/ProviderAdapterRegistry.test.ts`):**
- `registry.listProviders()` returns an array containing both `"codex"` and `"copilot"`
- `registry.getByProvider("copilot")` succeeds (does not yield `ProviderUnsupportedError`)
- `registry.getByProvider("unknown")` yields `ProviderUnsupportedError`

**CI gate:**
- `bun typecheck` passes in `apps/server` — confirms `CopilotAdapterLive` layer dependency graph compiles

---

### Phase 6 — Web UI

**Automated (`apps/web/src/session-logic.test.ts`):**
- `PROVIDER_OPTIONS.find(o => o.value === "copilot")` is defined and `available === true`
- `PROVIDER_OPTIONS.find(o => o.value === "copilot").label === "GitHub Copilot"`

**Automated (`apps/web/src/wsNativeApi.test.ts` or equivalent):**
- `nativeApi.copilot.auth.getStatus` is a callable function (exists on the NativeApi object)
- Calling it over a mock WS transport sends a request with `body._tag === "copilot.auth.getStatus"`

**Manual checklist (required before marking Phase 6 done):**
- [ ] Settings page shows a "GitHub Copilot" section
- [ ] When unauthenticated, settings show clear guidance that GitHub/Copilot auth must be completed outside T3 Code (for example with `gh auth login`)
- [ ] After authenticating in the CLI, refreshing or re-checking status updates the settings section to show the authenticated GitHub username
- [ ] No in-app device-flow or sign-out controls are shown unless the product intentionally wants them to surface unsupported-state messaging
- [ ] Thread creation UI shows Copilot models (`gpt-4o`, `claude-3.5-sonnet`, `o3-mini`) in the model picker when provider `"copilot"` is selected
- [ ] Selecting provider `"codex"` still shows only Codex models — no regression

---

### End-to-End (requires real `copilot` CLI authenticated)

Run these manually against a locally running server before merging:

- [ ] Create a thread with `provider=copilot, model=gpt-4o`; send `"Reply with exactly: hello world"`; verify the assistant message streams and shows `hello world`
- [ ] Send a task that requires writing a file (e.g. `"Create a file called test-copilot.txt with content 'it works'"`); verify the approval dialog appears; accept; verify `test-copilot.txt` exists on disk with the correct content
- [ ] With a running turn, click the interrupt button; verify the turn ends with status `"interrupted"` and the UI returns to idle
- [ ] Stop the server mid-session; restart it; verify the thread shows `session.status = "stopped"` (not a crash or hung state) and a new turn can be started fresh
- [ ] `bun run test` — all tests green with no skips introduced by this feature

---

### Regression Gate

Before marking the entire feature complete:
- `bun lint && bun typecheck` — zero new errors across all packages
- `bun run test` — all pre-existing Codex tests still pass (no regressions in `CodexAdapter`, `ProviderService`, `OrchestrationEngine`)

---

## Decisions

- **Transport**: ACP over stdio (`copilot --acp --stdio`) via `@agentclientprotocol/sdk` — same pattern as `codex app-server`; the binary owns the agentic loop, tool execution, and conversation state
- **Auth**: CLI-owned GitHub auth state — `CopilotAuthManager` reads existing login state from `gh auth status` / `gh auth token`; T3 Code does not initiate OAuth itself and does not need a client ID
- **Token storage**: No persisted GitHub token in T3 Code; only the short-lived Copilot token is cached in memory for exchange reuse
- **Model selection**: Passed as part of `newSession()` options if ACP supports it, otherwise via prompt prefix; to be confirmed against ACP spec
- **Model switch via restart**: `sessionModelSwitch: "restart-session"` — ACP sessions are per-process; model change requires a new subprocess spawn
- **`rollbackThread`**: ACP does not expose a rollback API; store `turns: TurnId[]` in `runtimePayload` for bookkeeping; implement as kill + re-spawn with truncated history if ACP adds replay support later
- **`readThread`**: Return a minimal `ProviderThreadSnapshot` from `runtimePayload` turn log (no full message content — that lives inside the Copilot process)
- **Scope**: ACP-based `copilot` CLI only — direct HTTP to `api.githubcopilot.com` excluded (unnecessary given ACP)
- **Out of scope**: MCP server configuration, realtime/audio events, Copilot Extensions

## Further Considerations

1. **`copilot` CLI availability**: The user must have `copilot` CLI installed and already authenticated through their normal CLI workflow (`gh auth login` and/or Copilot CLI auth) before starting a session. The server should detect missing auth or a missing binary and surface a clear error rather than attempting to bootstrap login itself.
2. **ACP `cancelPrompt`**: The ACP SDK may not yet expose a cancel/interrupt method (public preview). If absent, interrupt falls back to killing and restarting the process. Track the ACP changelog and add graceful cancel when available.
3. **Session resume after server restart**: ACP sessions are in-process; there is no resume cursor like Codex's `threadId`. After a server restart, a new ACP process must be spawned. `resumeCursor` should store the last `sessionId` for logging but cannot be used to resume. The orchestration layer will show the session as `stopped` on reconnect, consistent with current behavior for other dead sessions.
4. **Model list**: Confirm which models are exposed via ACP (the CLI may restrict to a subset of what `api.githubcopilot.com` offers). `MODEL_OPTIONS_BY_PROVIDER.copilot` should be kept in sync with what the ACP server actually accepts.
