# Chapter 5: The Agent Loop

## The Beating Heart

Chapter 4 showed how the API layer transforms configuration into streaming HTTP requests -- how the client is built, how system prompts are assembled, how responses arrive as server-sent events. That layer handles the *mechanics* of talking to the model. But a single API call is not an agent. An agent is a loop: call the model, execute tools, feed results back, call the model again, until the work is done.

Every system has a center of gravity. In a database, it is the storage engine. In a compiler, it is the intermediate representation. In Claude Code, it is `query.ts` -- a single 1,730-line file containing the async generator that runs every interaction, from the first keystroke in the REPL to the last tool call of a headless `--print` invocation.

This is not an exaggeration. There is exactly one code path that talks to the model, executes tools, manages context, recovers from errors, and decides when to stop. That code path is the `query()` function. The REPL calls it. The SDK calls it. Sub-agents call it. The headless runner calls it. If you are using Claude Code, you are inside `query()`.

The file is dense, but it is not complex in the way that tangled inheritance hierarchies are complex. It is complex in the way that a submarine is complex: a single hull with many redundant systems, each one added because the ocean found a way in. Every `if` branch has a story. Every withheld error message represents a real bug where an SDK consumer disconnected mid-recovery. Every circuit breaker threshold was tuned against real sessions that burned thousands of API calls in infinite loops.

This chapter traces the entire loop, start to finish. By the end, you will understand not just what happens, but why each mechanism exists and what breaks without it.

---

## Why an Async Generator

The first architectural question: why is the agent loop a generator and not a callback-based event emitter?

```typescript
// Simplified — shows the concept, not the exact types
async function* agentLoop(params: LoopParams): AsyncGenerator<Message | Event, TerminalReason>
```

The actual signature yields several message and event types and returns a discriminated union encoding why the loop stopped.

Three reasons, in order of importance.

**Backpressure.** An event emitter fires whether the consumer is ready or not. A generator yields only when the consumer calls `.next()`. When the REPL's React renderer is busy painting the previous frame, the generator naturally pauses. When an SDK consumer is processing a tool result, the generator waits. No buffer overflow, no dropped messages, no "fast producer / slow consumer" problem.

**Return value semantics.** The generator's return type is `Terminal` -- a discriminated union encoding exactly why the loop stopped. Was it a normal completion? A user abort? A token budget exhaustion? A stop hook intervention? A max-turns limit? An unrecoverable model error? There are 10 distinct terminal states. Callers do not need to subscribe to an "end" event and hope the payload contains the reason. They get it as a typed return value from `for await...of` or `yield*`.

**Composability via `yield*`.** The outer `query()` function delegates to `queryLoop()` with `yield*`, which transparently forwards every yielded value and the final return. Sub-generators like `handleStopHooks()` use the same pattern. This creates a clean chain of responsibility without callbacks, without promises wrapping promises, without event forwarding boilerplate.

The choice has a cost -- async generators in JavaScript cannot be "rewound" or forked. But the agent loop does not need either. It is a strictly forward-moving state machine.

One more subtlety: the `function*` syntax makes the function *lazy*. The body does not execute until the first `.next()` call. This means `query()` returns instantly -- all the heavy initialization (config snapshot, memory prefetch, budget tracker) happens only when the consumer starts pulling values. In the REPL, this means the React rendering pipeline is already set up before the first line of the loop runs.

---

## What Callers Provide

Before tracing the loop, it helps to know what goes in:

```typescript
// Simplified — illustrates the key fields
type LoopParams = {
  messages: Message[]
  prompt: SystemPrompt
  permissionCheck: CanUseToolFn
  context: ToolUseContext
  source: QuerySource         // 'repl', 'sdk', 'agent:xyz', 'compact', etc.
  maxTurns?: number
  budget?: { total: number }  // API-level task budget
  deps?: LoopDeps             // Injected for testing
}
```

The notable fields:

- **`querySource`**: A string discriminant like `'repl_main_thread'`, `'sdk'`, `'agent:xyz'`, `'compact'`, or `'session_memory'`. Many conditionals branch on this. The compact agent uses `querySource: 'compact'` so the blocking limit guard does not deadlock (the compact agent needs to run to *reduce* the token count).

