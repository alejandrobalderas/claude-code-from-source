# Chapter 11: Memory -- Learning Across Conversations

## The Stateless Problem

Every chapter so far has described machinery that exists within a single session. The agent loop runs, tools execute, sub-agents coordinate, and when the process exits, all of it vanishes. The next conversation starts with the same system prompt, the same tool definitions, the same model -- and zero knowledge of what happened before.

This is the fundamental limitation of a stateless architecture. A developer corrects the model's testing approach on Monday, and on Tuesday the model makes the same mistake. A user explains their role, their project's constraints, their preferences for code style, and every new session requires them to explain it again. The model is not forgetful -- it never knew. Each conversation is an independent universe.

The problem is not theoretical. It manifests in concrete ways that erode trust. A user says "remember, we use real database instances in tests, not mocks" -- and next week the model generates mocked tests. A user explains they are a senior engineer who does not need beginner explanations -- and the next session opens with a tutorial-level walkthrough. Without memory, every session starts at zero. The agent is perpetually a new hire on their first day.

The standard solution in the industry is Retrieval-Augmented Generation (RAG): embed documents into vectors, store them in a vector database, and retrieve relevant chunks at query time. This works well for knowledge bases -- documentation, FAQs, reference material. But it is architecturally mismatched for what an agent actually needs to remember across sessions. An agent's memory is not a knowledge base. It is a collection of observations: who the user is, what they have corrected, what the project's current constraints are, where to find things. These observations are small, change frequently, and must be human-editable. A vector database solves the wrong problem.

Claude Code's memory system is a different bet entirely: files on disk, Markdown format, LLM-powered recall, no infrastructure. The bet is that simplicity in storage, combined with intelligence in retrieval, produces a better system than sophistication in both.

The design philosophy has consequences that shape the entire system:

- **Human-readable.** A user who wants to see what Claude Code remembers can open `~/.claude/projects/<slug>/memory/MEMORY.md` in any text editor. No special tools, no decryption, no export command.
- **Human-editable.** A stale memory can be corrected with vim. A wrong memory can be deleted with `rm`. The user has full agency over the agent's knowledge.
- **Version-controllable.** Team memories can be committed to git. Memory changes diff cleanly because they are Markdown.
- **Zero infrastructure.** The memory system works offline, works without a server, works on any OS that has a filesystem. There is no migration path because there is no schema.
- **Debuggable.** When memory behaves unexpectedly, the diagnosis path is `ls` and `cat`, not query logs and database inspection.

The model both reads and writes memories using `FileWriteTool` and `FileEditTool` -- the same tools it uses to edit source code (introduced in Chapter 6). No special memory API exists. The system prompt teaches the model a two-step write protocol (create file, update index), and the model executes it with its existing capabilities under new instructions. This is tool reuse as architectural principle -- the memory system is not a subsystem bolted onto the agent, it is an emergent behavior of the agent using its existing capabilities.

There is a deeper reason the file-based choice works here. Memory, for an AI agent, is fundamentally different from memory in a traditional application. A traditional application's database holds authoritative state -- the source of truth for the system's data. An agent's memory holds *observations* -- things that were true at a point in time and may or may not still be true. Files communicate this epistemological status naturally. They have modification times that reveal when the observation was recorded. They can be read, edited, and deleted by humans who know the observation is wrong. A database suggests permanence and authority; a Markdown file suggests a note that someone wrote down and might need to update. The storage medium communicates the nature of the data -- these are working notes, not gospel.

### Per-Project Scoping

Memory is scoped to the git repository root, not the working directory. If a user opens a terminal in `src/components/` and another in `tests/`, both sessions share the same memory directory. The resolution logic finds the canonical git root first, falling back to the project root:

The base path resolution finds the canonical git root first, falling back to the project root. This ensures all git worktrees of the same repository share a single memory directory.

The `findCanonicalGitRoot` call ensures that all git worktrees of the same repository share a single memory directory. The git root is sanitized (slashes become dashes, via `sanitizePath()`) to produce a flat directory name:

```
~/.claude/projects/-Users-alex-code-myapp/memory/
```

A fully populated memory directory reveals the system's structure:

```mermaid
graph LR
    subgraph "~/.claude/projects/slug/memory/"
        MEMORY["MEMORY.md<br/><i>always loaded</i>"]
        UR["user_role.md"]
        FT["feedback_testing.md"]
        PM["project_merge_freeze.md"]
        RR["reference_linear.md"]
        CL[".consolidate-lock<br/><i>mtime = lastConsolidatedAt</i>"]
        subgraph "team/"
            TM["MEMORY.md"]
            TF["feedback_db_testing.md"]
        end
        subgraph "logs/ (KAIROS)"
            DL["2026/03/2026-03-31.md"]
        end
    end

    MEMORY -->|"on-demand via<br/>Sonnet selector"| UR
    MEMORY -->|"on-demand"| FT
    MEMORY -->|"on-demand"| PM
    MEMORY -->|"on-demand"| RR
```

The naming convention is semantic: `<type>_<topic>.md`. The type prefix is not enforced by code but is part of the prompt's instructions, making it easy to visually scan the directory and understand the memory landscape.

---

## The Four-Type Taxonomy

Not everything is worth remembering. The memory system constrains all memories to exactly four types:

The four types are: **user**, **feedback**, **project**, and **reference**.

The taxonomy is designed around a single criterion: **is this knowledge derivable from the current project state?** Code patterns, architecture, file structure, git history -- all of these can be re-derived by reading the codebase. They are excluded. The four types capture what cannot be re-derived.

**User memories** record information about the person: their role, goals, responsibilities, expertise level. A senior Go engineer who is new to React gets different explanations than a first-time programmer.

**Feedback memories** capture guidance about how to approach work -- both corrections and confirmations. The system explicitly instructs the model to record both: "if you only save corrections, you will drift away from approaches the user has already validated." Each feedback memory has a specific structure: the rule itself, then a `**Why:**` line with the reason (often a past incident), then a `**How to apply:**` line with the trigger conditions.

**Project memories** record ongoing work context -- who is doing what, why, by when. The prompt emphasizes converting relative dates to absolute: "Thursday" becomes "2026-03-05" so the memory remains interpretable weeks later.

**Reference memories** are bookmarks -- pointers to where information lives in external systems. A Linear project URL, a Grafana dashboard, a Slack channel. These tell the model where to look, not what to find.

### The Taxonomy as Filter

The four types are not just categories -- they are a filter. By defining exactly what counts as a memory, the system implicitly defines what does not. Without the taxonomy, an eager model would save everything: code patterns, architecture diagrams, error messages. All derivable from the codebase. Saving it creates a parallel, potentially stale copy of information that is better sourced from its origin.

The taxonomy also prevents a subtler failure: memory as crutch. If the model saves architectural decisions as memories, it stops reading the codebase to understand architecture. By excluding derivable information, the system forces the model to stay grounded in the current state of the code.

The exclusion list is explicit: code patterns, git history, debugging solutions, anything in CLAUDE.md, ephemeral task details. These exclusions apply even when the user explicitly asks to save. If a user says "remember this PR list," the model is instructed to push back -- "what was *surprising* or *non-obvious* about it?" That surprising part is worth keeping. The raw list is not. This instruction was validated through evals, going from 0/2 to 3/3 when the exclusion-override instruction was added.

### Frontmatter as Contract

Every memory file uses YAML frontmatter with three required fields:

```markdown
---
name: {{memory name}}
description: {{one-line description -- used to decide relevance}}
type: {{user, feedback, project, reference}}
---
```

The `description` is the most load-bearing field. It is what the relevance selector (a Sonnet side-query, discussed below) uses to decide whether to surface this memory. A vague description like "testing stuff" will either match too broadly or fail to match at all. A specific description like "Integration tests must hit real DB, not mocks -- burned by mock divergence Q4" matches exactly the conversations where it matters. The description is the memory's search index -- consumed not by a search engine but by a language model that can understand nuance, context, and intent.

The frontmatter is also the only part of the file that the scanning system reads during recall. `scanMemoryFiles()` reads each file only to its first 30 lines to extract the header. The body is private until the file is explicitly selected and loaded.

---

## The Write Path

Writing a memory is a two-step process executed with standard file tools.

**Step 1: Write the memory file.** The model creates a `.md` file in the memory directory with YAML frontmatter:

```markdown
---
name: Testing Policy
description: Integration tests must hit real DB, not mocks
type: feedback
---

Don't mock the database in integration tests.

**Why:** We got burned last quarter when mocked tests passed but production
queries hit edge cases the mocks didn't cover.

**How to apply:** Any test file under `__tests__/` that touches database
operations should use the real PGlite instance from test-utils.
```

**Step 2: Update the index.** The model adds a one-line pointer to `MEMORY.md`:

```markdown
- [Testing Policy](feedback_testing.md) -- integration tests must hit real DB
```

