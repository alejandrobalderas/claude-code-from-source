# Chapter 15: MCP -- The Universal Tool Protocol

## Why MCP Matters Beyond Claude Code

Every other chapter in this book is about Claude Code's internals. This one is different. The Model Context Protocol is an open specification that any agent can implement, and Claude Code's MCP subsystem is one of the most complete production clients in existence. If you are building an agent that needs to call external tools -- any agent, in any language, on any model -- the patterns in this chapter transfer directly.

The core proposition is straightforward: MCP defines a JSON-RPC 2.0 protocol for tool discovery and invocation between a client (the agent) and a server (the tool provider). The client sends `tools/list` to discover what a server offers, then `tools/call` to execute. The server describes each tool with a name, description, and JSON Schema for its inputs. That is the entire contract. Everything else -- transport selection, authentication, config loading, tool name normalization -- is the implementation work that turns a clean spec into something that survives contact with the real world.

Claude Code's MCP implementation spans four core files: `types.ts`, `client.ts`, `auth.ts`, and `InProcessTransport.ts`. Together they support eight transport types, seven configuration scopes, OAuth discovery across two RFCs, and a tool wrapping layer that makes MCP tools indistinguishable from built-in ones -- the same `Tool` interface covered in Chapter 6. This chapter walks through each layer.

---

## Eight Transport Types

The first design decision in any MCP integration is how the client talks to the server. Claude Code supports eight transport configurations:

```mermaid
flowchart TD
    Q{Where is the<br/>MCP server?}
    Q -->|Same machine| LOCAL
    Q -->|Remote service| REMOTE
    Q -->|Same process| INPROC
    Q -->|IDE extension| IDE

    subgraph LOCAL["Local Process"]
        STDIO["stdio<br/>stdin/stdout JSON-RPC<br/>Default, no auth"]
    end

    subgraph REMOTE["Remote Server"]
        HTTP["http (Streamable HTTP)<br/>Current spec, POST + optional SSE"]
        SSE["sse (Server-Sent Events)<br/>Legacy transport, pre-2025"]
        WS["ws (WebSocket)<br/>Bidirectional, rare"]
        PROXY["claudeai-proxy<br/>Via Claude.ai infrastructure"]
    end

    subgraph INPROC["In-Process"]
        SDK["sdk<br/>Control messages over stdin/stdout"]
        LINKED["InProcessTransport<br/>Direct function calls, 63 lines"]
    end

    subgraph IDE["IDE Extension"]
        SSEIDE["sse-ide"]
        WSIDE["ws-ide"]
    end

    style STDIO fill:#c8e6c9
    style HTTP fill:#bbdefb
```

Three design choices are worth noting. First, `stdio` is the default -- when `type` is omitted, the system assumes a local subprocess. This is backwards-compatible with the earliest MCP configs. Second, the fetch wrappers stack: timeout wrapping outside step-up detection, outside the base fetch. Each wrapper handles one concern. Third, the `ws-ide` branch has a Bun/Node runtime split -- Bun's `WebSocket` accepts proxy and TLS options natively, while Node requires the `ws` package.

**When to use which.** For local tools (filesystem, database, custom scripts), `stdio` -- no network, no auth, just pipes. For remote services, `http` (Streamable HTTP) is the current spec recommendation. `sse` is legacy but widely deployed. The `sdk`, IDE, and `claudeai-proxy` types are internal to their respective ecosystems.

---

## Configuration Loading and Scoping

MCP server configs load from seven scopes, merged and deduplicated:

| Scope | Source | Trust |
|-------|--------|-------|
| `local` | `.mcp.json` in working directory | Requires user approval |
| `user` | `~/.claude.json` mcpServers field | User-managed |
| `project` | Project-level config | Shared project settings |
| `enterprise` | Managed enterprise config | Pre-approved by org |
| `managed` | Plugin-provided servers | Auto-discovered |
| `claudeai` | Claude.ai web interface | Pre-authorized via web |
| `dynamic` | Runtime injection (SDK) | Programmatically added |