- **`taskBudget`**: The API-level task budget (`output_config.task_budget`). Distinct from the `+500k` auto-continue token budget feature. `total` is the budget for the whole agentic turn; `remaining` is computed per iteration from cumulative API usage and adjusted across compaction boundaries.

- **`deps`**: Optional dependency injection. Defaults to `productionDeps()`. This is the seam where tests swap in fake model calls, fake compaction, and deterministic UUIDs.

- **`canUseTool`**: A function that returns whether a given tool is allowed. This is the permission layer -- it checks trust settings, hook decisions, and the current permission mode.

---

## The Two-Layer Entry Point

The public API is a thin wrapper around the real loop:

The outer function wraps the inner loop, tracking which queued commands were consumed during the turn. After the inner loop completes, consumed commands are marked as `'completed'`. If the loop throws or the generator is closed via `.return()`, the completion notifications never fire -- a failed turn should not mark commands as successfully processed. Commands queued during a turn (via `/` slash commands or task notifications) are marked `'started'` inside the loop and `'completed'` in the wrapper. If the loop throws or the generator is closed via `.return()`, the completion notifications never fire. This is intentional -- a failed turn should not mark commands as successfully processed.

---

## The State Object

The loop carries its state in a single typed object:

```typescript
// Simplified — illustrates the key fields
type LoopState = {
  messages: Message[]
  context: ToolUseContext
  turnCount: number
  transition: Continue | undefined
  // ... plus recovery counters, compaction tracking, pending summaries, etc.
}
```

Ten fields. Each one earns its place:

| Field | Why It Exists |
|-------|---------------|
| `messages` | The conversation history, grown each iteration |
| `toolUseContext` | Mutable context: tools, abort controller, agent state, options |
| `autoCompactTracking` | Tracks compaction state: turn counter, turn ID, consecutive failures, compacted flag |
| `maxOutputTokensRecoveryCount` | How many multi-turn recovery attempts for output token limits (max 3) |
| `hasAttemptedReactiveCompact` | One-shot guard against infinite reactive compaction loops |
| `maxOutputTokensOverride` | Set to 64K during escalation, cleared after |
| `pendingToolUseSummary` | A promise from the previous iteration's Haiku summary, resolved during current streaming |
| `stopHookActive` | Prevents re-running stop hooks after a blocking retry |
| `turnCount` | Monotonic counter, checked against `maxTurns` |
| `transition` | Why the previous iteration continued -- `undefined` on first iteration |

### Immutable Transitions in a Mutable Loop

Here is the pattern that appears at every `continue` statement in the loop:

```typescript
const next: State = {
  messages: [...messagesForQuery, ...assistantMessages, ...toolResults],
  toolUseContext: toolUseContextWithQueryTracking,
  autoCompactTracking: tracking,
  turnCount: nextTurnCount,
  maxOutputTokensRecoveryCount: 0,
  hasAttemptedReactiveCompact: false,
  pendingToolUseSummary: nextPendingToolUseSummary,
  maxOutputTokensOverride: undefined,
  stopHookActive,
  transition: { reason: 'next_turn' },
}
state = next
```

Every continue site constructs a complete new `State` object. Not `state.messages = newMessages`. Not `state.turnCount++`. A full reconstruction. The benefit is that every transition is self-documenting. You can read any `continue` site and see exactly which fields change and which are preserved. The `transition` field on the new state records *why* the loop is continuing -- tests assert on this to verify that the correct recovery path fired.

---

## The Loop Body

Here is the full execution flow of a single iteration, compressed to its skeleton:

```mermaid
stateDiagram-v2
    [*] --> ContextPipeline: Destructure state,\nstart prefetches

    ContextPipeline --> ModelStreaming: Messages ready
    note right of ContextPipeline
        Tool result budgets
        → Snip compact
        → Microcompact
        → Context collapse
        → Auto-compact
        → Blocking limit guard
    end note

    ModelStreaming --> PostStream: Stream complete
    ModelStreaming --> ErrorHandling: Exception thrown
    note right of ModelStreaming
        Configure streaming executor
        Select model (may change)
        Backfill observable inputs
        Withhold recoverable errors
        Feed tools to streaming executor
        Drain completed results
    end note

    ErrorHandling --> Terminal_Error: Unrecoverable
    ErrorHandling --> ContextPipeline: Fallback model retry

    PostStream --> DoneCheck: No tool use
    PostStream --> ToolExecution: Has tool use

    DoneCheck --> Terminal_Complete: All checks pass
    DoneCheck --> ContextPipeline: Recovery needed\n(413, max_output,\nstop hook blocking)

    ToolExecution --> Terminal_Abort: User abort / hook stop
    ToolExecution --> ContextPipeline: Reconstruct state,\ncontinue loop
    note right of ToolExecution
        Execute tools (streaming or batch)
        Generate summary for next iteration
        Inject attachments, memory, skills
        Drain command queue
        Refresh tools (MCP)
        Check max turns
    end note
```

