import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";

// --- Types ---

interface Message {
  id: string;
  type: "user" | "assistant" | "tool_result";
  label: string;
  tokens: number;
  visible: boolean;
  compressed: boolean;
  summary: boolean;
  height: number; // visual height in px
}

// --- Initial conversation ---

function createConversation(): Message[] {
  return [
    { id: "u1", type: "user", label: "프로젝트 구조 설정", tokens: 400, visible: true, compressed: false, summary: false, height: 28 },
    { id: "a1", type: "assistant", label: "디렉토리와 파일을 생성하겠습니다.", tokens: 1200, visible: true, compressed: false, summary: false, height: 36 },
    { id: "t1", type: "tool_result", label: "Bash: mkdir -p src/comComponents (출력: 2.1K 문자)", tokens: 3800, visible: true, compressed: false, summary: false, height: 44 },
    { id: "t2", type: "tool_result", label: "쓰기: src/index.ts (출력: 4.5K 자)", tokens: 6200, visible: true, compressed: false, summary: false, height: 52 },
    { id: "a2", type: "assistant", label: "이제 빌드 시스템을 구성하겠습니다.", tokens: 2400, visible: true, compressed: false, summary: false, height: 38 },
    { id: "t3", type: "tool_result", label: "읽기: package.json(출력: 8.2K자)", tokens: 12000, visible: true, compressed: false, summary: false, height: 56 },
    { id: "t4", type: "tool_result", label: "Glob: **/*.config.ts(출력: 1.8K 문자)", tokens: 2800, visible: true, compressed: false, summary: false, height: 40 },
    { id: "u2", type: "user", label: "이제 세션으로 인증을 추가하세요.", tokens: 600, visible: true, compressed: false, summary: false, height: 28 },
    { id: "a3", type: "assistant", label: "더 나은 인증으로 세션 기반 인증을 구현하겠습니다.", tokens: 3200, visible: true, compressed: false, summary: false, height: 42 },
    { id: "t5", type: "tool_result", label: "읽기: src/auth/config.ts(출력: 12K 문자)", tokens: 18000, visible: true, compressed: false, summary: false, height: 62 },
    { id: "t6", type: "tool_result", label: "쓰기: src/auth/session.ts (출력: 6.8K 자)", tokens: 9400, visible: true, compressed: false, summary: false, height: 54 },
    { id: "t7", type: "tool_result", label: "읽기: src/database/schema.ts(출력: 22K 문자)", tokens: 28000, visible: true, compressed: false, summary: false, height: 68 },
    { id: "a4", type: "assistant", label: "인증이 설정되었습니다. 미들웨어를 추가하겠습니다.", tokens: 1800, visible: true, compressed: false, summary: false, height: 36 },
    { id: "t8", type: "tool_result", label: "쓰기: src/middleware/auth.ts (출력: 9.1K 문자)", tokens: 14000, visible: true, compressed: false, summary: false, height: 58 },
    { id: "u3", type: "user", label: "리소스에 대한 CRUD 엔드포인트 추가", tokens: 500, visible: true, compressed: false, summary: false, height: 28 },
    { id: "a5", type: "assistant", label: "각 리소스에 대해 tRPC 라우터를 생성하겠습니다.", tokens: 4200, visible: true, compressed: false, summary: false, height: 44 },
    { id: "t9", type: "tool_result", label: "읽기: src/routers/index.ts(출력: 15K 문자)", tokens: 22000, visible: true, compressed: false, summary: false, height: 64 },
    { id: "t10", type: "tool_result", label: "쓰기: src/routers/users.ts (출력: 11K 문자)", tokens: 16000, visible: true, compressed: false, summary: false, height: 60 },
    { id: "t11", type: "tool_result", label: "쓰기: src/routers/posts.ts (출력: 14K 문자)", tokens: 20000, visible: true, compressed: false, summary: false, height: 64 },
    { id: "a6", type: "assistant", label: "라우터가 준비되었습니다. 유형 검사 실행 중...", tokens: 1600, visible: true, compressed: false, summary: false, height: 34 },
    { id: "t12", type: "tool_result", label: "Bash: 번 실행 검사 유형(출력: 18,000자)", tokens: 24000, visible: true, compressed: false, summary: false, height: 66 },
    { id: "t13", type: "tool_result", label: "Bash: 번 실행 테스트(출력: 6.2K 자)", tokens: 8400, visible: true, compressed: false, summary: false, height: 52 },
  ];
}

const TOTAL_CAPACITY = 200000;

// --- Layer definitions ---

