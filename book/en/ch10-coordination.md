# Chapter 10: Tasks, Coordination, and Swarms

## The Limits of a Single Thread

Chapter 8 showed how to create a sub-agent -- the fifteen-step lifecycle that builds an isolated execution context from an agent definition. Chapter 9 showed how to make parallel spawns economical through prompt cache exploitation. But creating agents and managing agents are different problems. This chapter addresses the second.

A single agent loop -- one model, one conversation, one tool at a time -- can accomplish a remarkable amount of work. It can read files, edit code, run tests, search the web, and reason about complex problems. But it hits a ceiling.

The ceiling is not intelligence. It is parallelism and scope. A developer working on a large refactoring needs to update 40 files, run tests after each batch, and verify nothing broke. A codebase migration touches frontend, backend, and database layers simultaneously. A thorough code review reads dozens of files while running the test suite in the background. These are not harder problems -- they are wider ones. They require the ability to do multiple things at once, to delegate work to specialists, and to coordinate the results.

Claude Code's answer to this problem is not one mechanism but a layered stack of orchestration patterns, each suited to a different shape of work. Background tasks for fire-and-forget commands. Coordinator mode for manager-worker hierarchies. Swarm teams for peer-to-peer collaboration. And a unified communication protocol that ties them all together.

The orchestration layer spans approximately 40 files across `tools/AgentTool/`, `tasks/`, `coordinator/`, `tools/SendMessageTool/`, and `utils/swarm/`. Despite this breadth, the design is anchored by a single state machine that all patterns share. Understanding that state machine -- the `Task` abstraction in `Task.ts` -- is the prerequisite for understanding everything else.

This chapter traces the full stack, from the foundational task state machine up through the most sophisticated multi-agent topologies.

---

## The Task State Machine

Every background operation in Claude Code -- a shell command, a sub-agent, a remote session, a workflow script -- is tracked as a *task*. The task abstraction lives in `Task.ts` and provides the unified state model that the rest of the orchestration layer builds on.

### Seven Types

The system defines seven task types, each representing a different execution model:

The seven task types are: `local_bash` (background shell commands), `local_agent` (background sub-agents), `remote_agent` (remote sessions), `in_process_teammate` (swarm teammates), `local_workflow` (workflow script executions), `monitor_mcp` (MCP server monitors), and `dream` (speculative background thinking).

`local_bash` and `local_agent` are the workhorses -- background shell commands and background sub-agents, respectively. `in_process_teammate` is the swarm primitive. `remote_agent` bridges to remote Claude Code Runtime environments. `local_workflow` runs multi-step scripts. `monitor_mcp` watches MCP server health. `dream` is the most unusual -- a background task that lets the agent think speculatively while waiting for user input.

Each type gets a single-character ID prefix for instant visual identification:

| Type | Prefix | Example ID |
|------|--------|------------|
| `local_bash` | `b` | `b4k2m8x1` |
| `local_agent` | `a` | `a7j3n9p2` |
| `remote_agent` | `r` | `r1h5q6w4` |
| `in_process_teammate` | `t` | `t3f8s2v5` |
| `local_workflow` | `w` | `w6c9d4y7` |
| `monitor_mcp` | `m` | `m2g7k1z8` |
| `dream` | `d` | `d5b4n3r6` |

Task IDs use a single-character prefix (a for agents, b for bash, t for teammates, etc.) followed by 8 random alphanumeric characters drawn from a case-insensitive-safe alphabet (digits plus lowercase letters). This yields approximately 2.8 trillion combinations -- enough to resist brute-force symlink attacks against the task output files on disk.

When you see `a7j3n9p2` in a log line, you know immediately it is a background agent. When you see `b4k2m8x1`, a shell command. The prefix is a micro-optimization for human readers, but in a system that can have dozens of concurrent tasks, it matters.

### Five Statuses

The lifecycle is a simple directed graph with no cycles:

```mermaid
stateDiagram-v2
    pending --> running: execution starts
    running --> completed: normal finish
    running --> failed: error
    running --> killed: abort / user stop
```

`pending` is the brief state between registration and first execution. `running` means the task is actively doing work. The three terminal states are `completed` (success), `failed` (error), and `killed` (explicitly stopped by the user, the coordinator, or an abort signal). A helper function guards against interacting with dead tasks:

```typescript
export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'killed'
}
```

This function appears everywhere -- in message injection guards, eviction logic, orphan cleanup, and the SendMessage routing that decides whether to queue a message or resume a dead agent.

### The Base State

Every task state extends `TaskStateBase`, which carries the fields that all seven types share:

```typescript
export type TaskStateBase = {
  id: string              // Prefixed random ID
  type: TaskType          // Discriminator
  status: TaskStatus      // Current lifecycle position
  description: string     // Human-readable summary
  toolUseId?: string      // The tool_use block that spawned this task
  startTime: number       // Creation timestamp
  endTime?: number        // Terminal-state timestamp
  totalPausedMs?: number  // Accumulated pause time
  outputFile: string      // Disk path for streaming output
  outputOffset: number    // Read cursor for incremental output
  notified: boolean       // Whether completion was reported to parent
}
```

Two fields deserve attention. `outputFile` is the bridge between async execution and the parent's conversation -- every task writes its output to a file on disk, and the parent can read it incrementally via `outputOffset`. `notified` prevents duplicate completion messages; once the parent has been told a task finished, the flag flips to `true` and the notification is never sent again. Without this guard, a task that completes between two consecutive polls of the notification queue would generate duplicate notifications, confusing the model into thinking two tasks finished when only one did.