That is the entire loop. Every feature in Claude Code -- from memory to sub-agents to error recovery -- feeds into or consumes from this single iteration structure.

---

## Context Management: Four Compression Layers

Before each API call, the message history passes through up to four context management stages. They run in a specific order, and that order matters.

```mermaid
graph TD
    A[Raw messages] --> B[Tool Result Budget]
    B --> C[Snip Compact]
    C --> D[Microcompact]
    D --> E[Context Collapse]
    E --> F[Auto-Compact]
    F --> G[Messages for API call]

    B -.- B1[Enforce per-message size limits]
    C -.- C1[Physically remove old messages]
    D -.- D1[Remove tool results by tool_use_id]
    E -.- E1[Replace spans with summaries]
    F -.- F1[Full conversation summarization]
```

### Layer 0: Tool Result Budget

Before any compression, `applyToolResultBudget()` enforces per-message size limits on tool results. Tools without a finite `maxResultSizeChars` are exempted.

### Layer 1: Snip Compact

The lightest operation. Snip physically removes old messages from the array, yielding a boundary message to signal the removal to the UI. It reports how many tokens were freed, and that number is plumbed into auto-compact's threshold check.

### Layer 2: Microcompact

Microcompact removes tool results that are no longer needed, identified by `tool_use_id`. For cached microcompact (which edits the API cache), the boundary message is deferred until after the API response. The reason: client-side token estimates are unreliable. The actual `cache_deleted_input_tokens` from the API response tells you what was really freed.

### Layer 3: Context Collapse

Context collapse replaces spans of conversation with summaries. It runs before auto-compact, and the ordering is deliberate: if collapse reduces the context below the auto-compact threshold, auto-compact becomes a no-op. This preserves granular context instead of replacing everything with a single monolithic summary.

### Layer 4: Auto-Compact

The heaviest operation: it forks an entire Claude conversation to summarize the history. The implementation has a circuit breaker -- after 3 consecutive failures, it stops trying. This prevents the nightmare scenario observed in production: sessions stuck over the context limit burning 250K API calls per day in an infinite compact-fail-retry loop.

### Auto-Compact Thresholds

The thresholds are derived from the model's context window:

```
effectiveContextWindow = contextWindow - min(modelMaxOutput, 20000)

Thresholds (relative to effectiveContextWindow):
  Auto-compact fires:      effectiveWindow - 13,000
  Blocking limit (hard):   effectiveWindow - 3,000
```

| Constant | Value | Purpose |
|----------|-------|---------|
| `AUTOCOMPACT_BUFFER_TOKENS` | 13,000 | Headroom below effective window for auto-compact trigger |
| `MANUAL_COMPACT_BUFFER_TOKENS` | 3,000 | Reserves space so `/compact` still works |
| `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES` | 3 | Circuit breaker threshold |

The 13,000-token buffer means auto-compact fires well before the hard limit. The gap between the auto-compact threshold and the blocking limit is where reactive compact operates -- if the proactive auto-compact fails or is disabled, reactive compact catches the 413 error and compacts on demand.

### Token Counting

The canonical function `tokenCountWithEstimation` combines authoritative API-reported token counts (from the most recent response) with a rough estimate for messages added after that response. The approximation is conservative -- it errs toward higher counts, which means auto-compact fires slightly early rather than slightly late.

---

## Model Streaming

### The callModel() Loop

The API call happens inside a `while(attemptWithFallback)` loop that enables model fallback:

```typescript
let attemptWithFallback = true
while (attemptWithFallback) {
  attemptWithFallback = false
  try {
    for await (const message of deps.callModel({ messages, systemPrompt, tools, signal })) {
      // Process each streamed message
    }
  } catch (innerError) {
    if (innerError instanceof FallbackTriggeredError && fallbackModel) {
      currentModel = fallbackModel
      attemptWithFallback = true
      continue
    }
    throw innerError
  }
}
```

