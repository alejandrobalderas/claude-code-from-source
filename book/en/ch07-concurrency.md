# Chapter 7: Concurrent Tool Execution

## The Cost of Waiting

Chapter 6 traced the lifecycle of a single tool call -- from the raw `tool_use` block in the API response through input validation, permission checks, execution, and result formatting. That pipeline handles one tool. But the model rarely requests just one.

A typical Claude Code interaction involves three to five tool calls per turn. "Read these two files, grep for this pattern, then edit this function." The model emits all of those in a single response. If each tool takes 200 milliseconds, running them sequentially costs a full second. If the Read and Grep calls are independent -- and they are -- running them in parallel cuts that to 200 milliseconds. Five-to-one improvement, free.

But not all tools are independent. An Edit that modifies `config.ts` cannot run concurrently with another Edit that modifies `config.ts`. A Bash command that creates a directory must complete before a Bash command that writes a file into that directory. Concurrency is not a global property of a tool. It is a property of a specific tool invocation with specific inputs.

This is the insight that drives the entire concurrency system: **safety is per-call, not per-tool-type**. `Bash("ls -la")` is safe to parallelize. `Bash("rm -rf build/")` is not. The same tool, different inputs, different concurrency classification. The system must inspect the input before deciding.

Claude Code implements two layers of concurrency optimization. The first is **batch orchestration**: after the model's response is fully received, partition the tool calls into concurrent and serial groups, then execute each group appropriately. The second is **speculative execution**: start running tools *while the model is still streaming its response*, harvesting results before the response is even complete. Together, these two mechanisms eliminate most of the wall-clock time that would otherwise be spent waiting.

---

## The Partition Algorithm

The entry point is `partitionToolCalls()` in `toolOrchestration.ts`. It takes an ordered array of `ToolUseBlock` messages and produces an array of batches, where each batch is either "all concurrent-safe" or "a single serial tool."

```typescript
// Pseudocode — illustrates the partition algorithm
type Group = { parallel: boolean; calls: ToolCall[] }

function groupBySafety(calls: ToolCall[], registry: ToolRegistry): Group[] {
  return calls.reduce((groups, call) => {
    const def = registry.lookup(call.name)
    const input = def?.schema.safeParse(call.input)
    // Fail-closed: parse failure or exception → serial
    const safe = input?.success
      ? tryCatch(() => def.isParallelSafe(input.data), false)
      : false
    // Merge consecutive safe calls into one group
    if (safe && groups.at(-1)?.parallel) {
      groups.at(-1)!.calls.push(call)
    } else {
      groups.push({ parallel: safe, calls: [call] })
    }
    return groups
  }, [] as Group[])
}
```

The algorithm walks the array left to right. For each tool call:

1. **Look up the tool definition** by name.
2. **Parse the input** with the tool's Zod schema via `safeParse()`. If parsing fails, the tool is conservatively classified as not concurrency-safe.
3. **Call `isConcurrencySafe(parsedInput)`** on the tool definition. This is where per-input classification happens. The Bash tool parses the command string, checks if every subcommand is read-only (`ls`, `grep`, `cat`, `git status`), and returns `true` only if the entire compound command is a pure read. The Read tool always returns `true`. The Edit tool always returns `false`. The call is wrapped in try-catch -- if `isConcurrencySafe` throws (say, the Bash command string can't be parsed by the shell-quote library), the tool defaults to serial.
4. **Merge or create a batch.** If the current tool is concurrency-safe AND the most recent batch is also concurrency-safe, append to that batch. Otherwise, start a new batch.

The result is a sequence of batches that alternates between concurrent groups and individual serial entries. Walk through a concrete example:

```
Model requests: [Read, Read, Grep, Edit, Read]

Step 1: Read  → concurrent-safe → new batch {safe, [Read]}
Step 2: Read  → concurrent-safe → append   {safe, [Read, Read]}
Step 3: Grep  → concurrent-safe → append   {safe, [Read, Read, Grep]}
Step 4: Edit  → NOT safe        → new batch {serial, [Edit]}
Step 5: Read  → concurrent-safe → new batch {safe, [Read]}

Result: 3 batches
  Batch 1: [Read, Read, Grep]  — run concurrently
  Batch 2: [Edit]              — run alone
  Batch 3: [Read]              — run concurrently (just one tool)
```

The partitioning is greedy and order-preserving. Consecutive safe tools accumulate into a single batch. Any unsafe tool breaks the run and starts a new batch. This means the order in which the model emits tool calls matters -- if it interleaves a Write between two Reads, you get three batches instead of two. In practice, models tend to cluster their reads together, which is the common case the algorithm is optimized for.

---

## Batch Execution

The `runTools()` generator iterates through the partitioned batches and dispatches each one to the appropriate executor.

### Concurrent Batches

For a concurrent batch, `runToolsConcurrently()` fires all tools in parallel using an `all()` utility that caps active generators at the concurrency limit:

```typescript
// Pseudocode — illustrates the concurrent dispatch pattern
async function* dispatchParallel(calls, context) {
  yield* boundedAll(
    calls.map(async function* (call) {
      context.markInProgress(call.id)
      yield* executeSingle(call, context)
      context.markComplete(call.id)
    }),
    MAX_CONCURRENCY,  // Default: 10
  )
}
```

The concurrency limit defaults to 10, configurable via `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY`. Ten is generous -- you rarely see more than five or six tool calls in a single model response. The limit exists as a safety valve for pathological cases, not as a typical constraint.

The `all()` utility is a generator-aware variant of `Promise.all` with bounded concurrency. It starts up to N generators simultaneously, yields results from whichever completes first, and starts the next queued generator as each one finishes. The mechanics are similar to a semaphore-guarded task pool, but adapted for async generators that yield intermediate results.

**Context modifier queuing** is the subtle part. Some tools produce *context modifiers* -- functions that transform the `ToolUseContext` for subsequent tools. When tools run concurrently, you cannot apply these modifiers immediately because other tools in the same batch are reading the same context. Instead, modifiers are collected in a map keyed by tool use ID:

```typescript
const queuedContextModifiers: Record<
  string,
  ((context: ToolUseContext) => ToolUseContext)[]
> = {}
```

After the entire concurrent batch finishes, the modifiers are applied in tool-order (not completion-order), preserving deterministic context evolution:

```typescript
for (const block of blocks) {
  const modifiers = queuedContextModifiers[block.id]
  if (!modifiers) continue
  for (const modifier of modifiers) {
    currentContext = modifier(currentContext)
  }
}
```

In practice, none of the current concurrency-safe tools produce context modifiers -- the comment in the codebase acknowledges this explicitly. But the infrastructure exists because tools can be added by MCP servers, and a custom read-only MCP tool might legitimately want to modify context (updating a "files seen" set, for instance).

### Serial Batches

Serial execution is straightforward. Each tool runs, its context modifiers are applied immediately, and the next tool sees the updated context:

```typescript
for (const toolUse of toolUseMessages) {
  for await (const update of runToolUse(toolUse, /* ... */)) {
    if (update.contextModifier) {
      currentContext = update.contextModifier.modifyContext(currentContext)
    }
    yield { message: update.message, newContext: currentContext }
  }
}
```

This is the critical difference. Serial tools can change the world for subsequent tools. An Edit modifies a file; the next Read sees the modified version. A Bash command creates a directory; the next Bash command writes into it. Context modifiers are the formalization of this dependency: they let a tool say "the execution environment has changed, here's how."

---

## The Streaming Tool Executor

Batch orchestration eliminates unnecessary serialization *after* the model's response arrives. But there is a bigger opportunity: the model's response takes time to stream. A typical multi-tool response might take 2-3 seconds to fully arrive. The first tool call is parseable after 500 milliseconds. Why wait for the remaining 2 seconds?

The `StreamingToolExecutor` class implements speculative execution. As the model streams its response, each `tool_use` block is handed to the executor the moment it is fully parsed. The executor starts running it immediately -- while the model is still generating the next tool call. By the time the response finishes streaming, several tools may have already completed.

```mermaid
gantt
    title Sequential vs Streaming Tool Execution
    dateFormat X
    axisFormat %Ls

    section Sequential
    Model streams response     :a1, 0, 2500
    Tool 1 (0.2s)              :a2, after a1, 200
    Tool 2 (0.3s)              :a3, after a2, 300
    Tool 3 (0.1s)              :a4, after a3, 100

    section Streaming Executor
    Model streams response     :b1, 0, 2500
    Tool 1 starts at 0.5s      :b2, 500, 700
    Tool 2 starts at 1.2s      :b3, 1200, 1500
    Tool 3 drain after stream  :b4, 2500, 2600
```

Sequential total: 3.1s. Streaming total: 2.6s -- tools 1 and 2 completed during streaming, saving 16% of wall-clock time.

The savings compound. When the model requests five read-only tools and the response takes 3 seconds to stream, all five tools can start and finish during that 3 seconds. The post-stream drain phase has nothing left to do. The user sees results almost immediately after the last character of the model's response appears.

### Tool Lifecycle

Each tool tracked by the executor progresses through four states:

```mermaid
stateDiagram-v2
    queued --> executing: concurrency check passes
    executing --> completed: call() finishes
    completed --> yielded: results emitted in order
```

- **queued**: The `tool_use` block has been parsed and registered. Waiting for concurrency conditions to allow execution.
- **executing**: The tool's `call()` function is running. Results accumulate in a buffer.
- **completed**: Execution finished. Results are ready to be yielded to the conversation.
- **yielded**: Results have been emitted. Terminal state.

### addTool(): Queuing During the Stream

```typescript
addTool(block: ToolUseBlock, assistantMessage: AssistantMessage): void
```

Called by the streaming response parser each time a complete `tool_use` block arrives. The method:

1. Looks up the tool definition. If not found, immediately creates a `completed` entry with an error message -- no point in queuing a tool that does not exist.
2. Parses the input and determines `isConcurrencySafe` using the same logic as `partitionToolCalls()`.
3. Pushes a `TrackedTool` with status `'queued'`.
4. Calls `processQueue()` -- which may start the tool immediately.

The call to `processQueue()` is fire-and-forget (`void this.processQueue()`). The executor does not await it. This is intentional: `addTool()` is called from the streaming parser's event handler, and blocking there would stall response parsing. The tool starts executing in the background while the parser continues consuming the stream.

### processQueue(): The Admission Check

The admission check is a single predicate:

```typescript
// Pseudocode — illustrates the mutual exclusion rule
canRun = noToolsRunning || (newToolIsSafe && allRunningAreSafe)
```

A tool can start executing if and only if:
- **No tools are currently executing** (the queue is empty), OR
- **Both the new tool and all currently executing tools are concurrency-safe.**

This is a mutual exclusion contract. A non-concurrent tool requires exclusive access -- nothing else can be running. Concurrent tools can share the runway with other concurrent tools, but a single non-concurrent tool in the executing set blocks everyone.

The `processQueue()` method iterates through all tools in order. For each queued tool, it checks `canExecuteTool()`. If the tool can run, it starts. If a non-concurrent tool cannot run yet, the loop *breaks* -- it stops checking subsequent tools entirely, because non-concurrent tools must maintain ordering. If a concurrent tool cannot run (blocked by an executing non-concurrent tool), the loop *continues* -- but in practice this rarely helps, because concurrent tools after a non-concurrent blocker are typically dependent on its results anyway.

### executeTool(): The Core Execution Loop

This method is where the real complexity lives. It manages abort controllers, error cascades, progress reporting, and context modifiers.

**Child abort controllers.** Each tool gets its own `AbortController` that is a child of a shared sibling-level controller.

The hierarchy is three levels deep: the query-level controller (owned by the REPL, fires on user Ctrl+C) parents the sibling controller (owned by the streaming executor, fires on Bash errors) which parents each tool's individual controller. Aborting the sibling controller kills all running tools. Aborting a tool's individual controller kills only that tool -- but it also bubbles up to the query controller if the abort reason is not a sibling error. This bubble-up prevents the system from silently discarding the executor when, for example, a permission denial should end the entire turn.

This bubble-up is essential for permission denial. When a user rejects a tool in the permission dialog, the tool's abort controller fires. That signal must reach the query loop so it can end the turn. Without it, the query loop would continue as if nothing happened, sending a stale rejection message to the model.

**The sibling error cascade.** When a tool produces an error result, the executor checks whether to cancel sibling tools. The rule: **only Bash errors cascade.** When a shell command errors, the executor records the failure, captures a description of the errored tool, and aborts the sibling controller -- which cancels all other running tools in the batch.

The rationale is pragmatic. Bash commands often form implicit dependency chains: `mkdir build && cp src/* build/ && tar -czf dist.tar.gz build/`. If `mkdir` fails, running `cp` and `tar` is pointless. Canceling siblings immediately saves time and avoids confusing error messages.

Read and Grep errors, by contrast, are independent. If one file read fails because the file was deleted, that has no bearing on a concurrent grep searching a different directory. Canceling the grep would waste work for no reason.

The error cascade produces synthetic error messages for sibling tools:

```
Cancelled: parallel tool call Bash(mkdir build) errored
```

The description includes the first 40 characters of the errored tool's command or file path, giving the model enough context to understand what went wrong.

**Progress messages** are handled separately from results. While results are buffered and yielded in order, progress messages (status updates like "Reading file..." or "Searching...") go to a `pendingProgress` array and are yielded immediately via `getCompletedResults()`. A resolve callback wakes up the `getRemainingResults()` loop when new progress arrives, preventing the UI from appearing frozen during long-running tools.

**Queue re-processing.** After each tool completes, `processQueue()` is called again:

```typescript
void promise.finally(() => {
  void this.processQueue()
})
```

This is how serial tools that were blocked by a concurrent batch get started. When the last concurrent tool finishes, the subsequent non-concurrent tool's `canExecuteTool()` check passes, and it begins executing.

### Result Harvesting

The streaming executor exposes two harvesting methods, designed for two different phases of the response lifecycle.

**`getCompletedResults()` -- mid-stream harvesting.** This is a synchronous generator called between chunks of the streaming API response. It walks the tools array in order and yields results for any tools that have completed:

`getCompletedResults()` is a synchronous generator that walks the tools array in submission order. For each tool, it first drains any pending progress messages. If the tool is completed, it yields the results and marks it as yielded. The critical rule: if a non-concurrent tool is still executing, the walk **breaks** -- nothing after it can be yielded, even if subsequent tools have already completed. Results after a serial tool might depend on its context modifications, so they must wait. For concurrent tools, this restriction does not apply; the loop skips executing concurrent tools and continues checking subsequent entries.

This break is the order-preservation mechanism. If a non-concurrent tool is still executing, nothing after it can be yielded -- even if subsequent tools have already completed. Results after a serial tool might depend on its context modifications, so they must wait. For concurrent tools, this restriction does not apply; the loop skips executing concurrent tools and continues checking subsequent entries.

**`getRemainingResults()` -- post-stream drain.** Called after the model's response is fully received. This async generator loops until every tool is yielded:

`getRemainingResults()` is the post-stream drain. It loops until every tool is yielded. On each iteration, it processes the queue (starting any newly-unblocked tools), yields any completed results via `getCompletedResults()`, and then -- if tools are still executing but nothing new has completed -- uses `Promise.race` to idle-wait on whichever finishes first: any executing tool's promise, or a progress-available signal. This avoids busy-polling while still waking up the moment something happens. When no tools have completed and nothing new can start, the executor waits for any executing tool to finish (or for progress to arrive). This avoids busy-polling while still waking up the moment something happens.

### Order Preservation

Results are yielded in the order tools were *received*, not the order they *completed*. This is a deliberate design choice.

Consider a model response that requests `[Read("a.ts"), Read("b.ts"), Read("c.ts")]`. All three start concurrently. `c.ts` finishes first (it is smaller), then `a.ts`, then `b.ts`. If results were yielded in completion order, the conversation would show:

```
Tool result: c.ts contents
Tool result: a.ts contents
Tool result: b.ts contents
```

But the model emitted them in a-b-c order. The conversation history must match the model's expectation, or the next turn will be confused about which result corresponds to which request. By yielding in arrival order, the conversation stays coherent:

```
Tool result: a.ts contents  (completed second, yielded first)
Tool result: b.ts contents  (completed third, yielded second)
Tool result: c.ts contents  (completed first, yielded third)
```

The cost is minor: if tool 1 is slow and tools 2-5 are fast, the fast results sit in buffers until tool 1 finishes. But the alternative -- conversation incoherence -- is far worse.

### discard(): The Streaming Fallback Escape Hatch

When the API response stream fails mid-way (network error, server disconnect), the system retries with a new API call. But the streaming executor may have already started tools from the failed attempt. Those results are now orphaned -- they correspond to a response that was never fully received.

```typescript
discard(): void {
  this.discarded = true
}
```

Setting `discarded = true` causes:
- `getCompletedResults()` returns immediately with no results.
- `getRemainingResults()` returns immediately with no results.
- Any tool that starts executing checks `getAbortReason()`, sees `streaming_fallback`, and gets a synthetic error instead of actually running.

The discarded executor is abandoned. A fresh executor is created for the retry attempt.

---

## Tool Concurrency Properties

Each built-in tool declares its concurrency characteristics through the `isConcurrencySafe()` method. The classification is not arbitrary -- it reflects the tool's actual effect on shared state.

| Tool | Concurrency Safe | Condition | Rationale |
|------|-----------------|-----------|-----------|
| **Read** | Always | -- | Pure read. No side effects. |
| **Grep** | Always | -- | Pure read. Wraps ripgrep. |
| **Glob** | Always | -- | Pure read. File listing. |
| **Fetch** | Always | -- | HTTP GET. No local side effects. |
| **WebSearch** | Always | -- | API call to search provider. |
| **Bash** | Sometimes | Read-only commands only | `isReadOnly()` parses the command and classifies subcommands. `ls`, `git status`, `cat`, `grep` are safe. `rm`, `mkdir`, `mv` are not. |
| **Edit** | Never | -- | Modifies files. Two concurrent edits to the same file corrupt it. |
| **Write** | Never | -- | Creates or overwrites files. Same corruption risk. |
| **NotebookEdit** | Never | -- | Modifies `.ipynb` files. |

The Bash tool's classification deserves elaboration. It uses `splitCommandWithOperators()` to decompose compound commands (`&&`, `||`, `;`, `|`), then classifies each subcommand against known-safe sets:

- **Search commands**: `grep`, `rg`, `find`, `fd`, `ag`, `ack`
- **Read commands**: `cat`, `head`, `tail`, `wc`, `jq`, `less`, `file`, `stat`
- **List commands**: `ls`, `tree`, `du`, `df`
- **Neutral commands**: `echo`, `printf` (no side effects but not "reads")

A compound command is read-only only if every non-neutral subcommand is in the search, read, or list set. `ls -la && cat README.md` is safe. `ls -la && rm -rf build/` is not -- the `rm` contaminates the entire command.

---

## The Interrupt Behavior Contract

While tools are executing, the user can type a new message. What should happen? The answer depends on the tool.

Each tool declares an `interruptBehavior()` method that returns either `'cancel'` or `'block'`:

- **`'cancel'`**: Stop the tool immediately, discard partial results, and process the new user message. Used by tools where partial execution is harmless (reads, searches).
- **`'block'`**: Keep the tool running to completion. The user's new message waits. Used by tools where interruption would leave the system in an inconsistent state (writes mid-flight, long-running bash commands). This is the default.

The streaming executor tracks the interruptible state of the current tool set:

The interruptible state is updated by checking all currently executing tools: the set is interruptible only when every executing tool supports cancellation. If even one tool's interrupt behavior is `'block'`, the entire set is treated as non-interruptible.

The UI only shows an "interruptible" indicator when ALL executing tools support cancellation. If even one tool is `'block'`, the entire set is treated as non-interruptible. This is conservative but correct: you cannot meaningfully interrupt a batch where one tool would keep running anyway.

When the user does interrupt and all tools are cancellable, the abort controller fires with reason `'interrupt'`. The executor's `getAbortReason()` method checks each tool's interrupt behavior individually -- a `'cancel'` tool gets a synthetic `user_interrupted` error, while a `'block'` tool (which would not be present in a fully interruptible set, but the code handles the edge case) continues running.

---

## Context Modifiers: The Serial-Only Contract

Context modifiers are functions of type `(context: ToolUseContext) => ToolUseContext`. They let a tool say "I've changed something about the execution environment that subsequent tools need to know about."

The contract is simple: **context modifiers are only applied for serial (non-concurrent-safe) tools.** This is stated explicitly in the source:

```typescript
// NOTE: we currently don't support context modifiers for concurrent
//       tools. None are actively being used, but if we want to use
//       them in concurrent tools, we need to support that here.
if (!tool.isConcurrencySafe && contextModifiers.length > 0) {
  for (const modifier of contextModifiers) {
    this.toolUseContext = modifier(this.toolUseContext)
  }
}
```

In the batch orchestration path (`toolOrchestration.ts`), concurrent batch modifiers are collected and applied after the batch completes, in tool-submission order. This means concurrent tools within a batch cannot see each other's context changes, but the batch after them can.

The asymmetry is intentional. If Tool A modifies context and Tool B reads that context, they have a data dependency. Data dependencies mean they cannot run concurrently. By definition, if two tools are concurrency-safe, neither should depend on the other's context modifications. The system enforces this by deferring application.

---

## Apply This

The concurrency patterns in Claude Code generalize to any system that orchestrates multiple independent operations. Three principles are worth extracting.

**Partition by safety, not by type.** The `isConcurrencySafe(input)` method receives the parsed input, not just the tool name. This per-invocation classification is more precise than a static "this tool type is always safe" declaration. In your own systems, inspect the operation's arguments before deciding whether to parallelize. A database read is safe to parallelize; a database write to the same row is not. The operation type alone does not tell you enough.

**Speculative execution during I/O waits.** The streaming executor starts tools while the API response is still arriving. The same pattern applies anywhere you have a slow producer and fast consumers: start processing early items while later items are still being generated. HTTP/2 server push, compiler pipeline parallelism, and speculative CPU execution all share this structure. The key requirement is that you can identify independent work before the full instruction set is available.

**Preserve submission order in results.** Yielding results in completion order is tempting -- it minimizes latency to first result. But if the consumer (in this case, the language model) expects results in a specific order, reordering them creates confusion that costs more time to resolve than the latency savings. Buffer completed results and release them in the order they were requested. The implementation cost is a simple array walk; the correctness benefit is absolute.

The streaming executor pattern is particularly powerful for agent systems. Any time your agent loop involves a "think, then act" cycle where the thinking phase produces multiple independent actions, you can overlap the tail of thinking with the beginning of acting. The savings are proportional to the ratio of think-time to act-time. For language model agents, where think-time (API response generation) dominates, the savings are substantial.

---

## Summary

Claude Code's concurrency system operates at two levels. The partition algorithm (`partitionToolCalls`) groups consecutive concurrency-safe tools into batches that run in parallel, while isolating unsafe tools into serial batches where each tool sees the effects of the one before it. The streaming tool executor (`StreamingToolExecutor`) goes further, starting tools speculatively as they arrive during model response streaming, overlapping tool execution with response generation.

The safety model is conservative by design. Concurrency safety is determined per-invocation by inspecting parsed inputs. Unknown tools default to serial. Parsing failures default to serial. Exceptions in safety checks default to serial. The system never guesses that something is safe to parallelize -- the tool must affirmatively declare it.

Error handling follows the dependency structure of the tools. Bash errors cascade to siblings because shell commands often form implicit pipelines. Read and search errors are isolated because they are independent operations. The abort controller hierarchy -- query controller, sibling controller, per-tool controller -- gives each level the ability to cancel its scope without disrupting the level above.

The result is a system that extracts maximum parallelism from the model's tool requests while maintaining the invariant that the conversation history reflects a coherent, ordered sequence of actions. The model sees results in the order it requested them. The user sees tools complete as fast as the underlying operations allow. The gap between those two -- execution speed vs. presentation order -- is bridged by buffering, and that buffer is the simplest part of the entire system.
