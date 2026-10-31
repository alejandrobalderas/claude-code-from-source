# Chapter 3: State -- The Two-Tier Architecture

Chapter 2 traced the bootstrap pipeline from process start to first render. By the end, the system had a fully configured environment. But configured with *what*? Where does the session ID live? The current model? The message history? The cost tracker? The permission mode? Where does state live, and why does it live there?

Every long-running application eventually faces this question. For a simple CLI tool the answer is trivial -- a few variables in `main()`. But Claude Code is not a simple CLI tool. It is a React application rendered through Ink, with a process lifecycle that spans hours, a plugin system that loads at arbitrary times, an API layer that must construct prompts from cached context, a cost tracker that survives process restarts, and dozens of infrastructure modules that need to read and write shared data without importing each other.

The naive approach -- a single global store -- fails immediately. If the cost tracker updated the same store that drives React re-renders, every API call would trigger a full component tree reconciliation. Infrastructure modules (bootstrap, context building, cost tracking, telemetry) cannot import React. They run before React mounts. They run after React unmounts. They run in contexts where no component tree exists at all. Putting everything into a React-aware store would create circular dependencies across the entire import graph.

Claude Code solves this with a two-tier architecture: a mutable process singleton for infrastructure state, and a minimal reactive store for UI state. This chapter explains both tiers, the side-effect system that bridges them, and the supporting subsystems that depend on this foundation. Every subsequent chapter assumes you understand where state lives and why it lives there.

---

## 3.1 Bootstrap State -- The Process Singleton

### Why a Mutable Singleton

The bootstrap state module (`bootstrap/state.ts`) is a single mutable object created once at process start:

```typescript
const STATE: State = getInitialState()
```

The comment above this line reads: `AND ESPECIALLY HERE`. Two lines above the type definition: `DO NOT ADD MORE STATE HERE - BE JUDICIOUS WITH GLOBAL STATE`. These comments have the tone of engineers who learned the cost of an ungoverned global object the hard way.

A mutable singleton is the right choice here for three reasons. First, bootstrap state must be available before any framework initializes -- before React mounts, before the store is created, before plugins load. Module-scope initialization is the only mechanism that guarantees availability at import time. Second, the data is inherently process-scoped: session IDs, telemetry counters, cost accumulators, cached paths. There is no meaningful "previous state" to diff against, no subscribers to notify, no undo history. Third, the module must be a leaf in the import dependency graph. If it imported React, or the store, or any service module, it would create cycles that break the bootstrap sequence described in Chapter 2. By depending on nothing but utility types and `node:crypto`, it remains importable from anywhere.

### The ~80 Fields

The `State` type contains approximately 80 fields. A sampling reveals the breadth:

**Identity and paths** -- `originalCwd`, `projectRoot`, `cwd`, `sessionId`, `parentSessionId`. The `originalCwd` is resolved through `realpathSync` and NFC-normalized at process start. It never changes.

**Cost and metrics** -- `totalCostUSD`, `totalAPIDuration`, `totalLinesAdded`, `totalLinesRemoved`. These accumulate monotonically through the session and persist to disk on exit.

**Telemetry** -- `meter`, `sessionCounter`, `costCounter`, `tokenCounter`. OpenTelemetry handles, all nullable (null until telemetry initializes).

**Model configuration** -- `mainLoopModelOverride`, `initialMainLoopModel`. The override is set when the user changes models mid-session.

**Session flags** -- `isInteractive`, `kairosActive`, `sessionTrustAccepted`, `hasExitedPlanMode`. Booleans that gate behavior for the session duration.

**Cache optimization** -- `promptCache1hAllowlist`, `promptCache1hEligible`, `systemPromptSectionCache`, `cachedClaudeMdContent`. These exist to prevent redundant computation and prompt cache busting.

### The Getter/Setter Pattern

The `STATE` object is never exported. All access goes through approximately 100 individual getter and setter functions:

```typescript
// Pseudocode — illustrates the pattern
export function getProjectRoot(): string {
  return STATE.projectRoot
}

export function setProjectRoot(dir: string): void {
  STATE.projectRoot = dir.normalize('NFC')  // NFC normalization on every path setter
}
```

This pattern enforces encapsulation, NFC normalization on every path setter (preventing Unicode mismatches on macOS), type narrowing, and bootstrap isolation. The trade-off is verbosity -- a hundred functions for eighty fields. But in a codebase where a stray mutation could bust a 50,000-token prompt cache, explicitness wins.

### The Signal Pattern

Bootstrap cannot import listeners (it is a DAG leaf), so it uses a minimal pub/sub primitive called `createSignal`. The `sessionSwitched` signal has exactly one consumer: `concurrentSessions.ts`, which keeps PID files in sync. The signal is exposed as `onSessionSwitch = sessionSwitched.subscribe`, letting callers register themselves without bootstrap knowing who they are.

### The Five Sticky Latches

The most subtle fields in bootstrap state are five boolean latches that follow the same pattern: once a feature is first activated during a session, a corresponding flag stays `true` for the rest of the session. They all exist for one reason: prompt cache preservation.

```mermaid
sequenceDiagram
    participant U as User
    participant L as Latch
    participant C as Cache

    Note over L: Initial: null (not evaluated)
    U->>L: Activate auto mode (first time)
    L->>L: Set to true (latched)
    L->>C: Beta header added to cache key
    Note over C: Cache warms with header

    U->>L: Deactivate auto mode
    L->>L: Still true (latched!)
    L->>C: Header still present
    Note over C: Cache preserved

    U->>L: Reactivate auto mode
    L->>L: Still true
    Note over C: No cache bust at any toggle
```

Claude's API supports server-side prompt caching. When consecutive requests share the same system prompt prefix, the server reuses cached computations. But the cache key includes HTTP headers and request body fields. If a beta header appears in request N but not request N+1, the cache is busted -- even if the prompt content is identical. For a system prompt exceeding 50,000 tokens, a cache miss is expensive.

The five latches:

| Latch | What It Prevents |
|-------|-----------------|
| `afkModeHeaderLatched` | Shift+Tab auto mode toggling flips the AFK beta header on/off |
| `fastModeHeaderLatched` | Fast mode cooldown enter/exit flips the fast mode header |
| `cacheEditingHeaderLatched` | Remote feature flag changes bust every active user's cache |
| `thinkingClearLatched` | Triggered on confirmed cache miss (>1h idle). Prevents re-enabling thinking blocks from busting freshly warmed cache |
| `pendingPostCompaction` | Consume-once flag for telemetry: distinguishes compaction-induced cache misses from TTL-expiry misses |

All five use a three-state type: `boolean | null`. The `null` initial value means "not yet evaluated." `true` means "latched on." They never return to `null` or `false` once set to `true`. This is the defining property of a latch.

The implementation pattern:

```typescript
function shouldSendBetaHeader(featureCurrentlyActive: boolean): boolean {
  const latched = getAfkModeHeaderLatched()
  if (latched === true) return true       // Already latched -- always send
  if (featureCurrentlyActive) {
    setAfkModeHeaderLatched(true)          // First activation -- latch it
    return true
  }
  return false                             // Never activated -- don't send
}
```

Why not just always send all beta headers? Because headers are part of the cache key. Sending an unrecognized header creates a different cache namespace. The latch ensures you only enter a cache namespace when you actually need it, then stay there.

---

## 3.2 AppState -- The Reactive Store

### The 34-Line Implementation

The UI state store lives in `state/store.ts`:

The store implementation is approximately 30 lines: a closure over a `state` variable, an `Object.is` equality check to prevent spurious updates, synchronous listener notification, and an `onChange` callback for side effects. The skeleton looks like:

```typescript
// Pseudocode — illustrates the pattern
function makeStore(initial, onTransition) {
  let current = initial
  const subs = new Set()
  return {
    read:      () => current,
    update:    (fn) => { /* Object.is guard, then notify */ },
    subscribe: (cb) => { subs.add(cb); return () => subs.delete(cb) },
  }
}
```

Thirty-four lines. No middleware, no devtools, no time-travel debugging, no action types. Just a closure over a mutable variable, a Set of listeners, and an `Object.is` equality check. This is Zustand without the library.

The design decisions worth examining:

**Updater function pattern.** There is no `setState(newValue)` -- only `setState((prev) => next)`. Every mutation receives the current state and must produce the next state, eliminating stale-state bugs from concurrent mutations.

**`Object.is` equality check.** If the updater returns the same reference, the mutation is a no-op. No listeners fire. No side effects run. Critical for performance -- components that spread-and-set without changing values produce no re-renders.

**`onChange` fires before listeners.** The optional `onChange` callback receives both old and new state and fires synchronously before any subscriber is notified. This is used for side effects (Section 3.4) that must complete before the UI re-renders.

**No middleware, no devtools.** This is not an oversight. When your store needs exactly three operations (get, set, subscribe), an `Object.is` equality check, and a synchronous `onChange` hook, 34 lines of code you own is better than a dependency. You control the exact semantics. You can read the entire implementation in thirty seconds.

### The AppState Type

The `AppState` type (~452 lines) is the shape of everything the UI needs to render. It is wrapped in `DeepImmutable<>` for most fields, with explicit exclusions for fields containing function types:

```typescript
export type AppState = DeepImmutable<{
  settings: SettingsJson
  verbose: boolean
  // ... ~150 more fields
}> & {
  tasks: { [taskId: string]: TaskState }  // Contains abort controllers
  agentNameRegistry: Map<string, AgentId>
}
```

The intersection type lets most fields be deeply immutable while exempting fields that hold functions, Maps, and mutable refs. Full immutability is the default, with surgical escape hatches where the type system would fight the runtime semantics.

### React Integration

The store integrates with React through `useSyncExternalStore`:

```typescript
// Standard React pattern — useSyncExternalStore with a selector
export function useAppState<T>(selector: (state: AppState) => T): T {
  const store = useContext(AppStoreContext)
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.getState()),
  )
}
```

The selector must return an existing sub-object reference (not a freshly constructed object) for `Object.is` comparison to prevent unnecessary re-renders. If you write `useAppState(s => ({ a: s.a, b: s.b }))`, every render produces a new object reference, and the component re-renders on every state change. This is the same constraint Zustand users face -- cheaper comparisons, but the selector author must understand reference identity.

---

## 3.3 How the Two Tiers Relate

The two tiers communicate through explicit, narrow interfaces.

```mermaid
graph TD
    RC["React Components"] -->|subscribe via useSyncExternalStore| AS["AppState Store<br/>(reactive, immutable snapshots)"]
    AS -->|onChange writes| BS["Bootstrap STATE<br/>(mutable singleton, no dependencies)"]
    BS -->|reads during init| AS
    BS -->|read imperatively by| API["API Client"]
    BS -->|read imperatively by| CT["Cost Tracker"]
    BS -->|read imperatively by| CB["Context Builder"]

    style BS fill:#ffd,stroke:#333
    style AS fill:#dfd,stroke:#333
    style RC fill:#ddf,stroke:#333
```

Bootstrap state flows into AppState during initialization: `getDefaultAppState()` reads settings from disk (which bootstrap helped locate), checks feature flags (which bootstrap evaluated), and sets the initial model (which bootstrap resolved from CLI args and settings).

AppState flows back to bootstrap state through side effects: when the user changes the model, `onChangeAppState` calls `setMainLoopModelOverride()` in bootstrap. When settings change, credential caches in bootstrap are cleared.

But the two tiers never share a reference. A module that imports bootstrap state does not need to know about React. A component that reads AppState does not need to know about the process singleton.

A concrete example clarifies the data flow. When the user types `/model claude-sonnet-4`:

1. The command handler calls `store.setState(prev => ({ ...prev, mainLoopModel: 'claude-sonnet-4' }))`
2. The store's `Object.is` check detects a change
3. `onChangeAppState` fires, detects the model changed, calls `setMainLoopModelOverride()` (updates bootstrap) and `updateSettingsForSource()` (persists to disk)
4. All store subscribers fire -- React components re-render to show the new model name
5. The next API call reads the model from `getMainLoopModelOverride()` in bootstrap state

Steps 1-4 are synchronous. The API client in step 5 may run seconds later. But it reads from bootstrap state (updated in step 3), not from AppState. This is the two-tier handoff: the UI store is the source of truth for what the user chose, but bootstrap state is the source of truth for what the API client uses.

The DAG property -- bootstrap depends on nothing, AppState depends on bootstrap for init, React depends on AppState -- is enforced by an ESLint rule that prevents `bootstrap/state.ts` from importing modules outside its allowed set.

---

## 3.4 Side Effects: onChangeAppState

The `onChange` callback is where the two tiers synchronize. Every `setState` call triggers `onChangeAppState`, which receives both previous and new state and decides what external effects to fire.

**Permission mode sync** is the primary use case. Prior to this centralized handler, permission mode was synced to the remote session (CCR) by only 2 of 8+ mutation paths. The other six -- Shift+Tab cycling, dialog options, slash commands, rewind, bridge callbacks -- all mutated AppState without telling CCR. The external metadata drifted out of sync.

The fix: stop scattering notifications across mutation sites and instead hook the diff in one place. The comment in the source code lists every mutation path that was broken and notes that "the scattered callsites above need zero changes." This is the architectural benefit of centralized side effects -- coverage is structural, not manual.

**Model changes** keep bootstrap state in sync with what the UI renders. **Settings changes** clear credential caches and re-apply environment variables. **Verbose toggle** and **expanded view** are persisted to global config.

The pattern -- centralized side effects on a diffable state transition -- is essentially the Observer pattern applied at the granularity of a state diff rather than individual events. It scales better than scattered event emissions because the number of side effects grows much more slowly than the number of mutation sites.

---

## 3.5 Context Building

Three memoized async functions in `context.ts` build the system prompt context prepended to every conversation. Each is computed once per session, not per turn.

`getGitStatus` runs five git commands in parallel (`Promise.all`), producing a block with the current branch, default branch, recent commits, and working tree status. The `--no-optional-locks` flag prevents git from taking write locks that could interfere with concurrent git operations in another terminal.

`getUserContext` loads CLAUDE.md content and caches it in bootstrap state via `setCachedClaudeMdContent`. This cache breaks a circular dependency: the auto-mode classifier needs CLAUDE.md content, but CLAUDE.md loading goes through the filesystem, which goes through permissions, which calls the classifier. By caching in bootstrap state (a DAG leaf), the cycle is broken.

All three context functions use Lodash's `memoize` (compute once, cache forever) rather than TTL-based caching. The reasoning: if git status were re-computed every 5 minutes, the change would bust the server-side prompt cache. The system prompt even tells the model: "This is the git status at the start of the conversation. Note that this status is a snapshot in time."

---

## 3.6 Cost Tracking

Every API response flows through `addToTotalSessionCost`, which accumulates per-model usage, updates bootstrap state, reports to OpenTelemetry, and recursively processes advisor tool usage (nested model calls within a response).

Cost state survives process restarts through save-and-restore to a project config file. The session ID is used as a guard -- costs are only restored if the persisted session ID matches the session being resumed.

Histograms use reservoir sampling (Algorithm R) to maintain bounded memory while accurately representing distributions. The 1,024-entry reservoir produces p50, p95, and p99 percentiles. Why not a simple running average? Because averages hide distribution shape. A session where 95% of API calls take 200ms and 5% take 10 seconds has the same average as one where all calls take 690ms, but the user experience is radically different.

---

## 3.7 What We Learned