When enabled, a `StreamingToolExecutor` starts executing tools as soon as their `tool_use` blocks arrive during streaming -- not after the full response completes. How tools are orchestrated into concurrent batches is the subject of Chapter 7.

### The Withholding Pattern

This is one of the most important patterns in the file. Recoverable errors are suppressed from the yield stream:

```typescript
let withheld = false
if (contextCollapse?.isWithheldPromptTooLong(message)) withheld = true
if (reactiveCompact?.isWithheldPromptTooLong(message)) withheld = true
if (isWithheldMaxOutputTokens(message)) withheld = true
if (!withheld) yield yieldMessage
```

Why withhold? Because SDK consumers -- Cowork, the desktop app -- terminate the session on any message with an `error` field. If you yield a prompt-too-long error and then successfully recover via reactive compaction, the consumer has already disconnected. The recovery loop keeps running, but nobody is listening. So the error is withheld, pushed to `assistantMessages` so downstream recovery checks can find it. If all recovery paths fail, the withheld message is finally surfaced.

### Model Fallback

When a `FallbackTriggeredError` is caught (high demand on the primary model), the loop switches models and retries. But thinking signatures are model-bound -- replaying a protected-thinking block from one model to a different fallback model causes a 400 error. The code strips signature blocks before retry. All orphaned assistant messages from the failed attempt are tombstoned so the UI removes them.

---

## Error Recovery: The Escalation Ladder

Error recovery in query.ts is not a single strategy. It is a ladder of increasingly aggressive interventions, each triggered when the previous one fails.

```mermaid
graph TD
    E[Error detected] --> W[Withhold from stream]

    W --> P{Prompt too long?}
    W --> M{Max output tokens?}
    W --> I{Media size error?}

    P -->|Yes| C1[1. Context collapse drain]
    C1 -->|Still 413| C2[2. Reactive compact]
    C2 -->|Fails| S1[Surface error, exit]

    M -->|Yes| M1[1. 8K → 64K escalation]
    M1 -->|Still hit| M2[2. Multi-turn recovery x3]
    M2 -->|Exhausted| S2[Surface error, exit]

    I -->|Yes| I1[1. Reactive compact]
    I1 -->|Fails| S3[Surface error, exit]

    style S1 fill:#f66
    style S2 fill:#f66
    style S3 fill:#f66
```

### The Death Spiral Guard

The most dangerous failure mode is an infinite loop. The code has multiple guards:

1. **`hasAttemptedReactiveCompact`**: One-shot flag. Reactive compact fires once per error type.
2. **`MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3`**: Hard cap on multi-turn recovery attempts.
3. **Circuit breaker on auto-compact**: After 3 consecutive failures, auto-compact stops trying entirely.
4. **No stop hooks on error responses**: The code explicitly returns before reaching stop hooks when the last message is an API error. The comment explains: "error -> hook blocking -> retry -> error -> ... (the hook injects more tokens each cycle)."
5. **Preserved `hasAttemptedReactiveCompact` across stop hook retries**: When a stop hook returns blocking errors and forces a retry, the reactive compact guard is preserved. The comment documents the bug: "Resetting to false here caused an infinite loop burning thousands of API calls."

Each of these guards was added because someone hit the failure mode in production.

---

## Worked Example: "Fix the Bug in auth.ts"

To make the loop concrete, let us trace a real interaction through three iterations.

**The user types:** `Fix the null pointer bug in src/auth/validate.ts`

**Iteration 1: The model reads the file.**

The loop enters. Context management runs (no compression needed -- the conversation is short). The model streams a response: "Let me look at the file." It emits a single `tool_use` block: `Read({ file_path: "src/auth/validate.ts" })`. The streaming executor sees a concurrency-safe tool and starts it immediately. By the time the model finishes its response text, the file contents are already in memory.

Post-stream processing: the model used a tool, so we enter the tool-use path. The Read result (file contents with line numbers) is pushed to `toolResults`. A Haiku summary promise is kicked off in the background. State is reconstructed with the new messages, `transition: { reason: 'next_turn' }`, and the loop continues.

**Iteration 2: The model edits the file.**

Context management runs again (still under the threshold). The model streams: "I see the bug on line 42 -- `userId` can be null." It emits `Edit({ file_path: "src/auth/validate.ts", old_string: "const user = getUser(userId)", new_string: "if (!userId) return { error: 'unauthorized' }\nconst user = getUser(userId)" })`.

