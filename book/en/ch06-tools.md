# Chapter 6: Tools -- From Definition to Execution

## The Nervous System

Chapter 5 showed you the agent loop -- the `while(true)` that streams model responses, collects tool calls, and feeds results back. The loop is the heartbeat. But the heartbeat is meaningless without the nervous system that translates "the model wants to run `git status`" into an actual shell command, with permission checks, result budgeting, and error handling.

The tool system is that nervous system. It spans 40+ tool implementations, a centralized registry with feature-flag gating, a 14-step execution pipeline, a permission resolver with seven modes, and a streaming executor that starts tools before the model finishes its response.

Every tool call in Claude Code -- every file read, every shell command, every grep, every sub-agent dispatch -- flows through the same pipeline. The uniformity is the point: whether the tool is a built-in Bash executor or a third-party MCP server, it gets the same validation, the same permission checks, the same result budgeting, the same error classification.

The `Tool` interface has approximately 45 members. That sounds overwhelming, but only five matter for understanding how the system works:

1. **`call()`** -- execute the tool
2. **`inputSchema`** -- validate and parse the input
3. **`isConcurrencySafe()`** -- can this run in parallel?
4. **`checkPermissions()`** -- is this allowed?
5. **`validateInput()`** -- does this input make semantic sense?

Everything else -- the 12 rendering methods, the analytics hooks, the search hints -- exists to support the UI and telemetry layers. Start with the five, and the rest falls into place.

---

## The Tool Interface

### Three Type Parameters

Every tool is parameterized over three types:

```typescript
Tool<Input extends AnyObject, Output, P extends ToolProgressData>
```

`Input` is a Zod object schema that serves double duty: it generates the JSON Schema sent to the API (so the model knows what parameters to provide), and it validates the model's response at runtime via `safeParse`. `Output` is the TypeScript type of the tool's result. `P` is the progress event type the tool emits while running -- BashTool emits stdout chunks, GrepTool emits match counts, AgentTool emits sub-agent transcripts.

### buildTool() and Fail-Closed Defaults

No tool definition directly constructs a `Tool` object. Every tool passes through `buildTool()`, a factory that spreads a defaults object under the tool-specific definition:

```typescript
// Pseudocode — illustrates the fail-closed defaults pattern
const SAFE_DEFAULTS = {
  isEnabled:         () => true,
  isParallelSafe:    () => false,   // Fail-closed: new tools run serially
  isReadOnly:        () => false,   // Fail-closed: treated as writes
  isDestructive:     () => false,
  checkPermissions:  (input) => ({ behavior: 'allow', updatedInput: input }),
}

function buildTool(definition) {
  return { ...SAFE_DEFAULTS, ...definition }  // Definition overrides defaults
}
```

The defaults are deliberately fail-closed where it matters for safety. A new tool that forgets to implement `isConcurrencySafe` defaults to `false` -- it runs serially, never in parallel. A tool that forgets `isReadOnly` defaults to `false` -- the system treats it as a write operation. A tool that forgets `toAutoClassifierInput` returns an empty string -- the auto-mode security classifier skips it, which means the general permission system handles it instead of an automated bypass.

The one default that is *not* fail-closed is `checkPermissions`, which returns `allow`. This seems backwards until you understand the layered permission model: `checkPermissions` is tool-specific logic that runs *after* the general permission system has already evaluated rules, hooks, and mode-based policies. A tool returning `allow` from `checkPermissions` is saying "I have no tool-specific objection" -- it is not granting blanket access. The grouping into sub-objects (`options`, named fields like `readFileState`) provides the structure that focused interfaces would provide, without the ceremony of declaring, implementing, and threading five separate interface types through 40+ call sites.

### Concurrency Is Input-Dependent

The signature `isConcurrencySafe(input: z.infer<Input>): boolean` takes the parsed input because the same tool can be safe for some inputs and unsafe for others. BashTool is the canonical example: `ls -la` is read-only and concurrency-safe, but `rm -rf /tmp/build` is not. The tool parses the command, classifies each subcommand against known-safe sets, and returns `true` only when every non-neutral part is a search or read operation.

### The ToolResult Return Type

Every `call()` returns a `ToolResult<T>`:

