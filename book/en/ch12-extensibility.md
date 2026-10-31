# Chapter 12: Extensibility -- Skills and Hooks

## Two Dimensions of Extension

Every extensibility system answers two questions: what can the system do, and when does it do it. Most frameworks conflate the two -- a plugin registers both capabilities and lifecycle callbacks in the same object, and the boundary between "adding a feature" and "intercepting a feature" blurs into a single registration API.

Claude Code separates them cleanly. Skills extend what the model can do. They are markdown files that become slash commands, injecting new instructions into the conversation when invoked. Hooks extend when and how things happen. They are lifecycle interceptors that fire at over two dozen distinct points during a session, running arbitrary code that can block actions, modify inputs, force continuation, or silently observe.

The separation is not accidental. Skills are content -- they expand the model's knowledge and capabilities by adding prompt text. Hooks are control flow -- they modify the execution path without changing what the model knows. A skill might teach the model how to run your team's deployment process. A hook might ensure no deployment command executes without a passing test suite. The skill adds capability; the hook adds constraint.

This chapter covers both systems in depth, then examines where they intersect: skill-declared hooks that register as session-scoped lifecycle interceptors when the skill is invoked.

---

## Skills: Teaching the Model New Tricks

### Two-Phase Loading

The core optimization of the skills system is that frontmatter loads at startup, but full content loads only on invocation.

```mermaid
flowchart LR
    subgraph "Phase 1: Startup"
        S1[Read SKILL.md files<br/>from 7 sources] --> S2[Extract YAML frontmatter<br/>name, description, whenToUse]
        S2 --> S3[Build system prompt menu<br/>model knows skills exist]
    end

    subgraph "Phase 2: Invocation"
        I1[User or model<br/>invokes /skill-name] --> I2[getPromptForCommand executes]
        I2 --> I3[Variable substitution<br/>ARGUMENTS, SKILL_DIR, SESSION_ID]
        I3 --> I4[Inline shell execution<br/>unless MCP-sourced]
        I4 --> I5[Content blocks injected<br/>into conversation]
    end

    S3 -.->|"on invocation"| I1

    style S3 fill:#c8e6c9
    style I5 fill:#bbdefb
```

**Phase 1** reads each `SKILL.md` file, splits YAML frontmatter from the markdown body, and extracts metadata. The frontmatter fields become part of the system prompt so the model knows the skill exists. The markdown body is captured in a closure but not processed. A project with 50 skills pays the token cost of 50 short descriptions, not 50 full documents.

**Phase 2** fires when the model or user invokes a skill. `getPromptForCommand` prepends the base directory, substitutes variables (`$ARGUMENTS`, `${CLAUDE_SKILL_DIR}`, `${CLAUDE_SESSION_ID}`), and executes inline shell commands (backtick-prefixed with `!`). The result is returned as content blocks injected into the conversation.

### Seven Sources with Priority

Skills arrive from seven distinct sources, loaded in parallel and merged by precedence:

| Priority | Source | Location | Notes |
|----------|--------|----------|-------|
| 1 | Managed (Policy) | `<MANAGED_PATH>/.claude/skills/` | Enterprise-controlled |
| 2 | User | `~/.claude/skills/` | Personal, available everywhere |
| 3 | Project | `.claude/skills/` (walked up to home) | Checked into version control |
| 4 | Additional Dirs | `<add-dir>/.claude/skills/` | Via `--add-dir` flag |
| 5 | Legacy Commands | `.claude/commands/` | Backwards-compatible |
| 6 | Bundled | Compiled into the binary | Feature-gated |
| 7 | MCP | MCP server prompts | Remote, untrusted |

Deduplication uses `realpath` to resolve symlinks and overlapping parent directories. The first-seen source wins. The `getFileIdentity` function resolves to canonical paths via `realpath` rather than relying on inode values, which are unreliable on container/NFS mounts and ExFAT.

### The Frontmatter Contract

Key frontmatter fields that control skill behavior:

| YAML Field | Purpose |
|-----------|---------|
| `name` | User-facing display name |
| `description` | Shown in autocomplete and system prompt |
| `when_to_use` | Detailed usage scenarios for model discovery |
| `allowed-tools` | Which tools the skill can use |
| `disable-model-invocation` | Block autonomous model use |
| `context` | `'fork'` to run as sub-agent |
| `hooks` | Lifecycle hooks registered on invocation |
| `paths` | Glob patterns for conditional activation |