interface Layer {
  id: number;
  name: string;
  description: string;
  apply: (messages: Message[]) => Message[];
}

const layers: Layer[] = [
  {
    id: 1,
    name: "도구 결과 예산",
    description: "메시지당 크기 제한을 적용합니다. 예산에 맞게 대형 도구 출력을 잘라냅니다.",
    apply: (msgs) =>
      msgs.map((m) => {
        if (m.type === "tool_result" && m.tokens > 10000) {
          return {
            ...m,
            tokens: Math.floor(m.tokens * 0.4),
            compressed: true,
            height: Math.max(32, Math.floor(m.height * 0.5)),
            label: m.label.replace(/output: [\d.]+K chars/, "clipped to budget"),
          };
        }
        return m;
      }),
  },
  {
    id: 2,
    name: "스닙 컴팩트",
    description: "대화에서 오래된 메시지를 물리적으로 제거합니다. 시스템 프롬프트와 최신 상황을 유지합니다.",
    apply: (msgs) => {
      // Remove first ~30% of visible messages
      const visibleIds = msgs.filter((m) => m.visible).map((m) => m.id);
      const cutoff = Math.floor(visibleIds.length * 0.3);
      const toRemove = new Set(visibleIds.slice(0, cutoff));
      return msgs.map((m) =>
        toRemove.has(m.id) ? { ...m, visible: false } : m,
      );
    },
  },
  {
    id: 3,
    name: "Microcompact",
    description: "캐시에서 오래된 도구 결과를 제거합니다. 구조를 유지하고 이전 도구 출력의 콘텐츠를 삭제합니다.",
    apply: (msgs) =>
      msgs.map((m) => {
        if (m.type === "tool_result" && m.visible && !m.compressed) {
          return {
            ...m,
            tokens: Math.floor(m.tokens * 0.3),
            compressed: true,
            height: 24,
            label: m.label.replace(/\(output:.*\)/, "(cached: stub)"),
          };
        }
        return m;
      }),
  },
  {
    id: 4,
    name: "컨텍스트 축소",
    description: "장황한 메시지 범위를 AI 생성 요약으로 대체합니다.",
    apply: (msgs) => {
      const visible = msgs.filter((m) => m.visible);
      if (visible.length <= 4) return msgs;
      // Collapse middle section into a summary
      const middleStart = 2;
      const middleEnd = visible.length - 2;
      const middleIds = new Set(
        visible.slice(middleStart, middleEnd).map((m) => m.id),
      );
      const collapsedTokens = msgs
        .filter((m) => middleIds.has(m.id))
        .reduce((sum, m) => sum + m.tokens, 0);
      const result = msgs.map((m) =>
        middleIds.has(m.id) ? { ...m, visible: false } : m,
      );
      // Insert summary after last visible before middle
      const insertIdx = result.findIndex((m) => m.id === visible[middleStart - 1].id) + 1;
      result.splice(insertIdx, 0, {
        id: "summary-1",
        type: "assistant",
        label: "[요약] 프로젝트 설정, 인증 설정, 라우터 생성, 점검 실행",
        tokens: Math.floor(collapsedTokens * 0.08),
        visible: true,
        compressed: false,
        summary: true,
        height: 32,
      });
      return result;
    },
  },
  {
    id: 5,
    name: "Auto-Compact",
    description: "긴급 전체 요약. 전체 대화를 간결한 요약으로 대체합니다. 회로 차단기는 반복되는 트리거를 방지합니다.",
    apply: (msgs) => {
      const totalTokens = msgs
        .filter((m) => m.visible)
        .reduce((sum, m) => sum + m.tokens, 0);
      return [
        {
          id: "auto-summary",
          type: "assistant" as const,
          label: "[자동 압축 요약] 전체 세션 컨텍스트: 프로젝트 설정, 인증 구현, CRUD 라우터, 유형 검사 통과, 녹색 테스트",
          tokens: Math.min(30000, Math.floor(totalTokens * 0.15)),
          visible: true,
          compressed: false,
          summary: true,
          height: 40,
        },
      ];
    },
  },
];

// --- Component ---

interface Props {
  className?: string;
}