```typescript
type ToolResult<T> = {
  data: T
  newMessages?: (UserMessage | AssistantMessage | AttachmentMessage | SystemMessage)[]
  contextModifier?: (context: ToolUseContext) => ToolUseContext
}
```

`data` is the typed output that gets serialized into the API's `tool_result` content block. `newMessages` lets a tool inject additional messages into the conversation -- AgentTool uses this to append sub-agent transcripts. `contextModifier` is a function that mutates the `ToolUseContext` for subsequent tools -- this is how `EnterPlanMode` switches the permission mode. Context modifiers are only honored for non-concurrency-safe tools; if your tool runs in parallel, its modifier is queued until the batch completes.

---

## ToolUseContext: The God Object

`ToolUseContext` is the massive context bag threaded through every tool call. It has approximately 40 fields. It is, by any reasonable definition, a god object. It exists because the alternative is worse.

A tool like BashTool needs the abort controller, the file state cache, the app state, the message history, the tool set, MCP connections, and half a dozen UI callbacks. Threading these as individual parameters would produce function signatures with 15+ arguments. The pragmatic solution is a single context object, grouped by concern:

**Configuration** (`options` sub-object): The tool set, model name, MCP connections, debug flags. Set once at query start, mostly immutable.

**Execution state**: The `abortController` for cancellation, `readFileState` for the LRU file cache, `messages` for the full conversation history. These change during execution.

**UI callbacks**: `setToolJSX`, `addNotification`, `requestPrompt`. Only wired in interactive (REPL) contexts. SDK and headless modes leave them undefined.

**Agent context**: `agentId`, `renderedSystemPrompt` (frozen parent prompt for fork sub-agents -- re-rendering could diverge due to feature flag warm-up and bust the cache).

The sub-agent variant of `ToolUseContext` is particularly revealing. When `createSubagentContext()` builds a context for a child agent, it makes deliberate choices about which fields to share and which to isolate: `setAppState` becomes a no-op for async agents, `localDenialTracking` gets a fresh object, `contentReplacementState` is cloned from the parent. Each choice encodes a lesson learned from a production bug.

---

## The Registry

### getAllBaseTools(): The Single Source of Truth

The function `getAllBaseTools()` returns the exhaustive list of every tool that could exist in the current process. Always-present tools come first, then conditionally-included tools gated by feature flags:

```typescript
const SleepTool = feature('PROACTIVE') || feature('KAIROS')
  ? require('./tools/SleepTool/SleepTool.js').SleepTool
  : null
```

The `feature()` import from `bun:bundle` is resolved at bundle time. When `feature('AGENT_TRIGGERS')` is statically false, the bundler eliminates the entire `require()` call -- dead code elimination that keeps the binary small.

### assembleToolPool(): Merging Built-in and MCP Tools

The final tool set that reaches the model comes from `assembleToolPool()`:

1. Get built-in tools (with deny-rule filtering, REPL mode hiding, and `isEnabled()` checks)
2. Filter MCP tools by deny rules
3. Sort each partition alphabetically by name
4. Concatenate built-ins (prefix) + MCP tools (suffix)

The sort-then-concatenate approach is not aesthetic preference. The API server places a prompt-cache breakpoint after the last built-in tool. A flat sort across all tools would interleave MCP tools into the built-in list, and adding or removing an MCP tool would shift built-in tool positions, invalidating the cache.

---

## The 14-Step Execution Pipeline

The function `checkPermissionsAndCallTool()` is where intent becomes action. Every tool call passes through these 14 steps.

```mermaid
graph TD
    S1[1. Tool Lookup] --> S2[2. Abort Check]
    S2 --> S3[3. Zod Validation]
    S3 -->|Fails| ERR1[Input validation error]
    S3 -->|Passes| S4[4. Semantic Validation]
    S4 -->|Fails| ERR2[Tool-specific error]
    S4 -->|Passes| S5[5. Speculative Classifier Start]
    S5 --> S6[6. Input Backfill - clone, not mutate]
    S6 --> S7[7. PreToolUse Hooks]
    S7 -->|Hook denies| ERR3[Hook rejection]
    S7 -->|Hook stops| STOP[Abort execution]
    S7 -->|Passes| S8[8. Permission Resolution]
    S8 --> S9{9. Permission Denied?}
    S9 -->|Yes| ERR4[Permission denied result]
    S9 -->|No| S10[10. Tool Execution]
    S10 --> S11[11. Result Budgeting]
    S11 --> S12[12. PostToolUse Hooks]
    S12 --> S13[13. New Messages]
    S13 --> S14[14. Error Handling]
    S14 --> DONE[Tool Result → Conversation History]

    S10 -->|Throws| S14

    style ERR1 fill:#f66
    style ERR2 fill:#f66
    style ERR3 fill:#f66
    style ERR4 fill:#f66
    style STOP fill:#f66
```