The `context: 'fork'` option runs the skill as a sub-agent with its own context window, essential for skills that need significant work without polluting the main conversation's token budget. The `disable-model-invocation` and `user-invocable` fields control two distinct access paths -- setting both to true makes the skill invisible, useful for hooks-only skills.

### The MCP Security Boundary

After variable substitution, inline shell commands execute. The security boundary is absolute: **MCP skills never execute inline shell commands.** MCP servers are external systems. An MCP prompt containing `` !`rm -rf /` `` would execute with the user's full permissions if allowed. The system treats MCP skills as content-only. This trust boundary connects to the broader MCP security model discussed in Chapter 15.

### Dynamic Discovery

Skills are not only loaded at startup. When the model touches files, `discoverSkillDirsForPaths` walks up from each path looking for `.claude/skills/` directories. Skills with `paths` frontmatter are stored in a `conditionalSkills` map and activate only when touched paths match their patterns. A skill declaring `paths: "packages/database/**"` remains invisible until the model reads or edits a database file -- context-sensitive capability expansion.

---

## Hooks: Controlling When Things Happen

Hooks are Claude Code's mechanism for intercepting and modifying behavior at lifecycle points. The main execution engine exceeds 4,900 lines. The system serves three audiences: individual developers (custom linting, validation), teams (shared quality gates checked into the project), and enterprises (policy-managed compliance rules).

### A Real-World Hook: Preventing Commits to Main

Before diving into the machinery, here is what a hook looks like in practice. Suppose your team wants to prevent the model from committing directly to the `main` branch.

**Step 1: The settings.json configuration:**

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/check-not-main.sh",
            "if": "Bash(git commit*)"
          }
        ]
      }
    ]
  }
}
```

**Step 2: The shell script:**

```bash
#!/bin/bash
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
if [ "$BRANCH" = "main" ]; then
  echo "Cannot commit directly to main. Create a feature branch first." >&2
  exit 2  # Exit 2 = blocking error