### The Agent Task State

`LocalAgentTaskState` is the most complex variant, carrying everything needed to manage a background sub-agent's full lifecycle:

```typescript
export type LocalAgentTaskState = TaskStateBase & {
  type: 'local_agent'
  agentId: string
  prompt: string
  selectedAgent?: AgentDefinition
  agentType: string
  model?: string
  abortController?: AbortController
  pendingMessages: string[]       // Queued via SendMessage
  isBackgrounded: boolean         // Was this originally a foreground agent?
  retain: boolean                 // UI is holding this task
  diskLoaded: boolean             // Sidechain transcript loaded
  evictAfter?: number             // GC deadline
  progress?: AgentProgress
  lastReportedToolCount: number
  lastReportedTokenCount: number
  // ... additional lifecycle fields
}
```

Three fields reveal important design decisions. `pendingMessages` is the inbox -- when `SendMessage` targets a running agent, the message is queued here rather than injected immediately. Messages are drained at tool-round boundaries, which preserves the agent's turn structure. `isBackgrounded` distinguishes agents that were born async from those that started as foreground sync agents and were later backgrounded by the user pressing a key. `evictAfter` is a garbage collection mechanism: non-retained completed tasks get a grace period before their state is purged from memory.

All task states are stored in `AppState.tasks` as a `Record<string, TaskState>`, keyed by the prefixed ID. This is a flat map, not a tree -- the system does not model parent-child relationships in the state store. The parent-child relationship is implicit in the conversation flow: the parent holds the `toolUseId` that spawned the child.

### The Task Registry

Each task type is backed by a `Task` object with a minimal interface:

```typescript
export type Task = {
  name: string
  type: TaskType
  kill(taskId: string, setAppState: SetAppState): Promise<void>
}
```

The registry collects all task implementations:

```typescript
export function getAllTasks(): Task[] {
  return [
    LocalShellTask,
    LocalAgentTask,
    RemoteAgentTask,
    DreamTask,
    ...(LocalWorkflowTask ? [LocalWorkflowTask] : []),
    ...(MonitorMcpTask ? [MonitorMcpTask] : []),
  ]
}
```

Notice the conditional inclusion -- `LocalWorkflowTask` and `MonitorMcpTask` are feature-gated and may not exist at runtime. The `Task` interface is deliberately minimal. Earlier iterations included `spawn()` and `render()` methods, but these were removed when it became clear that spawning and rendering were never called polymorphically. Each task type has its own spawn logic, its own state management, and its own rendering. The only operation that genuinely needs to dispatch by type is `kill()`, and so that is all the interface requires.

This is an example of interface evolution through subtraction. The initial design imagined that all task types would share a common lifecycle interface. In practice, the types diverged enough that the shared interface became a fiction -- `spawn()` for a shell command and `spawn()` for an in-process teammate have almost nothing in common. Rather than maintain a leaky abstraction, the team removed everything except the one method that actually benefits from polymorphism.

---

## Communication Patterns

A task that runs in the background is only useful if the parent can observe its progress and receive its results. Claude Code supports three communication channels, each optimized for a different access pattern.

### Foreground: The Generator Chain

When an agent runs synchronously, the parent iterates its `runAgent()` async generator directly, yielding each message back up the call stack. The interesting mechanism here is the background escape hatch -- the sync loop races between "next message from agent" and "background signal":

```typescript
const agentIterator = runAgent({ ...params })[Symbol.asyncIterator]()

while (true) {
  const nextMessagePromise = agentIterator.next()
  const raceResult = backgroundPromise
    ? await Promise.race([nextMessagePromise.then(...), backgroundPromise])
    : { type: 'message', result: await nextMessagePromise }

  if (raceResult.type === 'background') {
    // User triggered backgrounding -- transition to async
    await agentIterator.return(undefined)
    void runAgent({ ...params, isAsync: true })
    return { data: { status: 'async_launched' } }
  }

  agentMessages.push(message)
}
```

If the user decides mid-execution that a sync agent should become a background task, the foreground iterator is cleanly returned (triggering its `finally` block for resource cleanup), and the agent is re-spawned as an async task with the same ID. The transition is seamless -- no work is lost, and the agent continues from where it left off with an async abort controller that is unlinked from the parent's ESC key.

This is a genuinely difficult state transition to get right. The foreground agent shares the parent's abort controller (ESC kills both). The background agent needs its own controller (ESC should not kill it). The agent's messages need to transfer from the foreground generator stream to the background notification system. The task state needs to flip `isBackgrounded` so the UI knows to show it in the background panel. And all of this must happen atomically -- no messages lost in the transition, no zombie iterators left running. The `Promise.race` between the next message and the background signal is the mechanism that makes this possible.

### Background: Three Channels

Background agents communicate through disk, notifications, and queued messages.

**Disk output files.** Every task writes to an `outputFile` path -- a symlink to the agent's transcript in JSONL format. The parent (or any observer) can read this file incrementally using `outputOffset`, which tracks how far into the file has been consumed. The `TaskOutputTool` exposes this to the model:

```typescript
inputSchema = z.strictObject({
  task_id: z.string(),
  block: z.boolean().default(true),
  timeout: z.number().default(30000),
})
```

When `block: true`, the tool polls until the task reaches a terminal state or the timeout expires. This is the primary mechanism for a coordinator that spawns a worker and waits for its result.