### Steps 1-4: Validation

**Tool Lookup** falls back to `getAllBaseTools()` for alias matches, handling transcripts from older sessions where a tool was renamed. **Abort Check** prevents wasted computation on tool calls queued before Ctrl+C propagated. **Zod Validation** catches type mismatches; for deferred tools, the error appends a hint to call ToolSearch first. **Semantic Validation** goes beyond schema conformance -- FileEditTool rejects no-op edits, BashTool blocks standalone `sleep` when MonitorTool is available.

### Steps 5-6: Preparation

**Speculative Classifier Start** kicks off the auto-mode security classifier in parallel for Bash commands, shaving hundreds of milliseconds off the common path. **Input Backfill** clones the parsed input and adds derived fields (expanding `~/foo.txt` to absolute paths) for hooks and permissions, preserving the original for transcript stability.

### Steps 7-9: Permission

**PreToolUse Hooks** are the extension mechanism -- they can make permission decisions, modify inputs, inject context, or stop execution entirely. **Permission Resolution** bridges hooks and the general permission system: if a hook already decided, that is final; otherwise `canUseTool()` triggers rule matching, tool-specific checks, mode-based defaults, and interactive prompts. **Permission Denied Handling** builds an error message and executes `PermissionDenied` hooks.

### Steps 10-14: Execution and Cleanup

**Tool Execution** runs the actual `call()` with the original input. **Result Budgeting** persists oversized output to `~/.claude/tool-results/{hash}.txt` and replaces it with a preview. **PostToolUse Hooks** can modify MCP output or block continuation. **New Messages** are appended (sub-agent transcripts, system reminders). **Error Handling** classifies errors for telemetry, extracts safe strings from potentially mangled names, and emits OTel events.

---

## The Permission System

### Seven Modes

| Mode | Behavior |
|------|----------|
| `default` | Tool-specific checks; prompt user for unrecognized operations |
| `acceptEdits` | Auto-allow file edits; prompt for other operations |
| `plan` | Read-only -- deny all write operations |
| `dontAsk` | Auto-deny anything that would normally prompt (background agents) |
| `bypassPermissions` | Allow everything without prompting |
| `auto` | Use the transcript classifier to decide (feature-flagged) |
| `bubble` | Internal mode for sub-agents that escalate to the parent |

### The Resolution Chain

When a tool call reaches permission resolution:

1. **Hook decision**: If a PreToolUse hook already returned `allow` or `deny`, that is final.
2. **Rule matching**: Three rule sets -- `alwaysAllowRules`, `alwaysDenyRules`, `alwaysAskRules` -- match on tool name and optional content patterns. `Bash(git *)` matches any Bash command starting with `git`.
3. **Tool-specific check**: The tool's `checkPermissions()` method. Most return `passthrough`.
4. **Mode-based default**: `bypassPermissions` allows everything. `plan` denies writes. `dontAsk` denies prompts.
5. **Interactive prompt**: In `default` and `acceptEdits` modes, unresolved decisions show a prompt.
6. **Auto-mode classifier**: A two-stage classifier (fast model, then extended thinking for ambiguous cases).

The `safetyCheck` variant has a `classifierApprovable` boolean: `.claude/` and `.git/` edits are `classifierApprovable: true` (unusual but sometimes legitimate), while Windows path bypass attempts are `classifierApprovable: false` (almost always adversarial).

### Permission Rules and Matching

Permission rules are stored as `PermissionRule` objects with three parts: a `source` tracing provenance (userSettings, projectSettings, localSettings, cliArg, policySettings, session, etc.), a `ruleBehavior` (allow, deny, ask), and a `ruleValue` with the tool name and optional content pattern.

The `ruleContent` field enables fine-grained matching. `Bash(git *)` allows any Bash command starting with `git`. `Edit(/src/**)` allows edits only within `/src`. `Fetch(domain:example.com)` allows fetching from a specific domain. Rules without `ruleContent` match all invocations of that tool.