The codebase has grown from a simple CLI to a system with ~450 lines of state type definitions, ~80 fields of process state, a side-effect system, multiple persistence boundaries, and cache optimization latches. None of this was designed upfront. The sticky latches were added when cache busting became a measurable cost problem. The `onChange` handler was centralized when 6 of 8 permission sync paths were discovered to be broken. The CLAUDE.md cache was added when a circular dependency emerged.

This is the natural growth pattern of state in a complex application. The two-tier architecture provides enough structure to contain the growth -- new bootstrap fields do not affect React rendering, new AppState fields do not create import cycles -- while remaining flexible enough to accommodate patterns that were not anticipated in the original design.

---

## 3.8 State Architecture Summary

| Property | Bootstrap State | AppState |
|---|---|---|
| **Location** | Module-scope singleton | React context |
| **Mutability** | Mutable through setters | Immutable snapshots via updater |
| **Subscribers** | Signal (pub/sub) for specific events | `useSyncExternalStore` for React |
| **Availability** | Import time (before React) | After provider mounts |
| **Persistence** | Process exit handlers | Via onChange to disk |
| **Equality** | N/A (imperative reads) | `Object.is` reference check |
| **Dependencies** | DAG leaf (imports nothing) | Imports types from across codebase |
| **Test reset** | `resetStateForTests()` | Create new store instance |
| **Primary consumers** | API client, cost tracker, context builder | React components, side effects |

---

## Apply This

**Separate state by access pattern, not by domain.** Session ID belongs in the singleton not because it is "infrastructure" in the abstract, but because it must be readable before React mounts and writable without notifying subscribers. Permission mode belongs in the reactive store because changing it must trigger re-renders and side effects. Let the access pattern drive the tier, and the architecture follows naturally.

**The sticky latch pattern.** Any system that interacts with a cache (prompt cache, CDN, query cache) faces the same problem: feature toggles that change the cache key mid-session cause invalidation. Once a feature is activated, its cache key contribution stays active for the session. The three-state type (`boolean | null`, meaning "not evaluated / on / never off") makes the intent self-documenting. Especially valuable when the cache is not under your control.

**Centralize side effects on state diffs.** When multiple code paths can change the same state, do not scatter notifications across mutation sites. Hook the store's `onChange` callback and detect which fields changed. Coverage becomes structural (any mutation triggers the effect) rather than manual (each mutation site must remember to notify).

**Prefer 34 lines you own over a library you do not.** When your requirements are exactly get, set, subscribe, and a change callback, a minimal implementation gives you full control over the semantics. In a system where state management bugs can cost real money, that transparency has value. The key insight is recognizing when you do *not* need a library.

**Use process exit as a persistence boundary with intention.** Multiple subsystems persist state on process exit. The trade-off is explicit: non-graceful termination (SIGKILL, OOM) loses accumulated data. This is acceptable because the data is diagnostic, not transactional, and writing to disk on every state change would be too expensive for counters that increment hundreds of times per session.

---

The two-tier architecture established in this chapter -- bootstrap singleton for infrastructure, reactive store for UI, side effects bridging them -- is the foundation that every subsequent chapter builds on. The conversation loop (Chapter 4) reads context from the memoized builders. The tool system (Chapter 5) checks permissions from AppState. The agent system (Chapter 8) creates task entries in AppState while tracking costs in bootstrap state. Understanding where state lives, and why, is prerequisite to understanding how any of these systems work.

Some fields straddle the boundary. The main loop model exists in both tiers: `mainLoopModel` in AppState (for UI rendering) and `mainLoopModelOverride` in bootstrap state (for API client consumption). The `onChangeAppState` handler keeps them synchronized. This duplication is the cost of the two-tier split. But the alternative -- having the API client import the React store, or having React components read from the process singleton -- would violate the dependency direction that keeps the architecture sound. A small amount of controlled duplication, bridged by a centralized synchronization point, is preferable to a tangled dependency graph.