Each entry must stay under approximately 150 characters. The index is a table of contents, not a knowledge base.

When the model learns new information that modifies an existing memory, it uses `FileEditTool` to update the existing file rather than creating a duplicate. The system does not version memories internally -- the file is on the local filesystem, and the user has `git` if they want versioning. Before the prompt is built, `ensureMemoryDirExists()` creates the memory directory, and the prompt tells the model the directory already exists, avoiding wasted turns on `ls` and `mkdir -p`.

---

## The Recall Path

Writing memories is necessary but not sufficient. The harder problem is retrieval: given a user's query, which of the potentially hundreds of memory files should be loaded into the model's context? Loading all of them would exhaust the token budget. Loading none would defeat the purpose. Loading the wrong ones would waste tokens on irrelevant information while missing the knowledge that would have changed the model's behavior.

The recall system operates in two tiers. The `MEMORY.md` index is always loaded into context at session start, providing orientation. Individual memory files are surfaced on-demand through an LLM-powered relevance query that selects up to five memories per turn.

### The Full Recall Pipeline

```mermaid
flowchart TD
    A[User submits query] --> B[startRelevantMemoryPrefetch<br/>fires async, parallel with main model]
    B --> C[scanMemoryFiles reads all .md files<br/>parses frontmatter, 30 lines max per file]
    C --> D[Filter already-surfaced paths]
    D --> E[formatMemoryManifest<br/>one line per file: type, name, date, description]
    E --> F[Sonnet side-query receives manifest +<br/>user query + recently-used tools]
    F --> G[Sonnet returns up to 5 filenames<br/>via structured JSON output]
    G --> H[Validate filenames against known set<br/>catching hallucinated names]
    H --> I[Read selected files in full<br/>attach as relevant_memories with staleness warnings]
    I --> J[Collapse groups in UI<br/>absorb attachments for rendering]

    style B fill:#e1f5fe
    style F fill:#fff3e0
```

The async prefetch in step 2 is the key performance decision. By the time the main model reaches a point where recalled context would be useful, the side-query has usually already completed. The user experiences no additional latency.

### The Sonnet Side-Query

The manifest is sent to a Sonnet model as a side-query. The system prompt for this selector is precise:

The system prompt for the selector instructs it to be conservative: include only memories that will be useful for the current query, skip memories if uncertain, and avoid selecting API/usage documentation for tools already in active use (since the model already has those tools loaded) -- but still surface warnings, gotchas, or known issues about those tools.

The response uses structured output -- `{ selected_memories: string[] }` -- and filenames are validated against the known set.

This approach trades latency for precision, and the tradeoff analysis is instructive. **Keyword matching** would be fast but has no understanding of context -- it cannot express "do not select memories for tools already in active use." **Embedding similarity** handles semantic matching but introduces infrastructure (embedding model, vector store, update pipeline) and struggles with negation -- the embedding of "do NOT use database mocks" is very close to "use database mocks." **The Sonnet side-query** understands semantic relevance, reasons about context, handles negation, and requires zero infrastructure. The latency cost is bounded (hundreds of milliseconds) and hidden behind the main model's initial processing.

The telemetry system tracks selection rates even when no memories are selected. A selection rate of 0/150 means something different from 0/3 -- the first indicates a precision problem, the second a coverage problem.

---

## Staleness

The staleness system addresses a failure mode that emerged from real usage. Users reported that old memories -- containing file:line citations to code that had since changed -- were being asserted as fact by the model. The citation made the stale claim sound *more* authoritative, not less.

The solution is not expiration. Old memories are not deleted -- they may contain institutional knowledge valid for years. Instead, the system attaches age warnings:

The staleness function computes the memory's age in days. Memories from today or yesterday get no warning (the function returns an empty string). Everything older gets a caveat injected alongside the memory content: a message stating the age in days and warning that code behavior claims or file:line citations may be outdated, advising verification against current code.

Memories from today or yesterday get no warning. Everything older gets a staleness caveat injected alongside the memory content. The human-readable format -- "today," "yesterday," "47 days ago" -- exists because models are poor at date arithmetic. A raw ISO timestamp does not trigger staleness reasoning the way "47 days ago" does. This is an empirical observation about model behavior, validated through evals: the action-cue framing "Before recommending from memory" scored 3/3 versus 0/3 for the more abstract "Trusting what you recall," with identical body text.

There is a philosophical tension worth naming. The staleness system treats memories as hypotheses, not facts. But the model's natural tendency is to present information confidently. The staleness warning is fighting the model's own voice -- using its instruction-following capability to override its confidence-generation tendency.