fi
exit 0
```

**Step 3: What the model experiences.** When the model tries `git commit` on the `main` branch, the hook fires before the command executes. The script checks the branch, writes to stderr, and exits with code 2. The model sees a system message: "Cannot commit directly to main. Create a feature branch first." The commit never runs. The model creates a branch and commits there instead.

The `if: "Bash(git commit*)"` condition means the script only runs for git commit commands -- not for every Bash invocation. Exit code 2 blocks; exit code 0 passes; any other exit code produces a non-blocking warning. This is the complete protocol.

### Four User-Configurable Types

Claude Code defines six hook types -- four user-configurable, two internal.

**Command hooks** spawn a shell process. Hook input JSON is piped to stdin; the hook communicates back via exit code and stdout/stderr. This is the workhorse type.

**Prompt hooks** make a single LLM call, returning `{"ok": true}` or `{"ok": false, "reason": "..."}`. Lightweight AI-powered validation without a full agent loop.

**Agent hooks** run a multi-turn agentic loop (max 50 turns, `dontAsk` permissions, thinking disabled). Each gets its own session scope. This is the heavy machinery for "verify that the test suite passes and covers the new feature."

**HTTP hooks** POST the hook input to a URL. Enables remote policy servers and audit logging without local process spawning.

The two internal types are **callback hooks** (registered programmatically, -70% overhead on the hot path via a fast path that skips span tracking) and **function hooks** (session-scoped TypeScript callbacks for structured output enforcement in agent hooks).

### The Five Most Important Lifecycle Events

The hook system fires at over two dozen lifecycle points. Five dominate real-world usage:

**PreToolUse** -- fires before every tool execution. Can block, modify input, auto-approve, or inject context. Permission behavior follows strict precedence: deny > ask > allow. The most common hook point for quality gates.

**PostToolUse** -- fires after successful execution. Can inject context or replace MCP tool output entirely. Useful for automated feedback on tool results.

**Stop** -- fires before Claude concludes its response. A blocking hook forces continuation. This is the mechanism for automated verification loops: "are you really done?"

**SessionStart** -- fires at session beginning. Can set environment variables, override the first user message, or register file watch paths. Cannot block (a hook cannot prevent a session from starting).

**UserPromptSubmit** -- fires when the user submits a prompt. Can block processing, enabling input validation or content filtering before the model sees it.

**Reference table -- remaining events:**

| Category | Events |
|----------|--------|
| Tool lifecycle | PostToolUseFailure, PermissionDenied, PermissionRequest |
| Session | SessionEnd (1.5s timeout), Setup |
| Subagent | SubagentStart, SubagentStop |
| Compaction | PreCompact, PostCompact |
| Notification | Notification, Elicitation, ElicitationResult |
| Configuration | ConfigChange, InstructionsLoaded, CwdChanged, FileChanged, TaskCreated, TaskCompleted, TeammateIdle |

The blocking asymmetry is intentional. Events representing recoverable decisions (tool calls, stop conditions) support blocking. Events representing irrevocable facts (session started, API failed) do not.

### Exit Code Semantics

For command hooks, exit codes carry specific meaning:

| Exit Code | Meaning | Blocks |
|-----------|---------|--------|
| 0 | Success, stdout parsed if JSON | No |
| 2 | Blocking error, stderr shown as system message | Yes |
| Other | Non-blocking warning, shown to user only | No |

Exit code 2 was chosen deliberately. Exit code 1 is too common -- any unhandled exception, assertion failure, or syntax error produces exit 1. Using exit 2 prevents accidental enforcement.

### Six Hook Sources

| Source | Trust Level | Notes |
|--------|-------------|-------|
| `userSettings` | User | `~/.claude/settings.json`, highest priority |
| `projectSettings` | Project | `.claude/settings.json`, version-controlled |
| `localSettings` | Local | `.claude/settings.local.json`, gitignored |
| `policySettings` | Enterprise | Cannot be overridden |
| `pluginHook` | Plugin | Priority 999 (lowest) |
| `sessionHook` | Session | In-memory only, registered by skills |

---

## The Snapshot Security Model

Hooks execute arbitrary code. A project's `.claude/settings.json` can define hooks that fire before every tool call. What happens if a malicious repository modifies its hooks after the user accepts the workspace trust dialog?

Nothing. The hooks configuration is frozen at startup.

```mermaid
sequenceDiagram
    participant User
    participant CC as Claude Code
    participant FS as Filesystem
    participant Attacker

    User->>CC: Open project
    CC->>FS: Read all hook configs
    CC->>CC: captureHooksConfigSnapshot()
    Note over CC: Hooks frozen in memory
    User->>CC: Accept workspace trust
    Note over CC: Normal operation begins

    Attacker->>FS: Modify .claude/settings.json
    Note over FS: New malicious hooks written

    CC->>CC: executeHooks()
    Note over CC: Reads from frozen snapshot<br/>Ignores filesystem changes
```

`captureHooksConfigSnapshot()` is called once during startup. From that point, `executeHooks()` reads from the snapshot, never re-reading settings files implicitly. The snapshot is only updated through explicit channels: the `/hooks` command or a file watcher detection, both of which rebuild through `updateHooksConfigSnapshot()`.

The policy enforcement cascade: `disableAllHooks` in policy settings clears everything. `allowManagedHooksOnly` excludes user and project hooks. A user can disable their own hooks by setting `disableAllHooks`, but they cannot disable enterprise-managed hooks. The policy layer always wins.

The trust check itself (`shouldSkipHookDueToTrust()`) was introduced after two vulnerabilities: SessionEnd hooks executing when a user *declined* the trust dialog, and SubagentStop hooks firing before trust was presented. Both shared the same root cause -- hooks firing in lifecycle states where the user had not consented to workspace code execution. The fix is a centralized gate at the top of `executeHooks()`.

---

## Execution Flow

```mermaid
flowchart TD
    Start[executeHooks called] --> Trust{Workspace<br/>trusted?}
    Trust -->|No| Skip[Return immediately]
    Trust -->|Yes| Resolve[Assemble matchers from:<br/>snapshot + callbacks + session hooks]
    Resolve --> Fast{All hooks<br/>internal callbacks?}
    Fast -->|Yes| FastPath[Skip spans, progress, output pipeline<br/>-70% overhead]
    Fast -->|No| FullPath[Create abort signals, progress messages]
    FastPath --> Exec[Parallel execution via async generator]
    FullPath --> Exec
    Exec --> Parse[Parse outputs: JSON schema validation<br/>exit codes, permission behaviors]
    Parse --> Agg[Aggregate results:<br/>deny > ask > allow precedence]
    Agg --> Once{once: true<br/>hooks?}
    Once -->|Yes| Remove[removeSessionHook]
    Once -->|No| Done[Return aggregated result]
    Remove --> Done