BashTool's permission matcher parses the command via `parseForSecurity()` (a bash AST parser) and splits compound commands into subcommands. If AST parsing fails (complex syntax with heredocs or nested subshells), the matcher returns `() => true` -- fail-safe, meaning the hook always runs. The assumption is that if the command is too complex to parse, it is too complex to confidently exclude from safety checks.

### Bubble Mode for Sub-Agents

Sub-agents in coordinator-worker patterns cannot show permission prompts -- they have no terminal. The `bubble` mode causes permission requests to propagate up to the parent context. The coordinator agent, running in the main thread with terminal access, handles the prompt and sends the decision back down.

---

## Tool Deferred Loading

Tools with `shouldDefer: true` are sent to the API with `defer_loading: true` -- names and descriptions but not full parameter schemas. This reduces initial prompt size. To use a deferred tool, the model must first call `ToolSearchTool` to load its schema. The failure mode is instructive: calling a deferred tool without loading it causes Zod validation to fail (all typed parameters arrive as strings), and the system appends a targeted recovery hint.

Deferred loading also improves cache hit rates: tools sent with `defer_loading: true` contribute only their name to the prompt, so adding or removing a deferred MCP tool changes the prompt by a few tokens rather than hundreds.

---

## Result Budgeting

### Per-Tool Size Limits

Each tool declares `maxResultSizeChars`:

| Tool | maxResultSizeChars | Rationale |
|------|-------------------|-----------|
| BashTool | 30,000 | Enough for most useful output |
| FileEditTool | 100,000 | Diffs can be large but the model needs them |
| GrepTool | 100,000 | Search results with context lines add up fast |
| FileReadTool | Infinity | Self-bounds via its own token limits; persisting would create circular Read loops |

When a result exceeds the threshold, the full content is saved to disk and replaced with a `<persisted-output>` wrapper containing a preview and file path. The model can then use `Read` to access the full output if needed.

### Per-Conversation Aggregate Budget

Beyond per-tool limits, `ContentReplacementState` tracks an aggregate budget across the entire conversation, preventing death by a thousand cuts -- many tools each returning 90% of their individual limit can still overwhelm the context window.

---

## Individual Tool Highlights

### BashTool: The Most Complex Tool

BashTool is the system's most complex tool by far. It parses compound commands, classifies subcommands as read-only or write, manages background tasks, detects image output by magic bytes, and implements a sed simulation for safe edit previews.

The compound command parsing is particularly interesting. `splitCommandWithOperators()` breaks a command like `cd /tmp && mkdir build && ls build` into individual subcommands. Each is classified against known-safe command sets (`BASH_SEARCH_COMMANDS`, `BASH_READ_COMMANDS`, `BASH_LIST_COMMANDS`). A compound command is read-only only if ALL non-neutral parts are safe. The neutral set (echo, printf) is ignored -- they do not make a command read-only, but they also do not make it write-only.

The sed simulation (`_simulatedSedEdit`) deserves special attention. When a user approves a sed command in the permission dialog, the system pre-computes the result by running the sed command in a sandbox and capturing the output. The pre-computed result is injected into the input as `_simulatedSedEdit`. When `call()` executes, it applies the edit directly, bypassing shell execution. This guarantees that what the user previewed is exactly what gets written -- not a re-execution that might produce different results if the file changed between preview and execution.

### FileEditTool: Staleness Detection

FileEditTool integrates with `readFileState`, the LRU cache of file contents and timestamps maintained across the conversation. Before applying an edit, it checks whether the file has been modified since the model last read it. If the file is stale -- modified by a background process, another tool, or the user -- the edit is rejected with a message telling the model to re-read the file first.

The fuzzy matching in `findActualString()` handles the common case where the model gets whitespace slightly wrong. It normalizes whitespace and quote styles before matching, so an edit targeting `old_string` with trailing spaces still matches the file's actual content. The `replace_all` flag enables bulk replacements; without it, non-unique matches are rejected, requiring the model to provide enough context to identify a single location.

### FileReadTool: The Versatile Reader

FileReadTool is the only built-in tool with `maxResultSizeChars: Infinity`. If Read output were persisted to disk, the model would need to Read the persisted file, which could itself exceed the limit, creating an infinite loop. The tool instead self-bounds via token estimation and truncates at the source.

