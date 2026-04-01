# Prompt: Turn Any Codebase Into a Technical Book

A reusable system for analyzing a codebase and producing a publication-quality technical book using parallel AI agents. Designed to produce output comparable to an O'Reilly technical book.

---

## The Prompt

```
I want you to analyze the source code at [path] and produce a comprehensive
technical book about its architecture, patterns, and internals.

The book should read like a professional technical publication — the kind of
book a senior engineer would buy to deeply understand a system. Not documentation.
Not a tutorial. A book that teaches how the system works, why each decision was
made, and what patterns the reader can steal for their own projects.

---

## Phase 1: Exploration

Launch parallel agents (one per major subsystem) to read every file in the
codebase exhaustively. Each agent should document:

- Architecture and module boundaries
- Key abstractions (types, interfaces, core classes)
- Data flow (how information moves through the system)
- Design patterns (what patterns are used and why)
- Integration points (how this module connects to others)
- Surprising decisions (anything non-obvious or clever)

Produce a raw analysis document per subsystem. These are research notes, not
the final book.

## Phase 2: Audience and Positioning

Before structuring the book, define:

**Primary audience**: Who is this book for? What do they already know? What
do they want to learn? The book should serve two readers simultaneously:
- Technical leaders who want the architecture and design rationale (can skip
  code blocks and deep-dive sections)
- Senior engineers who want implementation-level understanding (read everything,
  including deep dives)

**Core thesis**: What is the ONE big insight about this system? Every chapter
should connect back to this thesis. For a codebase, this is usually: "Here is
the architectural bet this system makes, and here is how every subsystem serves
that bet."

**What makes it worth a book**: Why can't someone just read the source? The
book's value is: narrative (the source has no narrative), cross-cutting patterns
(scattered across files in the source), design rationale (not in the code at
all), and transferable lessons (require synthesis the source can't provide).

## Phase 3: Structure

Organize the book as if the reader were building the system from scratch. Each
chapter should solve one clear problem that the next chapter depends on. The
reader should never encounter a concept that requires a later chapter to understand.

**Parts**: Group chapters into 5-7 thematic parts. Each part has a one-line
epigraph that frames the section. Parts create natural reading breaks and make
the table of contents scannable.

**Chapter ordering principles**:
- Foundations first (startup, state, communication with external services)
- Core loop next (the main execution cycle — this is usually the most important chapter)
- Capabilities built on the core (tools, plugins, extensions)
- Advanced patterns (multi-agent, orchestration, coordination)
- Supporting infrastructure (UI, networking, persistence)
- Performance and optimization last (you can't optimize what you don't understand)
- Epilogue: synthesis, transferable lessons, forward look

**Chapter sizing**: Aim for 300-800 lines per chapter. If a chapter exceeds 800
lines, it's trying to cover too much — split it. If it's under 200 lines, it
might not justify being a standalone chapter — merge it.

Present the full outline with part names, chapter titles, and 2-3 bullet points
per chapter describing what it covers. Get approval before writing.

## Phase 4: Writing

Write each chapter FROM SCRATCH using the Phase 1 analysis as research notes.
Do not restructure the analysis — rewrite it as narrative prose.

### Chapter Template

Every chapter follows this structure:

1. **Opening** (2-3 paragraphs)
   - What problem does this layer/subsystem solve?
   - Why does it exist? What would break without it?
   - How does it connect to what the reader already knows? (explicit backward
     reference to previous chapter)
   - What will the reader understand by the end?

2. **Body** (the core content)
   - Mix of prose, diagrams, code snippets, and tables
   - Prose for narrative and rationale ("why")
   - Diagrams for architecture, data flow, and state machines
   - Code for key patterns (pseudocode only — see rules below)
   - Tables for reference material (field listings, configuration options)

3. **Deep Dive sections** (optional, inline)
   - Callout sections for implementation detail that leaders can skip
   - Contains the "how does this actually work at the byte level" content
   - Should be readable independently without losing the chapter's narrative

4. **Apply This** (closing section)
   - Exactly 5 transferable patterns extracted from the chapter
   - Each pattern: name → what problem it solves → how to adapt it → pitfall
     to watch for
   - Concrete enough to act on, abstract enough to transfer to other systems
   - Vary the format slightly between chapters to avoid monotony

### Voice and Tone

- **Expert peer**: Like a senior engineer doing a deep technical review for a
  colleague. Not academic, not tutorial, not marketing.
- **Direct and opinionated**: "This is clever because..." / "This is the wrong
  abstraction for..." / "The reason this exists is..."
- **No filler**: Every sentence teaches something or sets up the next thing
  that teaches something. If a sentence doesn't earn its place, cut it.
- **Show the trade-offs**: Don't just describe what was built. Explain what was
  NOT built and why. The road not taken is often more instructive.

### Code Blocks

- **Pseudocode only**: Never reproduce exact source code. Show the PATTERN,
  not the implementation.
- **3-5 blocks per chapter maximum**: Each block should be 5-15 lines.
- **Different variable names**: Use generic names that illustrate the concept,
  not the exact identifiers from the source.
- **Label as illustrative**: Add comments like `// Pseudocode — illustrates
  the pattern` or `// Simplified for clarity`.