Edit is not concurrency-safe, so the streaming executor queues it until the response completes. Then the 14-step execution pipeline fires: Zod validation passes, input backfill expands the path, the PreToolUse hook checks permissions (the user approves), and the edit is applied. The pending Haiku summary from iteration 1 resolves during streaming -- its result is yielded as a `ToolUseSummaryMessage`. State is reconstructed, loop continues.

**Iteration 3: The model declares completion.**

The model streams: "I've fixed the null pointer bug by adding a guard clause." No `tool_use` blocks. We enter the "done" path. Prompt-too-long recovery? Not needed. Max output tokens? No. Stop hooks run -- no blocking errors. Token budget check passes. The loop returns `{ reason: 'completed' }`.

Total: three API calls, two tool executions, one user permission prompt. The loop handled streaming tool execution, Haiku summarization overlapping with the API call, and the full permission pipeline -- all through the same `while(true)` structure.

---

## Token Budgets

Users can request a token budget for a turn (e.g., `+500k`). The budget system decides whether to continue or stop after the model completes a response.

`checkTokenBudget` makes a binary continue/stop decision with three rules:

1. **Subagents always stop.** Budget is a top-level concept only.
2. **Completion threshold at 90%.** If `turnTokens < budget * 0.9`, continue.
3. **Diminishing returns detection.** After 3+ continuations, if both the current and previous delta are below 500 tokens, stop early. The model is producing less and less output per continuation.

When the decision is "continue," a nudge message is injected telling the model how much budget remains.

---

## Stop Hooks: Forcing the Model to Keep Working

Stop hooks run when the model finishes without requesting any tool use -- it thinks it is done. The hooks evaluate whether it actually *is* done.

The pipeline runs template job classification, fires background tasks (prompt suggestion, memory extraction), and then executes stop hooks proper. When a stop hook returns blocking errors -- "you said you were done, but the linter found 3 errors" -- the errors are appended to the message history and the loop continues with `stopHookActive: true`. This flag prevents re-running the same hooks on the retry.

When a stop hook signals `preventContinuation`, the loop exits immediately with `{ reason: 'stop_hook_prevented' }`.

---

## State Transitions: The Complete Catalog

Every exit from the loop is one of two types: a `Terminal` (the loop returns) or a `Continue` (the loop iterates).

### Terminal States (10 reasons)

| Reason | Trigger |
|--------|---------|
| `blocking_limit` | Token count at hard limit, auto-compact OFF |
| `image_error` | ImageSizeError, ImageResizeError, or unrecoverable media error |
| `model_error` | Unrecoverable API/model exception |
| `aborted_streaming` | User abort during model streaming |
| `prompt_too_long` | Withheld 413 after all recovery exhausted |
| `completed` | Normal completion (no tool use, or budget exhausted, or API error) |
| `stop_hook_prevented` | Stop hook explicitly blocked continuation |
| `aborted_tools` | User abort during tool execution |
| `hook_stopped` | PreToolUse hook stopped continuation |
| `max_turns` | Hit the `maxTurns` limit |

### Continue States (7 reasons)

| Reason | Trigger |
|--------|---------|
| `collapse_drain_retry` | Context collapse drained staged collapses on 413 |
| `reactive_compact_retry` | Reactive compact succeeded after 413 or media error |
| `max_output_tokens_escalate` | 8K cap hit, escalating to 64K |
| `max_output_tokens_recovery` | 64K still hit, multi-turn recovery (up to 3 attempts) |
| `stop_hook_blocking` | Stop hook returned blocking errors, must retry |
| `token_budget_continuation` | Token budget not exhausted, nudge message injected |
| `next_turn` | Normal tool-use continuation |

---

## Orphaned Tool Results: The Protocol Safety Net

The API protocol requires that every `tool_use` block is followed by a `tool_result`. The function `yieldMissingToolResultBlocks` creates error `tool_result` messages for every `tool_use` block that the model emitted but that never got a corresponding result. Without this safety net, a crash during streaming would leave orphaned `tool_use` blocks that would cause a protocol error on the next API call.

It fires in three places: the outer error handler (model crash), the fallback handler (model switch mid-stream), and the abort handler (user interruption). Each path has a different error message, but the mechanism is identical.