The tool is remarkably versatile: it reads text files with line numbers, images (returning base64 multimodal content blocks), PDFs (via `extractPDFPages()`), Jupyter notebooks (via `readNotebook()`), and directories (falling back to `ls`). It blocks dangerous device paths (`/dev/zero`, `/dev/random`, `/dev/stdin`) and handles macOS screenshot filename quirks (U+202F narrow no-break space vs regular space in "Screen Shot" filenames).

### GrepTool: Pagination via head_limit

GrepTool wraps `ripGrep()` and adds a pagination mechanism via `head_limit`. The default is 250 entries -- enough for useful results but small enough to avoid context bloat. When truncation occurs, the response includes `appliedLimit: 250`, signaling the model to use `offset` on the next call to paginate. An explicit `head_limit: 0` disables the limit entirely.

GrepTool automatically excludes six VCS directories (`.git`, `.svn`, `.hg`, `.bzr`, `.jj`, `.sl`). Searching inside `.git/objects` is almost never what the model wants, and accidental inclusion of binary pack files would blow through token budgets.

### AgentTool and Context Modifiers

AgentTool spawns sub-agents that run their own query loops. Its `call()` returns `newMessages` containing the sub-agent's transcript, and optionally a `contextModifier` that propagates state changes back to the parent. Because AgentTool is not concurrency-safe by default, multiple Agent tool calls in a single response run serially -- each sub-agent's context modifier is applied before the next sub-agent starts. In coordinator mode, the pattern inverts: the coordinator dispatches sub-agents for independent tasks, and the `isAgentSwarmsEnabled()` check unlocks parallel agent execution.

---

## How Tools Interact with the Message History

Tool results do not simply return data to the model. They participate in the conversation as structured messages.

The API expects tool results as `ToolResultBlockParam` objects that reference the original `tool_use` block by ID. Most tools serialize to text. FileReadTool can serialize to image content blocks (base64-encoded) for multimodal responses. BashTool detects image output by inspecting magic bytes in stdout and switches to image blocks accordingly.

`ToolResult.newMessages` is how tools extend the conversation beyond the simple call-and-response pattern. **Agent transcripts**: AgentTool injects the sub-agent's message history as attachment messages. **System reminders**: Memory tools inject system messages that appear after the tool result -- visible to the model on the next turn but stripped at the `normalizeMessagesForAPI` boundary. **Attachment messages**: Hook results, additional context, and error details carry structured metadata that the model can reference in subsequent turns.

The `contextModifier` function is the mechanism for tools that change the execution environment. When `EnterPlanMode` executes, it returns a modifier that sets the permission mode to `'plan'`. When `ExitWorktree` executes, it modifies the working directory. These modifiers are the only way for a tool to affect subsequent tools -- direct mutation of `ToolUseContext` is not possible because the context is spread-copied before each tool call. The serial-only restriction is enforced by the orchestration layer: if two concurrent tools both modify the working directory, which wins?

---

## Apply This: Designing a Tool System

**Fail-closed defaults.** New tools should be conservative until explicitly marked otherwise. A developer who forgets to set a flag gets the safe behavior, not the dangerous one.

**Input-dependent safety.** `isConcurrencySafe(input)` and `isReadOnly(input)` take the parsed input because the same tool at different inputs has different safety profiles. A tool registry that marks BashTool as "always serial" is correct but wasteful.

**Layer your permissions.** Tool-specific checks, rule-based matching, mode-based defaults, interactive prompts, and automated classifiers each handle different cases. No single mechanism is sufficient.

**Budget results, not just inputs.** Token limits on input are standard. But tool results can be arbitrarily large and they accumulate across turns. Per-tool limits prevent individual explosions. Aggregate conversation limits prevent cumulative overflow.

**Make error classification telemetry-safe.** In minified builds, `error.constructor.name` is mangled. The `classifyToolError()` function extracts the most informative safe string available -- telemetry-safe messages, errno codes, stable error names -- without ever logging the raw error message to analytics.

---

## What Comes Next

This chapter traced how a single tool call flows from definition through validation, permission, execution, and result budgeting. But the model rarely requests just one tool at a time. How tools are orchestrated into concurrent batches is the subject of Chapter 7.