export default function CompressionLayers({ className }: Props) {
  const [messages, setMessages] = useState<Message[]>(createConversation);
  const [appliedLayers, setAppliedLayers] = useState(0);
  const [savedPerLayer, setSavedPerLayer] = useState<number[]>([]);
  const [isDark, setIsDark] = useState(false);

  // Dark mode detection
  useEffect(() => {
    const check = () =>
      setIsDark(document.documentElement.classList.contains("dark"));
    check();
    window.addEventListener("theme-changed", check);
    const observer = new MutationObserver(check);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => {
      window.removeEventListener("theme-changed", check);
      observer.disconnect();
    };
  }, []);

  const totalTokens = messages
    .filter((m) => m.visible)
    .reduce((sum, m) => sum + m.tokens, 0);
  const usagePercent = (totalTokens / TOTAL_CAPACITY) * 100;

  const getTokenColor = () => {
    if (usagePercent < 50) return "#22c55e";
    if (usagePercent < 80) return "#eab308";
    return "#ef4444";
  };

  const getMessageColor = (msg: Message) => {
    if (msg.summary) return "#eda100";
    if (msg.type === "user") return "#d97757";
    if (msg.type === "assistant") return isDark ? "#87867f" : "#87867f";
    return isDark ? "#555" : "#c2c0b6";
  };

  const handleApplyLayer = useCallback(() => {
    if (appliedLayers >= 5) return;
    const layer = layers[appliedLayers];
    const tokensBefore = messages
      .filter((m) => m.visible)
      .reduce((sum, m) => sum + m.tokens, 0);
    const newMessages = layer.apply(messages);
    const tokensAfter = newMessages
      .filter((m) => m.visible)
      .reduce((sum, m) => sum + m.tokens, 0);
    setMessages(newMessages);
    setSavedPerLayer((prev) => [...prev, tokensBefore - tokensAfter]);
    setAppliedLayers((prev) => prev + 1);
  }, [appliedLayers, messages]);

  const handleReset = useCallback(() => {
    setMessages(createConversation());
    setAppliedLayers(0);
    setSavedPerLayer([]);
  }, []);

  const colors = {
    text: isDark ? "#f5f4ed" : "#141413",
    textMuted: isDark ? "#87867f" : "#87867f",
    border: isDark ? "#333" : "#c2c0b6",
    panelBg: isDark ? "rgba(30,30,28,0.5)" : "rgba(255,255,255,0.5)",
    barBg: isDark ? "#2a2a28" : "#e8e7e3",
  };

  const formatTokens = (n: number) => {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
    return String(n);
  };

  return (
    <div className={className} style={{ fontFamily: "var(--font-serif)" }}>
      {/* Token counter */}
      <div style={{ marginBottom: 20 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            marginBottom: 8,
          }}
        >
          <span
            style={{
              fontSize: 14,
              fontFamily: "var(--font-mono)",
              color: colors.text,
              fontWeight: 600,
            }}
          >
            사용:{" "}
            <motion.span
              key={totalTokens}
              initial={{ opacity: 0.5 }}
              animate={{ opacity: 1 }}
              style={{ color: getTokenColor() }}
            >
              {formatTokens(totalTokens)}
            </motion.span>{" "}
            / {formatTokens(TOTAL_CAPACITY)} 토큰
          </span>
          <span
            style={{
              fontSize: 12,
              fontFamily: "var(--font-mono)",
              color: colors.textMuted,
            }}
          >
            {usagePercent.toFixed(0)}% 용량
          </span>
        </div>
        <div
          style={{
            height: 8,
            borderRadius: 4,
            background: colors.barBg,
            overflow: "hidden",
          }}
        >
          <motion.div
            animate={{ width: `${Math.min(100, usagePercent)}%` }}
            transition={{ duration: 0.6, ease: "easeOut" }}
            style={{
              height: "100%",
              borderRadius: 4,
              background: getTokenColor(),
            }}
          />
        </div>
      </div>

      {/* Main layout: messages + layers */}
      <div style={{ display: "flex", gap: 20, alignItems: "flex-start" }}>
        {/* Message stack */}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            border: `1px solid ${colors.border}`,
            borderRadius: 12,
            padding: 16,
            background: colors.panelBg,
            maxHeight: 420,
            overflowY: "auto",
          }}
        >
          <div
            style={{
              fontSize: 11,
              fontFamily: "var(--font-mono)",
              color: colors.textMuted,
              marginBottom: 12,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
            }}
          >
            대화({messages.filter((m) => m.visible).length} 메시지)
          </div>
          <AnimatePresence>
            {messages.map(
              (msg) =>
                msg.visible && (
                  <motion.div
                    key={msg.id}
                    layout
                    initial={{ opacity: 0, height: 0 }}
                    animate={{
                      opacity: 1,
                      height: msg.height,
                    }}
                    exit={{
                      opacity: 0,
                      height: 0,
                      marginBottom: 0,
                    }}
                    transition={{ duration: 0.4, ease: "easeInOut" }}
                    style={{
                      borderRadius: 6,
                      marginBottom: 6,
                      overflow: "hidden",
                      position: "relative",
                      display: "flex",
                      alignItems: "center",
                      paddingInline: 12,
                      background: msg.summary
                        ? "rgba(237, 161, 0, 0.12)"
                        : msg.compressed
                          ? isDark
                            ? "rgba(255,255,255,0.03)"
                            : "rgba(0,0,0,0.02)"
                          : isDark
                            ? "rgba(255,255,255,0.05)"
                            : "rgba(0,0,0,0.03)",
                      borderLeft: `3px solid ${getMessageColor(msg)}`,
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 12,
                          color: msg.summary ? "#eda100" : colors.text,
                          fontFamily: "var(--font-mono)",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          fontWeight: msg.summary ? 600 : 400,
                        }}
                      >
                        {msg.label}
                      </div>
                    </div>
                    <div
                      style={{
                        fontSize: 10,
                        fontFamily: "var(--font-mono)",
                        color: colors.textMuted,
                        marginLeft: 8,
                        whiteSpace: "nowrap",
                        flexShrink: 0,
                      }}
                    >
                      {formatTokens(msg.tokens)}
                    </div>
                  </motion.div>
                ),
            )}
          </AnimatePresence>
        </div>

        {/* Layer controls */}
        <div style={{ width: 220, flexShrink: 0 }}>
          <div
            style={{
              fontSize: 11,
              fontFamily: "var(--font-mono)",
              color: colors.textMuted,
              marginBottom: 12,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
            }}
          >
            압축 레이어
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {layers.map((layer, i) => {
              const isNext = i === appliedLayers;
              const isApplied = i < appliedLayers;
              return (
                <div key={layer.id}>
                  <button
                    onClick={isNext ? handleApplyLayer : undefined}
                    disabled={!isNext}
                    title={layer.description}
                    style={{
                      width: "100%",
                      textAlign: "left",
                      background: isApplied
                        ? "rgba(217, 119, 87, 0.1)"
                        : isNext
                          ? isDark
                            ? "rgba(255,255,255,0.05)"
                            : "rgba(0,0,0,0.03)"
                          : "transparent",
                      border: isNext
                        ? `2px solid #d97757`
                        : `1px solid ${isApplied ? "rgba(217, 119, 87, 0.3)" : colors.border}`,
                      borderRadius: 8,
                      padding: "10px 12px",
                      cursor: isNext ? "pointer" : "default",
                      opacity: !isNext && !isApplied ? 0.4 : 1,
                      transition: "all 0.2s",
                    }}
                  >
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 600,
                        fontFamily: "var(--font-mono)",
                        color: isApplied ? "#d97757" : isNext ? colors.text : colors.textMuted,
                        marginBottom: 2,
                      }}
                    >
                      {layer.id}. {layer.name}
                    </div>
                    <div
                      style={{
                        fontSize: 11,
                        color: colors.textMuted,
                        lineHeight: 1.4,
                      }}
                    >
                      {isApplied && savedPerLayer[i] !== undefined
                        ? `Saved ${formatTokens(savedPerLayer[i])} tokens`
                        : isNext
                          ? "신청하려면 클릭하세요"
                          : layer.description.slice(0, 50) + "..."}
                    </div>
                  </button>
                </div>
              );
            })}
          </div>

          {/* Reset */}
          <button
            onClick={handleReset}
            style={{
              marginTop: 16,
              width: "100%",
              background: "transparent",
              border: `1px solid ${colors.border}`,
              color: colors.textMuted,
              borderRadius: 6,
              padding: "8px 12px",
              fontSize: 12,
              cursor: "pointer",
              fontFamily: "var(--font-mono)",
            }}
          >
            대화 재설정
          </button>

          {/* Total saved */}
          {savedPerLayer.length > 0 && (
            <div
              style={{
                marginTop: 12,
                padding: "10px 12px",
                borderRadius: 8,
                background: "rgba(34, 197, 94, 0.08)",
                border: "1px solid rgba(34, 197, 94, 0.2)",
              }}
            >
              <div
                style={{
                  fontSize: 12,
                  fontFamily: "var(--font-mono)",
                  color: "#22c55e",
                  fontWeight: 600,
                }}
              >
                저장된 총 금액:{" "}
                {formatTokens(savedPerLayer.reduce((a, b) => a + b, 0))} 토큰
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