---

## MEMORY.md as the Always-Loaded Index

Every conversation begins with `MEMORY.md` in context. It is not a memory -- it is an index, a table of contents for the actual memory files.

The index has two hard caps:

The index has two hard caps: 200 lines and 25,000 bytes.

The 200-line cap catches normal growth. The 25KB byte cap catches an observed failure mode: users packing long lines that stay under 200 lines but consume enormous token budgets. At the 97th percentile, a MEMORY.md with only 197 lines weighed 197KB. When either cap fires, actionable guidance tells the user what to fix: "Keep index entries to one line under ~200 chars; move detail into topic files."

This two-tier architecture -- lightweight always-on index plus heavy on-demand content -- is the design that allows memory to scale. A project with 150 memories has a 150-line index consuming perhaps 3,000 tokens, not 150 full files consuming 100,000.

---

The transition from individual memory to shared knowledge is natural. A testing policy, a deployment convention, a known gotcha in the build system -- these need to be shared across a team.

## Team Memory

Team memory is a subdirectory of the auto-memory directory at `<autoMemPath>/team/`, gated behind a feature flag and requiring auto-memory to be enabled. The architectural nesting is deliberate: disabling auto-memory transitively disables team memory.

### Defense in Depth

Team memory introduces an attack surface that individual memory does not have. Team-synced files come from other users, and a malicious teammate could attempt path traversal. The security model uses three layers of defense.

**Layer 1: Input sanitization.** The `sanitizePathKey()` function validates against null bytes, URL-encoded traversals (`%2e%2e%2f`), Unicode normalization attacks (fullwidth characters that normalize to `../`), backslashes, and absolute paths.

**Layer 2: String-level path validation.** After sanitization, `path.resolve()` normalizes remaining `..` segments, and the resolved path is checked against the team directory prefix (including a trailing separator to prevent `team-evil/` from matching `team/`).

**Layer 3: Symlink resolution.** `realpathDeepestExisting()` resolves symlinks on the deepest existing ancestor, catching attacks that string-level validation cannot detect. If `team/evil` is a symlink pointing to `/etc/`, string validation sees a valid prefix, but `realpath` reveals the true target.

All validation failures produce a `PathTraversalError`. No partial successes, no fallbacks. Fail closed.

### Scope Guidance

The prompt teaches the model about private vs. shared memory. User memories are always private. Reference memories are usually team. Feedback memories default to private unless they represent project-wide conventions. The cross-checking instruction -- "Before saving a private feedback memory, check that it does not contradict a team feedback memory" -- prevents conflicting guidance from surfacing unpredictably depending on which memory is recalled first.

---

## KAIROS Mode: Append-Only Daily Logs