**Task notifications.** When a background agent completes, the system generates an XML notification and enqueues it for delivery into the parent's conversation:

```xml
<task-notification>
  <task-id>a7j3n9p2</task-id>
  <tool-use-id>toolu_abc123</tool-use-id>
  <output-file>/path/to/output</output-file>
  <status>completed</status>
  <summary>Agent "Investigate auth bug" completed</summary>
  <result>Found null pointer in src/auth/validate.ts:42...</result>
  <usage>
    <total_tokens>15000</total_tokens>
    <tool_uses>8</tool_uses>
    <duration_ms>12000</duration_ms>
  </usage>
</task-notification>
```

The notification is injected as a user-role message in the parent's conversation, which means the model sees it in its normal message flow. It does not need a special tool to check for completions -- they arrive as context. The `notified` flag on the task state prevents duplicate delivery.

**Command queue.** The `pendingMessages` array on `LocalAgentTaskState` is the third channel. When `SendMessage` targets a running agent, the message is queued:

```typescript
if (isLocalAgentTask(task) && task.status === 'running') {
  queuePendingMessage(agentId, input.message, setAppState)
  return { data: { success: true, message: 'Message queued...' } }
}
```

These messages are drained at tool-round boundaries by `drainPendingMessages()` and injected as user messages into the agent's conversation. This is a crucial design choice -- messages arrive between tool rounds, not mid-execution. The agent finishes its current thought, then receives the new information. No race conditions, no corrupted state.

### Progress Tracking

The `ProgressTracker` provides real-time visibility into agent activity:

```typescript
export type ProgressTracker = {
  toolUseCount: number
  latestInputTokens: number        // Cumulative (latest value, not sum)
  cumulativeOutputTokens: number   // Summed across turns
  recentActivities: ToolActivity[] // Last 5 tool uses
}
```

The distinction between input and output token tracking is deliberate and reflects a subtlety of the API's billing model. Input tokens are cumulative per API call because the full conversation is re-sent each time -- the 15th turn includes all 14 previous turns, so the input token count reported by the API already reflects the total. Keeping the latest value is the correct aggregation. Output tokens are per-turn -- the model generates new tokens each time -- so summing is the correct aggregation. Getting this wrong would either dramatically overcount (summing cumulative input tokens) or dramatically undercount (keeping only the latest output tokens).

The `recentActivities` array (capped at 5 entries) provides a human-readable stream of what the agent is doing: "Read src/auth/validate.ts", "Bash: npm test", "Edit src/auth/validate.ts". This appears in the VS Code subagent panel and the terminal's background task indicator, giving users visibility into agent work without requiring them to read full transcripts.

For background agents, progress is written to `AppState` via `updateAsyncAgentProgress()` and emitted as SDK events via `emitTaskProgress()`. The VS Code subagent panel consumes these events to render live progress bars, tool counts, and activity streams. The progress tracking is not just cosmetic -- it is the primary feedback mechanism that tells users whether a background agent is making progress or stuck in a loop.

---

## Coordinator Mode

Coordinator mode transforms Claude Code from a single agent with background helpers into a true manager-worker architecture. It is the most opinionated orchestration pattern in the system, and its design reveals deep thinking about how LLMs should and should not delegate work.

### The Problem Coordinator Mode Solves

The standard agent loop has a single conversation and a single context window. When it spawns a background agent, the background agent runs independently and reports results via task notifications. This works well for simple delegation -- "run the tests while I keep editing" -- but breaks down for complex multi-step workflows.

Consider a codebase migration. The agent needs to: (1) understand the current patterns across 200 files, (2) design the migration strategy, (3) apply changes to each file, and (4) verify nothing broke. Steps 1 and 3 benefit from parallelism. Step 2 requires synthesizing the results of step 1. Step 4 depends on step 3. A single agent doing this sequentially would spend most of its token budget re-reading files. Multiple background agents doing this without coordination would produce inconsistent changes.

Coordinator mode solves this by splitting the "thinking" agent from the "doing" agents. The coordinator handles steps 1 and 2 (dispatching research workers, then synthesizing). Workers handle steps 3 and 4 (applying changes, running tests). The coordinator sees the full picture; workers see their specific task.

### Activation

A single environment variable flips the switch:

```typescript
export function isCoordinatorMode(): boolean {
  if (feature('COORDINATOR_MODE')) {
    return isEnvTruthy(process.env.CLAUDE_CODE_COORDINATOR_MODE)
  }
  return false
}
```

On session resume, `matchSessionMode()` checks whether the resumed session's stored mode matches the current environment. If they diverge, the environment variable is flipped to match. This prevents the confusing scenario where a coordinator session resumes as a regular agent (losing awareness of its workers) or a regular session resumes as a coordinator (losing access to its tools). The session's mode is the source of truth; the environment variable is the runtime signal.

### Tool Restrictions

The coordinator's power comes not from having more tools, but from having fewer. In coordinator mode, the coordinator agent gets exactly three tools:

- **Agent** -- spawn workers
- **SendMessage** -- communicate with existing workers
- **TaskStop** -- terminate running workers

That is it. No file reading. No code editing. No shell commands. The coordinator cannot directly touch the codebase. This restriction is not a limitation -- it is the core design principle. The coordinator's job is to think, plan, decompose, and synthesize. Workers do the work.

Workers, conversely, get the full tool set minus internal coordination tools:

```typescript
const INTERNAL_WORKER_TOOLS = new Set([
  TEAM_CREATE_TOOL_NAME,
  TEAM_DELETE_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
  SYNTHETIC_OUTPUT_TOOL_NAME,
])
```