**Deduplication is content-based, not name-based.** Two servers with different names but the same command or URL are recognized as the same server. The `getMcpServerSignature()` function computes a canonical key: `stdio:["command","arg1"]` for local servers, `url:https://example.com/mcp` for remote ones. Plugin-provided servers whose signature matches a manual config are suppressed.

---

## Tool Wrapping: From MCP to Claude Code

When a connection succeeds, the client calls `tools/list`. Each tool definition is transformed into Claude Code's internal `Tool` interface -- the same interface used by built-in tools. After wrapping, the model cannot distinguish between a built-in tool and an MCP tool.

The wrapping process has four stages:

**1. Name normalization.** `normalizeNameForMCP()` replaces invalid characters with underscores. The fully qualified name follows `mcp__{serverName}__{toolName}`.

**2. Description truncation.** Capped at 2,048 characters. OpenAPI-generated servers have been observed dumping 15-60KB into `tool.description` -- roughly 15,000 tokens per turn for a single tool.

**3. Schema passthrough.** The tool's `inputSchema` passes directly to the API. No transformation, no validation at wrapping time. Schema errors surface at call time, not registration time.

**4. Annotation mapping.** MCP annotations map to behavior flags: `readOnlyHint` marks tools safe for concurrent execution (as discussed in Chapter 7's streaming executor), `destructiveHint` triggers extra permission scrutiny. These annotations come from the MCP server -- a malicious server could mark a destructive tool as read-only. This is an accepted trust boundary, but one worth understanding: the user opted into the server, and a malicious server marking destructive tools as read-only is a real attack vector. The system accepts this tradeoff because the alternative -- ignoring annotations entirely -- would prevent legitimate servers from improving the user experience.

---

## OAuth for MCP Servers

Remote MCP servers often require authentication. Claude Code implements the full OAuth 2.0 + PKCE flow with RFC-based discovery, Cross-App Access, and error body normalization.

### Discovery Chain

```mermaid
flowchart TD
    A[Server returns 401] --> B["RFC 9728 probe<br/>GET /.well-known/oauth-protected-resource"]
    B -->|Found| C["Extract authorization_servers[0]"]
    C --> D["RFC 8414 discovery<br/>against auth server URL"]
    B -->|Not found| E["RFC 8414 fallback<br/>against MCP server URL with path-aware probing"]
    D -->|Found| F[Authorization Server Metadata<br/>token endpoint, auth endpoint, scopes]
    E -->|Found| F
    D -->|Not found| G{authServerMetadataUrl<br/>configured?}
    E -->|Not found| G
    G -->|Yes| H[Direct metadata fetch<br/>bypass discovery]
    G -->|No| I[Fail: no auth metadata]
    H --> F

    style F fill:#c8e6c9
    style I fill:#ffcdd2
```

The `authServerMetadataUrl` escape hatch exists because some OAuth servers implement neither RFC.

### Cross-App Access (XAA)

When an MCP server config has `oauth.xaa: true`, the system performs federated token exchange through an Identity Provider -- one IdP login unlocks multiple MCP servers.

### Error Body Normalization

The `normalizeOAuthErrorBody()` function handles OAuth servers that violate the spec. Slack returns HTTP 200 for error responses with the error buried in the JSON body. The function peeks at 2xx POST response bodies, and when the body matches `OAuthErrorResponseSchema` but not `OAuthTokensSchema`, rewrites the response to HTTP 400. It also normalizes Slack-specific error codes (`invalid_refresh_token`, `expired_refresh_token`, `token_expired`) to the standard `invalid_grant`.

---

## In-Process Transport

Not every MCP server needs to be a separate process. The `InProcessTransport` class enables running an MCP server and client in the same process:

```typescript
class InProcessTransport implements Transport {
  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) throw new Error('Transport is closed')
    queueMicrotask(() => { this.peer?.onmessage?.(message) })
  }
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.onclose?.()
    if (this.peer && !this.peer.closed) {
      this.peer.closed = true
      this.peer.onclose?.()
    }
  }
}
```

The entire file is 63 lines. Two design decisions deserve attention. First, `send()` delivers via `queueMicrotask()` to prevent stack depth issues in synchronous request/response cycles. Second, `close()` cascades to the peer, preventing half-open states. The Chrome MCP server and Computer Use MCP server both use this pattern.

---

## Connection Management

### Connection States

Each MCP server connection exists in one of five states: `connected`, `failed`, `needs-auth` (with a 15-minute TTL cache to prevent 30 servers from independently discovering the same expired token), `pending`, or `disabled`.

### Session Expiry Detection

MCP's Streamable HTTP transport uses session IDs. When a server restarts, requests return HTTP 404 with JSON-RPC error code -32001. The `isMcpSessionExpiredError()` function checks both signals -- note that it uses string inclusion on the error message to detect the error code, which is pragmatic but fragile:

```typescript
export function isMcpSessionExpiredError(error: Error): boolean {
  const httpStatus = 'code' in error ? (error as any).code : undefined
  if (httpStatus !== 404) return false
  return error.message.includes('"code":-32001') ||
    error.message.includes('"code": -32001')
}
```

On detection, the connection cache clears and the call retries once.

### Batched Connections

Local servers connect in batches of 3 (spawning processes can exhaust file descriptors), remote servers in batches of 20. The React context provider `MCPConnectionManager.tsx` manages the lifecycle, diffing current connections against new configs.

---

## Claude.ai Proxy Transport

The `claudeai-proxy` transport illustrates a common agent integration pattern: connecting through an intermediary. Claude.ai subscribers configure MCP "connectors" through the web interface, and the CLI routes through Claude.ai's infrastructure which handles vendor-side OAuth.

The `createClaudeAiProxyFetch()` function captures the `sentToken` at request time, not re-read after a 401. Under concurrent 401s from multiple connectors, another connector's retry might have already refreshed the token. The function also checks for concurrent refreshes even when the refresh handler returns false -- the "ELOCKED contention" case where another connector won the lockfile race.

---

## Timeout Architecture

MCP timeouts are layered, each protecting against a different failure mode:

| Layer | Duration | Protects Against |
|-------|----------|------------------|
| Connection | 30s | Unreachable or slow-starting servers |
| Per-request | 60s (fresh per request) | Stale timeout signal bug |
| Tool call | ~27.8 hours | Legitimately long operations |
| Auth | 30s per OAuth request | Unreachable OAuth servers |

The per-request timeout deserves emphasis. Early implementations created a single `AbortSignal.timeout(60000)` at connection time. After 60 seconds of idle time, the next request would abort immediately -- the signal was already expired. The fix: `wrapFetchWithTimeout()` creates a fresh timeout signal for every request. It also normalizes the `Accept` header as a last-step defense against runtimes and proxies that drop it.

---

## Apply This: Integrating MCP Into Your Own Agent

**Start with stdio, add complexity later.** `StdioClientTransport` handles everything: spawn, pipe, kill. One line of config, one transport class, and you have MCP tools.

**Normalize names and truncate descriptions.** Names must match `^[a-zA-Z0-9_-]{1,64}$`. Prefix with `mcp__{serverName}__` to avoid collisions. Cap descriptions at 2,048 characters -- OpenAPI-generated servers will waste context tokens otherwise.

**Handle auth lazily.** Do not attempt OAuth until a server returns 401. Most stdio servers need no auth.

**Use in-process transport for built-in servers.** `createLinkedTransportPair()` eliminates subprocess overhead for servers you control.

**Respect tool annotations and sanitize output.** `readOnlyHint` enables concurrent execution. Sanitize responses against malicious Unicode (bidirectional overrides, zero-width joiners) that could mislead the model.

The MCP protocol is deliberately minimal -- two JSON-RPC methods. Everything between those methods and a production deployment is engineering: eight transports, seven config scopes, two OAuth RFCs, and timeout layering. Claude Code's implementation shows what that engineering looks like at scale.

The next chapter examines what happens when the agent reaches beyond localhost: the remote execution protocols that let Claude Code run in cloud containers, accept instructions from web browsers, and tunnel API traffic through credential-injecting proxies.
