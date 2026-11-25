# 简体中文术语表

关键术语在各章正文首次出现时标注英文，如“智能体循环（Agent Loop）”，后续使用约定译名。代码标识符、API 名称、命令、文件路径和配置键按原文保留。

| 英文 | 约定译名 | 用法 |
| --- | --- | --- |
| Agent | 智能体 | 用于指能够执行任务的主体。 |
| Agent Loop | 智能体循环 | 指智能体与模型及工具交互的循环。 |
| Agent Harness | 智能体运行支撑体系（Harness） | 保留 Harness，便于对照原书。 |
| Runtime | 运行时 | 如“运行时状态”。 |
| Context Engineering | 上下文工程 | |
| Context Compression | 上下文压缩 | |
| Prompt Cache | 提示词缓存 | |
| Tool Calling | 工具调用 | |
| AsyncGenerator | AsyncGenerator（异步生成器） | 首次出现时保留 TypeScript 类型名并附中文释义。 |
| State Machine | 状态机 | |
| Sub-Agent | 子智能体 | |
| Fork Agent | 分叉智能体 | 保留 fork 所表达的分叉含义。 |
| Orchestration | 编排 | |
| Streaming | 流式处理 | 特指响应时可写作“流式响应”。 |
| Backpressure | 背压 | |
| Speculative Execution | 推测执行 | 如“推测执行工具”。 |
| Permission System | 权限系统 | |
| Skill | Skill（技能） | 指 Claude Code 的扩展机制时，后续保留 Skill。 |
| Hook | Hook（钩子） | 指 Claude Code 的扩展机制时，后续保留 Hook。 |
| Snip Compact | 裁剪压缩 | 对应直接移除旧消息的压缩层。 |
| Microcompact | 微压缩 | 与裁剪压缩和自动压缩区分。 |
| Context Collapse | 上下文折叠 | 指用摘要替换选定的对话片段。 |
| Auto-Compact | 自动压缩 | 指达到阈值时主动触发的压缩。 |
| Reactive Compact | 按需压缩 | 指收到错误后触发的压缩，与主动触发的自动压缩区分。 |
| Withholding | 暂缓发出 | 错误留待恢复检查，恢复失败后再发出。 |
| Stop Hook | 停止 Hook | 对应模型结束响应时运行的 Hook。 |
| Sticky Latch | 保持型锁存标志 | 一旦开启，状态保持到本次会话结束。 |
| Trust Boundary | 信任边界 | 指用户确认前后所允许的操作边界。 |
| Memoization | 记忆化 | 缓存计算结果，供后续调用复用。 |
| Query Loop | 查询循环 | 侧重模型查询的代码流程时使用。 |
| Context Modifier | 上下文修改函数 | 为后续工具调用转换 `ToolUseContext`。 |
| Deferred Loading | 延迟加载 | 工具被发现后才加载完整参数模式。 |
| Result Budget | 结果预算 | 用于控制工具结果大小。 |
| Streaming Tool Executor | 流式工具执行器 | 能在模型仍输出响应时调度工具。 |
| Fail-Closed Default | 保守默认值 | 未作显式声明时沿用限制更严格的默认行为。 |
| Sidechain Transcript | 侧链会话记录 | 与主会话记录区分。 |
| Agent Swarm | 智能体集群 | 多个智能体组成的协作集群。 |
| Coordinator | 协调器 | Coordinator Mode 译为“协调模式”。 |
| Teammate | 队友 | 多智能体协作模式中参与通信的智能体。 |
| Frontmatter | 前置元数据 | Markdown 文件正文之前的 YAML 元数据。 |
| Snapshot | 快照 | 捕获某一时点的状态或配置。 |
| Side Query | 旁路查询 | 独立于主查询执行的辅助模型调用。 |
| Blit | 块复制 | 在缓冲区之间批量复制单元格。 |
| Interning Pool | 驻留池 | 将重复使用的值映射为可复用的 ID。 |
| Damage Rectangle | 脏区矩形 | 包围需要重新渲染的区域。 |
| Keybinding | 键位绑定 | 键或组合键与操作之间的映射。 |
| Escape Sequence | 转义序列 | 保留示例中的 ANSI 或其他终端转义序列。 |
| Fail Open | 故障放行 | 此处指代理失败时仍允许核心会话继续。 |
| Slot Reservation | 输出空间预留 | 指为模型响应预留输出 token。 |
| Token Utilization | token 利用率 | 有用上下文相对于额外开销的比例。 |
| Score-Bound Rejection | 得分上界排除 | 根据最高可能得分提前跳过候选项。 |
| Fuzzy Search | 模糊搜索 | 允许不完全匹配的搜索。 |
| API Preconnection | API 预连接 | 在实际请求之前建立连接。 |