Workers cannot spawn their own sub-teams or send messages to peers. They report results through the normal task completion mechanism, and the coordinator synthesizes across them.

### The 370-Line System Prompt

The coordinator system prompt is, line for line, the most instructive document in the codebase about how to use LLMs for orchestration. It runs approximately 370 lines and encodes hard-won lessons about delegation patterns. The key teachings:

**"Never delegate understanding."** This is the central thesis. The coordinator must synthesize research findings into specific prompts with file paths, line numbers, and exact changes. The prompt explicitly calls out anti-patterns like "based on your findings, fix the bug" -- a prompt that delegates *comprehension* to the worker, forcing it to re-derive context the coordinator already has. The correct pattern is: "In `src/auth/validate.ts` at line 42, the `userId` parameter can be null when called from the OAuth flow. Add a null check that returns a 401 response."

**"Parallelism is your superpower."** The prompt establishes a clear concurrency model. Read-only tasks run freely in parallel -- research, exploration, file reading. Write-heavy tasks serialize per file set. The coordinator is expected to reason about which tasks can overlap and which must sequence. A good coordinator spawns five research workers simultaneously, waits for all of them, synthesizes, then spawns three implementation workers that touch disjoint file sets. A bad coordinator spawns one worker, waits, spawns the next, waits again -- serializing work that could have been parallel.

**Task workflow phases.** The prompt defines four phases:

```mermaid
graph LR
    R[Research] -->|research results| S[Synthesis]
    S -->|specific instructions| I[Implementation]
    I -->|test results| V[Verification]

    R -.- R1[3-5 workers in parallel\nread files, run tests]
    S -.- S1[Coordinator only\nno workers spawned]
    I -.- I1[Workers per file set\ndisjoint changes]
    V -.- V1[Workers run tests\nverify changes]
```

1. **Research** -- workers explore the codebase in parallel, reading files, running tests, gathering information
2. **Synthesis** -- the coordinator (not a worker) reads all research results and builds a unified understanding
3. **Implementation** -- workers receive precise instructions derived from the synthesis
4. **Verification** -- workers run tests and verify the changes

The coordinator should not skip phases. The most common failure mode is jumping from research directly to implementation without synthesis. When this happens, the coordinator delegates understanding to the implementation workers -- each one must re-derive context from scratch, leading to inconsistent changes and wasted tokens.

**The continue-vs-spawn decision.** When a worker finishes and the coordinator has follow-up work, should it send a message to the existing worker (via SendMessage) or spawn a fresh one (via Agent)? The decision is a function of context overlap:

- **High overlap, same files**: Continue. The worker already has the file contents in its context, understands the patterns, and can build on its previous work. Spawning fresh would force re-reading the same files and re-deriving the same understanding.
- **Low overlap, different domain**: Spawn fresh. A worker that just investigated the authentication system carries 20,000 tokens of auth-specific context that is dead weight for a CSS refactoring task. Starting clean is cheaper.
- **High overlap but the worker failed**: Spawn fresh with explicit guidance about what went wrong. Continuing a failed worker often means fighting against confused context. A fresh start with "the previous attempt failed because X, avoid Y" is more reliable.
- **Follow-up requires the worker's output**: Continue, with the output included in the SendMessage. The worker does not need to re-derive its own results.

**Worker prompt writing and anti-patterns.** The prompt teaches the coordinator how to write effective worker prompts and explicitly flags bad patterns:

Anti-pattern: *"Based on your research findings, implement the fix."* This delegates comprehension. The worker was not the one who did the research -- the coordinator read the research results.

Anti-pattern: *"Fix the bug in the auth module."* No file paths, no line numbers, no description of the bug. The worker must search the entire codebase from scratch.

Anti-pattern: *"Make the same change to all the other files."* Which files? What change? The coordinator knows; it should enumerate them.

Good pattern: *"In `src/auth/validate.ts` at line 42, the `userId` parameter can be null when called from `src/oauth/callback.ts:89`. Add a null check: if `userId` is null, return `{ error: 'unauthorized', status: 401 }`. Then update the test in `src/auth/__tests__/validate.test.ts` to cover the null case."*

The cost of writing a specific prompt is borne once, by the coordinator. The benefit -- a worker that executes correctly on the first try -- is enormous. Vague prompts create a false economy: the coordinator saves 30 seconds of prompt writing and the worker wastes 5 minutes of exploration.

### Worker Context

The coordinator injects information about available tools into its own context, so the model knows what workers can do:

```typescript
export function getCoordinatorUserContext(mcpClients, scratchpadDir?) {
  return {
    workerToolsContext: `Workers spawned via Agent have access to: ${workerTools}`
      + (mcpClients.length > 0
        ? `\nWorkers also have MCP tools from: ${serverNames}` : '')
      + (scratchpadDir ? `\nScratchpad: ${scratchpadDir}` : '')
  }
}
```

The scratchpad directory (gated by the `tengu_scratch` feature flag) is a shared filesystem location where workers can read and write without permission prompts. It enables durable cross-worker knowledge sharing -- one worker's research notes become another worker's input, mediated through the filesystem rather than through the coordinator's token window.