---

## Abort Handling: Two Paths

Aborts can happen at two points: during streaming and during tool execution. Each has distinct behavior.

**Abort during streaming**: The streaming executor (if active) drains remaining results, generating synthetic `tool_results` for queued tools. Without the executor, `yieldMissingToolResultBlocks` fills the gap. The `signal.reason` check distinguishes between a hard abort (Ctrl+C) and a submit-interrupt (user typed a new message) -- submit-interrupts skip the interruption message because the queued user message already provides context.

**Abort during tool execution**: Similar logic, with a `toolUse: true` parameter on the interruption message signaling to the UI that tools were in progress.

---

## The Thinking Rules

Claude's thinking/redacted_thinking blocks have three inviolable rules:

1. A message containing a thinking block must be part of a query whose `max_thinking_length > 0`
2. A thinking block may not be the last block in a message
3. Thinking blocks must be preserved for the duration of an assistant trajectory

Violating any of these produces opaque API errors. The code handles them in several places: the fallback handler strips signature blocks (which are model-bound), the compaction pipeline preserves the protected tail, and the microcompact layer never touches thinking blocks.

---

## Dependency Injection

The `QueryDeps` type is intentionally narrow -- four dependencies, not forty:

Four injected dependencies: the model caller, the compactor, the microcompactor, and a UUID generator. Tests pass `deps` into the loop params to inject fakes directly. Using `typeof fn` for the type definitions keeps the signatures in sync automatically. Alongside the mutable `State` and the injectable `QueryDeps`, an immutable `QueryConfig` is snapshotted once at `query()` entry -- feature flags, session state, and environment variables captured once and never re-read. The three-way separation (mutable state, immutable config, injectable deps) makes the loop testable and makes the eventual refactor to a pure `step(state, event, config)` reducer straightforward.

---

## Apply This: Building Your Own Agent Loop

**Use a generator, not callbacks.** The backpressure is free. The return value semantics are free. The composability via `yield*` is free. Agent loops are strictly forward-moving -- you never need to rewind or fork.

**Make state transitions explicit.** Reconstruct the full state object at every `continue` site. The verbosity is the feature -- it prevents partial-update bugs and makes each transition self-documenting.

**Withhold recoverable errors.** If your consumers disconnect on errors, do not yield errors until you know recovery has failed. Push them to an internal buffer, attempt recovery, and surface only on exhaustion.

**Layer your context management.** Light operations first (removal), heavy operations last (summarization). This preserves granular context when possible and falls back to monolithic summaries only when necessary.

**Add circuit breakers for every retry.** Every recovery mechanism in `query.ts` has an explicit limit: 3 auto-compact failures, 3 max-output recovery attempts, 1 reactive compact attempt. Without these limits, the first production session that triggers a retry-on-failure loop will burn your API budget overnight.

The minimal agent loop skeleton, if you are starting from scratch:

```
async function* agentLoop(params) {
  let state = initState(params)
  while (true) {
    const context = compressIfNeeded(state.messages)
    const response = await callModel(context)
    if (response.error) {
      if (canRecover(response.error, state)) { state = recoverState(state); continue }
      return { reason: 'error' }
    }
    if (!response.toolCalls.length) return { reason: 'completed' }
    const results = await executeTools(response.toolCalls)
    state = { ...state, messages: [...context, response.message, ...results] }
  }
}
```

Every feature in Claude Code's loop is an elaboration of one of these steps. The four compression layers elaborate step 3 (compress). The withholding pattern elaborates the model call. The escalation ladder elaborates error recovery. Stop hooks elaborate the "no tool use" exit. Start with this skeleton. Add each elaboration only when you hit the problem it solves.

---

## Summary

The agent loop is 1,730 lines of a single `while(true)` that does everything. It streams model responses, executes tools concurrently, compresses context through four layers, recovers from five categories of errors, tracks token budgets with diminishing returns detection, runs stop hooks that can force the model back to work, manages prefetch pipelines for memory and skills, and produces a typed discriminated union of exactly why it stopped.

It is the most important file in the system because it is the only file that touches every other subsystem. The context pipeline feeds into it. The tool system feeds out of it. The error recovery wraps around it. The hooks intercept it. The state layer persists through it. The UI renders from it.

If you understand `query()`, you understand Claude Code. Everything else is a peripheral.