Standard memory assumes discrete sessions. KAIROS mode (Claude Code's assistant mode) breaks this assumption -- sessions are long-lived, potentially running for days. The two-step write pattern does not scale to continuous operation.

The solution is architectural separation between capture and consolidation:

```mermaid
graph LR
    subgraph "Standard Write Path"
        A1[Model observes] --> A2[Create memory file] --> A3[Update MEMORY.md index]
    end

    subgraph "KAIROS Mode"
        B1[Model observes] --> B2[Append timestamped bullet<br/>to daily log file]
        B3[/dream consolidation/] --> B4[Read recent logs] --> B5[Merge into structured memories] --> B6[Update MEMORY.md index]
    end

    style A2 fill:#c8e6c9
    style A3 fill:#c8e6c9
    style B2 fill:#bbdefb
    style B3 fill:#fff9c4
```

In KAIROS mode, the model appends to date-named log files (`<autoMemPath>/logs/YYYY/MM/YYYY-MM-DD.md`). Each entry is a short timestamped bullet. The model is instructed: "Do not rewrite or reorganize the log" -- restructuring during capture loses the chronological signal that consolidation needs.

The path in the prompt is described as a *pattern* rather than today's literal date. This is a caching optimization: the memory prompt is cached and not invalidated when the date changes at midnight. The model derives the current date from a separate `date_change` attachment.

### The /dream Consolidation

Consolidation runs in four phases: **Orient** (list directory, read index, skim existing files), **Gather** (search logs, check for drifted memories), **Consolidate** (write or update files, merge rather than duplicate), **Prune** (update index under 200 lines, remove stale pointers). The emphasis on merging into existing files rather than creating new ones is important -- without it, the memory directory would grow linearly with usage.

### The Consolidation Lock

The lock file `.consolidate-lock` serves dual purpose: its content is the holder's PID (mutual exclusion), its mtime *is* `lastConsolidatedAt` (scheduling state). The auto-dream fires when three gates pass, evaluated cheapest-first: hours since last consolidation exceeds 24, sessions modified since then exceeds 5, and no other process holds the lock. Crash recovery detects dead PIDs via `process.kill(pid, 0)`, with a one-hour staleness timeout as defense against PID reuse.

---

## Background Extraction

The main agent has full instructions for writing memories proactively. But agents are imperfect -- and the imperfection is predictable. When a user says "remember to always use integration tests" and then immediately asks "now fix the login bug," the model's attention shifts entirely to the bug. The memory-saving instruction was processed but may not execute.

At the end of each complete query loop, a forked agent -- sharing the parent's prompt cache -- analyzes recent messages and writes any memories the main agent missed. When the main agent has already written memories in the current turn range, the extraction agent skips that range. The extraction agent has a constrained tool budget: read-only tools plus write access only to memory directory paths. Its prompt instructs a two-turn strategy: turn 1 reads in parallel, turn 2 writes in parallel.

The interaction is cooperative, not competitive. The main agent's prompt always contains the full save instructions. When the main agent saves, the background agent defers. When it does not, the background agent catches the gap. This pattern -- a primary path with a background safety net -- makes memory capture more reliable without burdening the primary interaction. Neither alone would be sufficient.

---

## Path Resolution and Security

The auto-memory path is resolved through a priority chain:

1. **`CLAUDE_COWORK_MEMORY_PATH_OVERRIDE`** -- Full-path override for Cowork.
2. **`autoMemoryDirectory` in settings.json** -- Only trusted settings sources. Project settings are intentionally excluded.
3. **Default computed path** -- `~/.claude/projects/<sanitized-git-root>/memory/`.

The exclusion of project settings is a security decision. A malicious repository could commit `.claude/settings.json` with `autoMemoryDirectory: "~/.ssh"`, and the permission carve-out for memory files would grant the model automatic write access to SSH keys. By limiting the override to policy, flag, local, and user settings -- none committable to a repository -- this attack vector is closed.

The `isAutoMemPath()` function normalizes paths before prefix-checking to prevent traversal, and the trailing separator convention ensures prefix matching requires a directory boundary.

### The Enable/Disable Chain

Whether auto-memory is active is determined by `isAutoMemoryEnabled()`, implementing its own priority chain: environment variable, bare mode, CCR without persistent storage, settings, default enabled. When disabled, both the prompt section is dropped (so the model receives no memory instructions) and the background processes stop (extract-memories, auto-dream, team sync). Both gates must align -- removing the prompt alone would not stop the extraction agent, which has its own prompt.

---

## Apply This: Designing Agent Memory

The memory system's complexity is in the behavioral layer -- prompt instructions, LLM-powered recall, staleness management, background extraction -- not in storage infrastructure. This distribution of complexity is itself a design principle.

**Files beat databases for agent memory.** Files are inspectable, editable, and version-controllable. Transparency builds trust. When the alternative is a database users cannot easily read, files win on trust alone.

**Constrain what gets saved, not just how.** The derivability test -- can this knowledge be re-derived from the current project state? -- eliminates the majority of potential memories while preserving the ones that actually matter.

**Use an LLM for recall, not keywords or embeddings.** An LLM side-query understands context, reasons about what is already available in conversation, handles negation, and requires no index maintenance. The latency cost is real but bounded and hidden behind the main model's processing.

**Warn about staleness, do not expire.** Institutional knowledge may remain valid for years. Attaching age warnings lets the model treat old memories as hypotheses rather than facts. The human-readable age format triggers the right reasoning in a way that raw timestamps do not.

**Build a safety net for capture.** The main agent will miss memories. A background extraction agent that reviews recent conversation makes the system more reliable without burdening the primary interaction. When the main agent saves, the background agent defers.

---

The agent can now learn across sessions -- accumulating knowledge about its user, their preferences, their project's state, and the corrections they have made. The memory system makes a philosophical commitment: that an agent's relationship with its user should deepen over time, not reset on every interaction. The file-based implementation makes that commitment tangible -- visible on disk, editable by humans, version-controlled alongside code. The agent's memory is not a black box. It is a collection of notes in a folder, written in a language that both the model and the human can read.

The next chapter examines how Claude Code extends its capabilities beyond the core: the skills system that teaches the model new behaviors, and the hooks system that lets external code constrain and modify those behaviors at over two dozen lifecycle points.