This is significant because it solves a fundamental limitation of the coordinator pattern. Without a scratchpad, all information flows through the coordinator: Worker A produces findings, the coordinator reads them via TaskOutput, synthesizes them into Worker B's prompt. The coordinator's context window becomes the bottleneck -- it must hold all intermediate results long enough to synthesize them. With a scratchpad, Worker A writes findings to `/tmp/scratchpad/auth-analysis.md`, and the coordinator tells Worker B: "Read the auth analysis at `/tmp/scratchpad/auth-analysis.md` and apply the pattern to the OAuth module." The coordinator moves information by reference, not by value.

### Mutual Exclusion with Fork

Coordinator mode and fork-based subagents are mutually exclusive:

```typescript
export function isForkSubagentEnabled(): boolean {
  if (feature('FORK_SUBAGENT')) {
    if (isCoordinatorMode()) return false
    // ...
  }
}
```

The conflict is fundamental. Fork agents inherit the parent's entire conversation context -- they are cheap clones that share prompt cache. Coordinator workers are independent agents with fresh context and specific instructions. These are opposing philosophies of delegation, and the system enforces the choice at the feature flag level.

---

## The Swarm System

Coordinator mode is hierarchical: one manager, many workers, top-down control. The swarm system is the peer-to-peer alternative -- multiple Claude Code instances working as a team, with a leader coordinating multiple teammates through message passing.

### Team Context

Teams are identified by a `teamName` and tracked in `AppState.teamContext`:

```typescript
teamContext?: {
  teamName: string
  teammates: {
    [id: string]: { name: string; color?: string; ... }
  }
}
```

Each teammate gets a name (for addressing) and a color (for visual distinction in the UI). The team file is persisted on disk so that team membership survives process restarts.

### Agent Name Registry

Background agents can be given names at spawn time, which makes them addressable by human-readable identifiers instead of random task IDs:

```typescript
if (name) {
  rootSetAppState(prev => {
    const next = new Map(prev.agentNameRegistry)
    next.set(name, asAgentId(asyncAgentId))
    return { ...prev, agentNameRegistry: next }
  })
}
```

The `agentNameRegistry` is a `Map<string, AgentId>`. When `SendMessage` resolves a `to` field, the registry is checked first:

```typescript
const registered = appState.agentNameRegistry.get(input.to)
const agentId = registered ?? toAgentId(input.to)
```

This means you can send a message to `"researcher"` instead of `a7j3n9p2`. The indirection is simple but it enables the coordinator to think in terms of roles rather than IDs -- a significant improvement for the model's ability to reason about multi-agent workflows.

### In-Process Teammates

In-process teammates run in the same Node.js process as the leader, isolated via `AsyncLocalStorage`. Their state extends the base with team-specific fields:

```typescript
export type InProcessTeammateTaskState = TaskStateBase & {
  type: 'in_process_teammate'
  identity: TeammateIdentity
  prompt: string
  messages?: Message[]                  // Capped at 50
  pendingUserMessages: string[]
  isIdle: boolean
  shutdownRequested: boolean
  awaitingPlanApproval: boolean
  permissionMode: PermissionMode
  onIdleCallbacks?: Array<() => void>
  currentWorkAbortController?: AbortController
}
```

The `messages` cap at 50 entries deserves explanation. During development, analysis revealed that each in-process agent accumulates approximately 20MB of RSS at 500+ turns. Whale sessions -- power users running extended workflows -- were observed launching 292 agents in 2 minutes, driving RSS to 36.8GB. The 50-message cap for the UI representation is a memory safety valve. The agent's actual conversation continues with full history; only the UI-facing snapshot is truncated.

The `isIdle` flag enables a work-stealing pattern. An idle teammate is not consuming tokens or API calls -- it is simply waiting for the next message. The `onIdleCallbacks` array lets the system hook into the transition from active to idle, enabling orchestration patterns like "wait for all teammates to finish, then proceed."

The `currentWorkAbortController` is distinct from the teammate's main abort controller. Aborting the current work controller cancels the teammate's ongoing turn but does not kill the teammate. This enables a "redirect" pattern: the leader sends a higher-priority message, the teammate's current work is aborted, and the teammate picks up the new message. The main abort controller, when aborted, kills the teammate entirely. Two levels of interruption for two levels of intent.

The `shutdownRequested` flag implements cooperative termination. When the leader sends a shutdown request, this flag is set. The teammate can check it at natural stopping points and wind down gracefully -- finishing its current file write, committing its changes, or sending a final status update. This is gentler than a hard kill, which might leave files in an inconsistent state.

### The Mailbox

Teammates communicate via a file-based mailbox system. When `SendMessage` targets a teammate, the message is written to the recipient's mailbox file on disk:

```typescript
await writeToMailbox(recipientName, {
  from: senderName,
  text: content,
  summary,
  timestamp: new Date().toISOString(),
  color: senderColor,
}, teamName)
```

Messages can be plain text, structured protocol messages (shutdown requests, plan approvals), or broadcasts (`to: "*"` sends to all team members excluding the sender). A poller hook processes incoming messages and routes them into the teammate's conversation.

The file-based approach is deliberately simple. There is no message broker, no event bus, no shared memory channel. Files are durable (surviving process crashes), inspectable (you can `cat` a mailbox), and cheap (no infrastructure dependencies). For a system where message volumes are measured in tens per session, not thousands per second, this is the right trade-off. A Redis-backed message queue would add operational complexity, a dependency, and failure modes -- all for a throughput requirement that a filesystem call handles trivially.

The broadcast mechanism deserves a note. When a message is sent to `"*"`, the sender iterates all team members from the team file, skips itself (case-insensitive comparison), and writes to each member's mailbox individually:

```typescript
for (const member of teamFile.members) {
  if (member.name.toLowerCase() === senderName.toLowerCase()) continue
  recipients.push(member.name)
}
for (const recipientName of recipients) {
  await writeToMailbox(recipientName, { from: senderName, text: content, ... }, teamName)
}
```

There is no fan-out optimization -- each recipient gets a separate file write. Again, at the scale of agent teams (typically 3-8 members), this is perfectly adequate. If a team had 100 members, this would need rethinking. But the 50-message memory cap that prevents 36GB RSS scenarios also implicitly caps the effective team size.

### Permission Forwarding

Swarm workers operate with restricted permissions but can escalate to the leader when they need approval for sensitive operations:

```typescript
const request = createPermissionRequest({
  toolName, toolUseId, input, description, permissionSuggestions
})
registerPermissionCallback({ requestId, toolUseId, onAllow, onReject })
void sendPermissionRequestViaMailbox(request)
```

The flow is: worker hits a tool that requires permission, the bash classifier attempts auto-approval, and if that fails, the request is forwarded to the leader via the mailbox system. The leader sees the request in their UI and can approve or reject. The callback fires and the worker proceeds. This lets workers operate autonomously for safe operations while maintaining human oversight for dangerous ones.

---

## Inter-Agent Communication: SendMessage

`SendMessageTool` is the universal communication primitive. It handles four distinct routing modes through a single tool interface, selected by the shape of the `to` field.

### Input Schema

```typescript
inputSchema = z.object({
  to: z.string(),
  // "teammate-name", "*", "uds:<socket>", "bridge:<session-id>"
  summary: z.string().optional(),
  message: z.union([
    z.string(),
    z.discriminatedUnion('type', [
      z.object({ type: z.literal('shutdown_request'), reason: z.string().optional() }),
      z.object({ type: z.literal('shutdown_response'), request_id, approve, reason }),
      z.object({ type: z.literal('plan_approval_response'), request_id, approve, feedback }),
    ]),
  ]),
})
```

The `message` field is a union of plain text and structured protocol messages. This means SendMessage serves double duty -- it is both the informal chat channel ("here are my findings") and the formal protocol layer ("I approve your plan" / "please shut down").

### Routing Dispatch

The `call()` method follows a priority-ordered dispatch chain:

```mermaid
graph TD
    START["SendMessage(to: X)"] --> B{starts with 'bridge:'?}
    B -->|Yes| BRIDGE[Bridge relay\ncross-machine via Remote Control]
    B -->|No| U{starts with 'uds:'?}
    U -->|Yes| UDS[Unix Domain Socket\nlocal inter-process]
    U -->|No| R{found in agentNameRegistry\nor AppState.tasks?}
    R -->|Yes, running| Q[Queue pending message\ndelivered at tool-round boundary]
    R -->|Yes, terminal| RESUME[Auto-resume agent\nfrom disk transcript]
    R -->|No| T{team context active?}
    T -->|Yes| MAIL[Write to mailbox file]
    T -->|No| ERR[Error: recipient not found]

    style BRIDGE fill:#69b
    style UDS fill:#69b
    style Q fill:#6b6
    style RESUME fill:#b96
    style MAIL fill:#6b6
    style ERR fill:#f66
```

**1. Bridge messages** (`bridge:<session-id>`). Cross-machine communication via Anthropic's Remote Control servers. This is the widest reach -- two Claude Code instances on different machines, potentially different continents, communicating through a relay. The system requires explicit user consent before sending bridge messages -- a safety check that prevents one agent from unilaterally establishing communication with a remote instance. Without this gate, a compromised or confused agent could exfiltrate information to a remote session. The consent check uses `postInterClaudeMessage()`, which handles serialization and transport over the Remote Control relay.

**2. UDS messages** (`uds:<socket-path>`). Local inter-process communication via Unix Domain Sockets. This is for Claude Code instances running on the same machine but in different processes -- for example, a VS Code extension hosting one instance and a terminal hosting another. UDS communication is fast (no network round-trip), secure (filesystem permissions control access), and reliable (the kernel handles delivery). The `sendToUdsSocket()` function serializes the message and writes it to the socket path specified in the `to` field. Peers discover each other via a `ListPeers` tool that scans for active UDS endpoints.

**3. In-process subagent routing** (plain name or agent ID). This is the most common path. The routing logic:

- Look up `input.to` in the `agentNameRegistry`
- If found and running: `queuePendingMessage()` -- the message waits for the next tool-round boundary
- If found but in a terminal state: `resumeAgentBackground()` -- the agent is transparently restarted
- If not in `AppState`: attempt to resume from the disk transcript

**4. Team mailbox** (fallback when team context is active). Named recipients get messages written to their mailbox files. The `"*"` wildcard triggers a broadcast to all team members.

### Structured Protocols

Beyond plain text, SendMessage carries two formal protocols.

**The shutdown protocol.** The leader sends `{ type: 'shutdown_request', reason: '...' }` to a teammate. The teammate responds with `{ type: 'shutdown_response', request_id, approve: true/false, reason }`. If approved, in-process teammates abort their controller; tmux-based teammates receive a `gracefulShutdown()` call. The protocol is cooperative -- a teammate can reject a shutdown request if it is in the middle of critical work, and the leader must handle that case.

**The plan approval protocol.** Teammates operating in plan mode must get approval before executing. They submit a plan, and the leader responds with `{ type: 'plan_approval_response', request_id, approve, feedback }`. Only the team lead can issue approvals. This creates a review gate -- the leader can examine a worker's intended approach before any files are touched, catching misunderstandings early.