- **Precede with context**: One sentence before the block explaining WHAT it
  shows. One paragraph after explaining WHY this pattern matters.

### Diagrams

- **Mermaid format**: Use ```mermaid fenced code blocks. These render natively
  on GitHub and in most web frameworks.
- **Every architectural concept gets a diagram**: Data flow, state machines,
  decision trees, timelines, component relationships.
- **Diagram types to use**:
  - `graph TD` / `graph LR` for architecture and data flow
  - `sequenceDiagram` for request/response flows and lifecycles
  - `stateDiagram-v2` for state machines
  - `flowchart TD` for decision trees and pipelines
  - `gantt` for timelines and parallel execution
- **2-4 diagrams per chapter**: More for complex chapters (core loop, tools),
  fewer for focused ones.

### Cross-References

- Every chapter starts with an explicit backward reference to the previous chapter
- Forward references when a concept will be expanded later: "Chapter N covers
  this in depth"
- Each concept has ONE canonical home — other chapters reference, not re-explain

### Consistency Checks

- No repeated rhetorical phrases across chapters
- Standardized "Apply This" format (5 patterns per chapter)
- No exact file counts or version numbers (they go stale)
- Consistent terminology throughout

## Phase 5: Editorial Review

Launch 2-3 review agents, each covering a section of the book. Each reviewer
evaluates:

1. **Opening quality**: Does it hook? Does it connect to the previous chapter?
2. **Flow**: Sections that drag, repeat, or list facts without building toward
   an insight?
3. **Content cuts**: What's reference-manual content that doesn't serve the
   narrative? Which code blocks are too long?
4. **Missing content**: Gaps where the reader would be confused? Missing
   transitions?
5. **Diagrams needed**: Specific places where a diagram would replace a wall
   of text. Describe each diagram in detail.
6. **Cross-chapter consistency**: Voice, formatting, terminology, contradictions.
7. **Specific fixes**: 5-10 sentences/paragraphs to rewrite, with reasons.

Compile all review feedback into a single prioritized action plan.

## Phase 6: Revision

Apply all review feedback in one pass:

- **Structural changes**: Split/merge chapters, fix broken references, add
  missing closing chapter if needed
- **Deduplication**: Each concept explained once, cross-referenced elsewhere
- **Content cuts**: Remove enumeration (keep patterns), trim bloated sections,
  compress reference-material content into tables
- **Content additions**: Worked examples, real-world hook examples, diagrams
  at identified locations
- **Consistency**: Standardize Apply This sections, fix repeated phrases,
  verify cross-references

## Phase 7: Source Code Audit

Before publication, audit every code block against the original source:

- **REPLACE** any block that is a verbatim or near-verbatim copy with
  pseudocode using different variable names
- **ANNOTATE** type signatures with "// Illustrative" comments
- **VERIFY** no proprietary prompt text, internal constants, or exact
  function implementations remain

The book teaches patterns and architecture. It should not enable reconstruction
of the exact source code.
```

---

## How It Was Used

This prompt produced **"Claude Code from Source"** — 18 chapters analyzing the architecture of Anthropic's AI coding agent, reverse-engineered from source maps leaked via npm.

**By the numbers:**
- 36 AI agents across 7 phases
- ~6 hours total production time
- Phase 1: 6 exploration agents read 1,884 source files
- Phase 2-3: Structured into 7 parts, 18 chapters
- Phase 4: 15 writing agents produced 10,320 lines
- Phase 5: 3 review agents produced 900 lines of feedback
- Phase 6: 3 revision agents cut 38% (-3,934 lines), added 25+ Mermaid diagrams
- Phase 7: 1 audit agent identified 35 exact copies, 1 sanitization agent replaced all with pseudocode
- Final output: 6,271 lines / ~400 pages equivalent