```

The fast path for internal callbacks is a significant optimization. When all matched hooks are internal (file access analytics, commit attribution), the system skips span tracking, abort signal creation, progress messages, and the full output processing pipeline. Most PostToolUse invocations hit only internal callbacks.

Hook input JSON is serialized once via a lazy `getJsonInput()` closure and reused across all parallel hooks. Environment injection sets `CLAUDE_PROJECT_DIR`, `CLAUDE_PLUGIN_ROOT`, and for certain events, `CLAUDE_ENV_FILE` where hooks can write environment exports.

---

## Integration: Where Skills Meet Hooks

When a skill is invoked, its frontmatter-declared hooks register as session-scoped hooks. The `skillRoot` becomes `CLAUDE_PLUGIN_ROOT` for the hook's shell commands:

```
my-skill/
  SKILL.md          # The skill content
  validate.sh       # Called by a PreToolUse hook declared in frontmatter
```

The skill's frontmatter declares:

```yaml
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/validate.sh"
          once: true
```

When the user invokes `/my-skill`, the skill content loads into the conversation AND the PreToolUse hook registers. The next Bash tool call triggers `validate.sh`. Because `once: true` is set, the hook removes itself after the first successful execution.

For agents, `Stop` hooks declared in frontmatter are automatically converted to `SubagentStop` hooks, because subagents trigger `SubagentStop`, not `Stop`. Without the conversion, an agent's stop-verification hook would never fire.

### Permission Behavior Precedence

`executePreToolHooks()` can block (via `blockingError`), auto-approve (via `permissionBehavior: 'allow'`), force ask (via `'ask'`), deny (via `'deny'`), modify input (via `updatedInput`), or add context (via `additionalContext`). When multiple hooks return different behaviors, deny always wins. This is the correct default for security-relevant decisions.

### Stop Hooks: Forcing Continuation

When a Stop hook returns exit code 2, the stderr is shown to the model as feedback and the conversation continues. This turns a single-shot prompt-response into a goal-directed loop. The Stop hook is arguably the most powerful integration point in the entire system.

---

## Apply This: Designing an Extensibility System

**Separate content from control flow.** Skills add capabilities; hooks constrain behavior. Conflating the two makes it impossible to reason about what a plugin does versus what it prevents.

**Freeze configuration at trust boundaries.** The snapshot mechanism captures hooks at the moment of consent and never re-reads implicitly. If your system executes user-provided code, this eliminates TOCTOU attacks.

**Use uncommon exit codes for semantic signals.** Exit code 1 is noise -- every unhandled error produces it. Exit code 2 as the blocking signal prevents accidental enforcement. Choose signals that require deliberate intent.

**Validate at the socket level, not the application level.** The SSRF guard runs at DNS lookup time, not as a pre-flight check. This eliminates the DNS rebinding window. When validating network destinations, the check must be atomic with the connection.

**Optimize for the common case.** The internal callback fast path (-70% overhead) recognizes that most hook invocations hit only internal callbacks. The two-phase skill loading recognizes that most skills are never invoked in a given session. Each optimization targets the actual distribution of usage.

The extensibility system reflects a mature understanding of the tension between power and safety. Skills give the model new capabilities bounded by the MCP security line (Chapter 15). Hooks give external code influence over the model's actions bounded by the snapshot mechanism, exit code semantics, and policy cascade. Neither system trusts the other -- and that mutual distrust is what makes the combination safe to deploy at scale.

The next chapter turns to the visual layer: how Claude Code renders a reactive terminal UI at 60fps and processes input across five terminal protocols.
