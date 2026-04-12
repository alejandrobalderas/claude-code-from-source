#!/usr/bin/env node
/**
 * Combines all 18 book chapters into a single markdown file
 * with cover, title page, copyright, table of contents, and part dividers.
 * Output: book-combined.md (gitignored — run `make pdf` to regenerate)
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const CHAPTERS = [
  'ch01-architecture',
  'ch02-bootstrap',
  'ch03-state',
  'ch04-api-layer',
  'ch05-agent-loop',
  'ch06-tools',
  'ch07-concurrency',
  'ch08-sub-agents',
  'ch09-fork-agents',
  'ch10-coordination',
  'ch11-memory',
  'ch12-extensibility',
  'ch13-terminal-ui',
  'ch14-input-interaction',
  'ch15-mcp',
  'ch16-remote',
  'ch17-performance',
  'ch18-epilogue',
];

const PARTS = {
  1:  { num: 'Part I',   name: 'Foundations',                   tagline: 'Before the agent can think, the process must exist.' },
  5:  { num: 'Part II',  name: 'The Core Loop',                 tagline: 'The heartbeat of the agent: stream, act, observe, repeat.' },
  8:  { num: 'Part III', name: 'Multi-Agent Orchestration',     tagline: 'One agent is powerful. Many agents working together are transformative.' },
  11: { num: 'Part IV',  name: 'Persistence and Intelligence',  tagline: 'An agent without memory makes the same mistakes forever.' },
  13: { num: 'Part V',   name: 'The Interface',                 tagline: 'Everything the user sees passes through this layer.' },
  15: { num: 'Part VI',  name: 'Connectivity',                  tagline: 'The agent reaches beyond localhost.' },
  17: { num: 'Part VII', name: 'Performance Engineering',       tagline: "Making it all fast enough that humans don't notice the machinery." },
};

const TOC = [
  [1,  'The Architecture of an AI Agent',               'The 6 key abstractions, data flow, permission system'],
  [2,  'Starting Fast — The Bootstrap Pipeline',        '5-phase init, module-level I/O parallelism, trust boundary'],
  [3,  'State — The Two-Tier Architecture',             'Bootstrap singleton, AppState store, sticky latches, cost tracking'],
  [4,  'Talking to Claude — The API Layer',             'Multi-provider client, prompt cache, streaming, error recovery'],
  [5,  'The Agent Loop',                                '4-layer compression, error recovery, token budgets'],
  [6,  'Tools — From Definition to Execution',          'Tool interface, 14-step pipeline, permission system'],
  [7,  'Concurrent Tool Execution',                     'Partition algorithm, streaming executor, speculative execution'],
  [8,  'Spawning Sub-Agents',                           'AgentTool, 15-step runAgent lifecycle, built-in agent types'],
  [9,  'Fork Agents and the Prompt Cache',              'Byte-identical prefix trick, cache sharing, cost optimization'],
  [10, 'Tasks, Coordination, and Swarms',               'Task state machine, coordinator mode, swarm messaging'],
  [11, 'Memory — Learning Across Conversations',        'File-based memory, 4-type taxonomy, LLM recall, staleness'],
  [12, 'Extensibility — Skills and Hooks',              'Two-phase skill loading, lifecycle hooks, snapshot security'],
  [13, 'The Terminal UI',                               'Custom Ink fork, rendering pipeline, double-buffer, pools'],
  [14, 'Input and Interaction',                         'Key parsing, keybindings, chord support, vim mode'],
  [15, 'MCP — The Universal Tool Protocol',             '8 transports, OAuth for MCP, tool wrapping'],
  [16, 'Remote Control and Cloud Execution',            'Bridge v1/v2, CCR, upstream proxy'],
  [17, 'Performance — Every Millisecond and Token Counts', 'Startup, context window, prompt cache, rendering, search'],
  [18, 'Epilogue — What We Learned',                   'The 5 architectural bets, what transfers, where agents are heading'],
];

const TOC_PARTS = [
  { name: 'Part I — Foundations',                  chapters: [1, 2, 3, 4] },
  { name: 'Part II — The Core Loop',               chapters: [5, 6, 7] },
  { name: 'Part III — Multi-Agent Orchestration',  chapters: [8, 9, 10] },
  { name: 'Part IV — Persistence and Intelligence',chapters: [11, 12] },
  { name: 'Part V — The Interface',                chapters: [13, 14] },
  { name: 'Part VI — Connectivity',               chapters: [15, 16] },
  { name: 'Part VII — Performance Engineering',   chapters: [17, 18] },
];

function block(html) {
  return html + '\n';
}

const lines = [];

// Cover page
lines.push(block(`<div class="cover-page"><img src="web/public/cover.jpg" alt="Claude Code from Source" class="cover-img" /></div>`));
lines.push(block(`<div class="page-break"></div>`));

// Title page
lines.push(block(`<div class="title-page">
  <div class="title-page-inner">
    <p class="title-page-subtitle">AN IN-DEPTH TECHNICAL ANALYSIS</p>
    <h1 class="title-page-title">Claude Code<br/>from Source</h1>
    <p class="title-page-desc">Architecture, Patterns &amp; Internals of<br/>Anthropic's AI Coding Agent</p>
    <div class="title-page-rule"></div>
    <p class="title-page-year">2024</p>
  </div>
</div>`));
lines.push(block(`<div class="page-break"></div>`));

// Copyright page
lines.push(block(`<div class="copyright-page">
  <div class="copyright-inner">
    <p class="copyright-title">Claude Code from Source</p>
    <p class="copyright-subtitle">Architecture, Patterns &amp; Internals of Anthropic's AI Coding Agent</p>
    <div class="copyright-divider"></div>
    <p><strong>Educational Use Only</strong></p>
    <p>This work contains no source code from Claude Code. Every code block is original pseudocode written to illustrate architectural patterns. No proprietary prompt text, internal constants, or exact function implementations are included.</p>
    <p>The analysis is based on TypeScript patterns extracted from publicly available npm packages. This book exists to help engineers understand the design principles behind production AI coding agents.</p>
    <p><em>This project has no affiliation with, and is not endorsed by, Anthropic.</em></p>
    <div class="copyright-divider"></div>
    <p class="copyright-meta">18 chapters · 7 parts · ~400 pages equivalent<br/>Produced by 36 AI agents across ~6 hours</p>
  </div>
</div>`));
lines.push(block(`<div class="page-break"></div>`));

// Table of contents
const tocEntries = TOC_PARTS.map(part => {
  const entries = part.chapters
    .map(n => {
      const [, title] = TOC.find(([num]) => num === n);
      return `<div class="toc-entry"><span class="toc-ch">Chapter ${n}</span><span class="toc-title-text">${title}</span></div>`;
    })
    .join('\n    ');
  return `<div class="toc-part">${part.name}</div>\n    ${entries}`;
}).join('\n\n    ');

lines.push(block(`<div class="toc-page">
  <h2 class="toc-title">Contents</h2>
  <div class="toc-body">
    ${tocEntries}
  </div>
</div>`));
lines.push(block(`<div class="page-break"></div>`));

// Chapters with part dividers
CHAPTERS.forEach((slug, i) => {
  const chNum = i + 1;
  if (PARTS[chNum]) {
    const { num, name, tagline } = PARTS[chNum];
    lines.push(block(`<div class="part-divider">
  <div class="part-divider-inner">
    <p class="part-label">${num}</p>
    <h2 class="part-title">${name}</h2>
    <p class="part-tagline">${tagline}</p>
  </div>
</div>`));
    lines.push(block(`<div class="page-break"></div>`));
  }

  const content = fs.readFileSync(path.join(ROOT, 'book', `${slug}.md`), 'utf8');
  lines.push(content + '\n');
  lines.push(block(`<div class="page-break"></div>`));
});

const output = lines.join('\n');
fs.writeFileSync(path.join(ROOT, 'book-combined.md'), output);
console.log(`✔ book-combined.md written (${output.split('\n').length} lines)`);