### The Auto-Resume Pattern

The most elegant feature of the routing system is transparent agent resumption. When `SendMessage` targets a completed or killed agent, instead of returning an error, it resurrects the agent:

```typescript
if (task.status !== 'running') {
  const result = await resumeAgentBackground({
    agentId,
    prompt: input.message,
    toolUseContext: context,
    canUseTool,
  })
  return {
    data: {
      success: true,
      message: `Agent "${input.to}" was stopped; resumed with your message`
    }
  }
}
```

The `resumeAgentBackground()` function reconstructs the agent from its disk transcript:

1. Reads the sidechain JSONL transcript
2. Reconstructs the message history, filtering orphaned thinking blocks and unresolved tool uses
3. Rebuilds the content replacement state for prompt cache stability
4. Resolves the original agent definition from stored metadata
5. Re-registers as a background task with a fresh abort controller
6. Calls `runAgent()` with the restored history plus the new message as prompt

From the coordinator's perspective, sending a message to a dead agent and sending a message to a live agent are the same operation. The routing layer handles the complexity. This means coordinators do not need to track which agents are alive -- they simply send messages and the system figures it out.

The implications are significant. Without auto-resume, the coordinator would need to maintain a mental model of agent liveness: "Is `researcher` still running? Let me check. It completed. I need to spawn a new agent. But wait, should I use the same name? Will it have the same context?" With auto-resume, all of that collapses to: "Send `researcher` a message." If it is alive, the message is queued. If it is dead, it is resurrected with its full history. The coordinator's prompt complexity drops dramatically.

There is a cost, of course. Resuming from a disk transcript means re-reading potentially thousands of messages, reconstructing internal state, and making a new API call with a full context window. For a long-lived agent, this can be expensive in both latency and tokens. But the alternative -- requiring the coordinator to manually manage agent lifecycles -- is worse. The coordinator is an LLM. It is good at reasoning about problems and writing instructions. It is bad at bookkeeping. Auto-resume plays to the LLM's strengths by eliminating a category of bookkeeping entirely.

---

## TaskStop: The Kill Switch

`TaskStopTool` is the complement to Agent and SendMessage -- it terminates running tasks:

```typescript
inputSchema = z.strictObject({
  task_id: z.string().optional(),
  shell_id: z.string().optional(),  // Deprecated backward compat
})
```

The implementation delegates to `stopTask()`, which dispatches based on task type:

1. Look up the task in `AppState.tasks`
2. Call `getTaskByType(task.type).kill(taskId, setAppState)`
3. For agents: abort the controller, set status to `'killed'`, start the eviction timer
4. For shells: kill the process group

The tool has a legacy alias `"KillShell"` -- a reminder that the task system evolved from simpler origins where the only background operation was a shell command.

The kill mechanism varies by task type, but the pattern is consistent. For agents, killing means aborting the abort controller (which causes the `query()` loop to exit at the next yield point), setting the status to `'killed'`, and starting an eviction timer so the task state is cleaned up after a grace period. For shells, killing means sending a signal to the process group -- `SIGTERM` first, then `SIGKILL` if the process does not exit within a timeout. For in-process teammates, killing also triggers a shutdown notification to the team so other members know the teammate is gone.

The eviction timer is worth noting. When an agent is killed, its state is not immediately purged. It lingers in `AppState.tasks` for a grace period (controlled by `evictAfter`) so that the UI can show the killed status, any final output can be read, and auto-resume via SendMessage remains possible. After the grace period, the state is garbage collected. This is the same pattern used for completed tasks -- the system distinguishes between "finished" (result available) and "forgotten" (state purged).

---

## Choosing Between Patterns

(A note on naming: the codebase also contains `TaskCreate`/`TaskGet`/`TaskList`/`TaskUpdate` tools that manage a structured todo list -- a completely separate system from the background task state machine described here. `TaskStop` operates on `AppState.tasks`; `TaskUpdate` operates on a project tracking data store. The naming overlap is historical and a recurring source of model confusion.)

With three orchestration patterns available -- background delegation, coordinator mode, and swarm teams -- the natural question is when to use each.

**Simple delegation** (Agent tool with `run_in_background: true`) is appropriate when the parent has one or two independent tasks to offload. Run the tests in the background while continuing to edit. Search the codebase while waiting for a build. The parent stays in control, checks results when ready, and never needs a complex communication protocol. The overhead is minimal -- one task state entry, one disk output file, one notification on completion.

**Coordinator mode** is appropriate when the problem decomposes into a research phase, a synthesis phase, and an implementation phase -- and when the coordinator needs to reason across the results of multiple workers before directing the next step. The coordinator cannot touch files, which forces clean separation of concerns: thinking happens in one context, doing happens in another. The 370-line system prompt is not ceremony -- it encodes patterns that prevent the most common failure mode of LLM delegation, which is delegating comprehension instead of delegating action.

**Swarm teams** are appropriate for long-running collaborative sessions where agents need peer-to-peer communication, where the work is ongoing rather than batch-oriented, and where agents may need to idle and resume based on incoming messages. The mailbox system supports asynchronous patterns that coordinator mode (which is synchronous spawn-wait-synthesize) does not. Plan approval gates add a review layer. Permission forwarding maintains security without requiring every agent to have full privileges.

A practical decision table:

| Scenario | Pattern | Why |
|----------|---------|-----|
| Run tests while editing | Simple delegation | One background task, no coordination needed |
| Search codebase for all usages | Simple delegation | Fire-and-forget, read output when done |
| Refactor 40 files across 3 modules | Coordinator | Research phase finds patterns, synthesis plans changes, workers execute in parallel per module |
| Multi-day feature development with review gates | Swarm | Long-lived agents, plan approval protocol, peer communication |
| Fix a bug with known location | Neither -- single agent | Orchestration overhead exceeds the benefit for focused, sequential work |
| Migrate database schema + update API + update frontend | Coordinator | Three independent workstreams after a shared research/planning phase |
| Pair programming with user oversight | Swarm with plan mode | Worker proposes, leader approves, worker executes |

The patterns are not mutually exclusive in principle, but they are in practice. Coordinator mode disables fork subagents. Swarm teams have their own communication protocol that does not mix with coordinator task notifications. The choice is made at session startup via environment variables and feature flags, and it shapes the entire interaction model.

One final observation: the simplest pattern is almost always the right starting point. Most tasks do not need coordinator mode or swarm teams. A single agent with occasional background delegation handles the vast majority of development work. The sophisticated patterns exist for the 5% of cases where the problem is genuinely wide, genuinely parallel, or genuinely long-running. Reaching for coordinator mode on a single-file bug fix is like deploying Kubernetes for a static website -- technically possible, architecturally inappropriate.

---

## The Cost of Orchestration

Before examining what the orchestration layer reveals philosophically, it is worth acknowledging what it costs practically.

Every background agent is a separate API conversation. It has its own context window, its own token budget, and its own prompt cache slot. A coordinator that spawns 5 research workers is making 6 concurrent API calls, each with its own system prompt, tool definitions, and CLAUDE.md injection. The token overhead is not trivial -- the system prompt alone can be thousands of tokens, and each worker re-reads files that other workers may have already read.

The communication channels add latency. Disk output files require filesystem I/O. Task notifications are delivered at tool-round boundaries, not instantly. The command queue introduces a full round-trip delay -- the coordinator sends a message, the message waits for the worker to finish its current tool use, the worker processes the message, and the result is written to disk for the coordinator to read.

The state management adds complexity. Seven task types, five statuses, and dozens of fields per task state. The eviction logic, the garbage collection timers, the memory caps -- all of this exists because unbounded state growth caused real production incidents (36.8GB RSS).

None of this means orchestration is wrong. It means orchestration is a tool with a cost, and the cost should be weighed against the benefit. Running 5 parallel workers to search a codebase is worthwhile when the search would take 5 sequential minutes. Running a coordinator to fix a typo in one file is pure overhead.

---

## What the Orchestration Layer Reveals

The most interesting aspect of this system is not any individual mechanism -- task states, mailboxes, and notification XML are all straightforward engineering. What is interesting is the *design philosophy* that emerges from how they fit together.

The coordinator prompt's "never delegate understanding" is not just good advice for LLM orchestration. It is a statement about the fundamental limitation of context-window-based reasoning. A worker with a fresh context window cannot understand what the coordinator understood after reading 50 files and synthesizing three research reports. The only way to bridge that gap is for the coordinator to distill its understanding into a specific, actionable prompt. Vague delegation is not just inefficient -- it is information-theoretically lossy.

The auto-resume pattern in SendMessage reveals a preference for *apparent simplicity over actual simplicity*. The implementation is complex -- reading disk transcripts, reconstructing content replacement state, re-resolving agent definitions. But the interface is trivial: send a message, and it works regardless of whether the recipient is alive or dead. The complexity is absorbed by the infrastructure so that the model (and the user) can reason in simpler terms.

And the 50-message memory cap on in-process teammates is a reminder that orchestration systems operate under real physical constraints. 292 agents in 2 minutes reaching 36.8GB of RSS is not a theoretical concern -- it happened in production. The abstractions are elegant, but they run on hardware with finite memory, and the system must degrade gracefully when users push it to extremes.

There is also a lesson in the layered architecture itself. The task state machine is agnostic -- it does not know about coordinators or swarms. The communication channels are agnostic -- SendMessage does not know whether it is being called by a coordinator, a swarm leader, or a standalone agent. The coordinator prompt is layered on top, adding methodology without changing the underlying machinery. Each layer can be understood independently, tested independently, and evolved independently. When the team added the swarm system, they did not need to modify the task state machine. When they added the coordinator prompt, they did not need to modify SendMessage.

This is the hallmark of well-factored orchestration: the primitives are general, and the patterns are composed from them. A coordinator is just an agent with restricted tools and a detailed system prompt. A swarm leader is just an agent with a team context and mailbox access. A background worker is just an agent with an independent abort controller and a disk output file. The seven task types, five statuses, and four routing modes combine to produce orchestration patterns that are greater than the sum of their parts.

The orchestration layer is where Claude Code stops being a single-threaded tool executor and becomes something closer to a development team. The task state machine provides the bookkeeping. The communication channels provide the information flow. The coordinator prompt provides the methodology. And the swarm system provides the peer-to-peer topology for problems that do not fit a strict hierarchy. Together, they make it possible for a language model to do what no single model invocation can: work on wide problems, in parallel, with coordination.

The next chapter examines the permission system -- the safety layer that determines which of these agents can do what, and how dangerous operations are escalated from workers to humans. Orchestration without permission controls would be a force multiplier for mistakes. The permission system ensures that more agents means more capability, not more risk.
