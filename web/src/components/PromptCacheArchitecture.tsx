import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";

// --- Types ---

interface Section {
  id: string;
  label: string;
  sublabel: string;
  tokens: number;
  region: "stable" | "semi-stable" | "volatile";
}

// --- Hooks ---

function useDarkMode() {
  const [isDark, setIsDark] = useState(false);
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
  return isDark;
}

function useAnimatedNumber(value: number, duration = 300) {
  const [display, setDisplay] = useState(value);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const start = display;
    const startTime = performance.now();

    const tick = (now: number) => {
      const elapsed = now - startTime;
      const t = Math.min(elapsed / duration, 1);
      const eased = 1 - (1 - t) * (1 - t);
      setDisplay(start + (value - start) * eased);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [value, duration]);

  return display;
}

// --- Constants ---

const BASE_SECTIONS: Section[] = [
  {
    id: "system",
    label: "시스템 아이덴티티",
    sublabel: "CLI ID, 코드 스타일 규칙",
    tokens: 200,
    region: "stable",
  },
  {
    id: "tools",
    label: "도구 정의",
    sublabel: "안정성을 위해 알파벳순으로 정렬됨",
    tokens: 5000,
    region: "stable",
  },
  {
    id: "claudemd",
    label: "CLAUDE.md 콘텐츠",
    sublabel: "캐시된 프로젝트 지침",
    tokens: 1000,
    region: "stable",
  },
  {
    id: "memory",
    label: "메모리 파일 및 날짜",
    sublabel: "세션별 기억된 세션 날짜",
    tokens: 800,
    region: "semi-stable",
  },
  {
    id: "history",
    label: "대화 기록",
    sublabel: "매 턴마다 성장",
    tokens: 0, // dynamic
    region: "semi-stable",
  },
  {
    id: "context",
    label: "현재 차례 상황",
    sublabel: "최근 사용자 메시지",
    tokens: 500,
    region: "volatile",
  },
  {
    id: "results",
    label: "도구 결과",
    sublabel: "읽기/Grep/Bash 출력",
    tokens: 2000,
    region: "volatile",
  },
];

const TOKENS_PER_TURN = 1200;
const EXTRA_TOOLS_TOKENS = 3000;

const INPUT_PRICE_PER_M = 15; // $/1M input tokens
const CACHE_PRICE_PER_M = 1.5; // $/1M cached tokens (90% discount)

// --- Component ---

interface Props {
  className?: string;
}

export default function PromptCacheArchitecture({ className }: Props) {
  const isDark = useDarkMode();

  const [conversationLength, setConversationLength] = useState(10);
  const [extendedThinking, setExtendedThinking] = useState(false);
  const [thinkingLatched, setThinkingLatched] = useState(false);
  const [extraTools, setExtraTools] = useState(false);
  const [betaHeaders, setBetaHeaders] = useState(false);
  const [cacheBreaking, setCacheBreaking] = useState(false);

  const handleThinkingToggle = useCallback(() => {
    if (!thinkingLatched) {
      setExtendedThinking(true);
      setThinkingLatched(true);
    }
    // Once latched, cannot be turned off
  }, [thinkingLatched]);

  const triggerCacheBreak = useCallback(() => {
    setExtraTools((prev) => !prev);
    setCacheBreaking(true);
    setTimeout(() => setCacheBreaking(false), 1200);
  }, []);

  const colors = useMemo(
    () => ({
      terracotta: "#d97757",
      muted: "#87867f",
      green: "#22c55e",
      amber: "#f59e0b",
      red: "#ef4444",
      text: isDark ? "#f5f4ed" : "#141413",
      textSecondary: isDark ? "#87867f" : "#87867f",
      bg: isDark ? "#1e1e1c" : "#ffffff",
      bgCard: isDark ? "#2a2a28" : "#f8f7f2",
      border: isDark ? "#333" : "#c2c0b6",
      sliderTrack: isDark ? "#333" : "#e0dfd8",
      stableBg: isDark ? "rgba(34,197,94,0.12)" : "rgba(34,197,94,0.08)",
      stableBorder: isDark
        ? "rgba(34,197,94,0.25)"
        : "rgba(34,197,94,0.18)",
      semiStableBg: isDark
        ? "rgba(34,197,94,0.06)"
        : "rgba(34,197,94,0.04)",
      semiStableBorder: isDark
        ? "rgba(245,158,11,0.25)"
        : "rgba(245,158,11,0.18)",
      volatileBg: isDark
        ? "rgba(245,158,11,0.1)"
        : "rgba(245,158,11,0.06)",
      volatileBorder: isDark
        ? "rgba(245,158,11,0.3)"
        : "rgba(245,158,11,0.2)",
    }),
    [isDark],
  );

  // Compute sections with dynamic values
  const sections = useMemo(() => {
    const result = BASE_SECTIONS.map((s) => ({ ...s }));

    // Conversation history grows with turns
    const historyIdx = result.findIndex((s) => s.id === "history");
    if (historyIdx >= 0) {
      result[historyIdx].tokens = conversationLength * TOKENS_PER_TURN;
    }

    // Extra tools adds to tool definitions
    if (extraTools) {
      const toolsIdx = result.findIndex((s) => s.id === "tools");
      if (toolsIdx >= 0) {
        result[toolsIdx].tokens += EXTRA_TOOLS_TOKENS;
        result[toolsIdx].sublabel = "Sorted + MCP tools (cache scope: per-user)";
      }
    }

    // Extended thinking adds a beta header cost
    if (extendedThinking) {
      const systemIdx = result.findIndex((s) => s.id === "system");
      if (systemIdx >= 0) {
        result[systemIdx].tokens += 100;
        result[systemIdx].sublabel = "CLI identity + thinking budget header";
      }
    }

    // Beta headers add overhead
    if (betaHeaders) {
      const systemIdx = result.findIndex((s) => s.id === "system");
      if (systemIdx >= 0) {
        result[systemIdx].tokens += 50;
      }
    }

    return result;
  }, [conversationLength, extraTools, extendedThinking, betaHeaders]);

  const totalTokens = useMemo(
    () => sections.reduce((sum, s) => sum + s.tokens, 0),
    [sections],
  );

  const cachedTokens = useMemo(
    () =>
      sections
        .filter((s) => s.region === "stable" || s.region === "semi-stable")
        .reduce((sum, s) => sum + s.tokens, 0),
    [sections],
  );

  const volatileTokens = useMemo(
    () =>
      sections
        .filter((s) => s.region === "volatile")
        .reduce((sum, s) => sum + s.tokens, 0),
    [sections],
  );

  const cacheHitPercent = totalTokens > 0 ? (cachedTokens / totalTokens) * 100 : 0;

  // Cost calculations
  const costWithCache = useMemo(() => {
    const cached = cachedTokens * (CACHE_PRICE_PER_M / 1_000_000);
    const uncached = volatileTokens * (INPUT_PRICE_PER_M / 1_000_000);
    return cached + uncached;
  }, [cachedTokens, volatileTokens]);

  const costWithoutCache = useMemo(() => {
    return totalTokens * (INPUT_PRICE_PER_M / 1_000_000);
  }, [totalTokens]);

  const animCachePercent = useAnimatedNumber(cacheHitPercent);
  const animCostWith = useAnimatedNumber(costWithCache);
  const animCostWithout = useAnimatedNumber(costWithoutCache);
  const animTotalTokens = useAnimatedNumber(totalTokens);

  // Find the boundary index (between semi-stable and volatile)
  const boundaryIndex = useMemo(() => {
    for (let i = sections.length - 1; i >= 0; i--) {
      if (
        sections[i].region === "semi-stable" ||
        sections[i].region === "stable"
      ) {
        return i;
      }
    }
    return sections.length - 1;
  }, [sections]);

  // Ephemeral cache marker position (between stable and semi-stable)
  const ephemeralIndex = useMemo(() => {
    for (let i = 0; i < sections.length; i++) {
      if (sections[i].region === "semi-stable") {
        return i;
      }
    }
    return -1;
  }, [sections]);

  const formatTokens = (n: number) => {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
    return `${n}`;
  };

  const formatCost = (n: number) => {
    if (n < 0.001 && n > 0) return "<$0.001";
    return `$${n.toFixed(3)}`;
  };

  const getRegionColor = (region: string) => {
    switch (region) {
      case "stable":
        return {
          bg: colors.stableBg,
          border: colors.stableBorder,
          dot: colors.green,
        };
      case "semi-stable":
        return {
          bg: colors.semiStableBg,
          border: colors.semiStableBorder,
          dot: colors.green,
        };
      case "volatile":
        return {
          bg: colors.volatileBg,
          border: colors.volatileBorder,
          dot: colors.amber,
        };
      default:
        return { bg: "transparent", border: colors.border, dot: colors.muted };
    }
  };

  const labelStyle: React.CSSProperties = {
    fontSize: 13,
    color: colors.text,
    fontFamily: "var(--font-serif)",
    marginBottom: 4,
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
  };

  const valueStyle: React.CSSProperties = {
    fontSize: 12,
    color: colors.terracotta,
    fontFamily: "var(--font-mono)",
    fontWeight: 600,
  };

  return (
    <div className={className} style={{ fontFamily: "var(--font-serif)" }}>
      {/* Main layout */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 300px",
          gap: 20,
          background: colors.bg,
          border: `1px solid ${colors.border}`,
          borderRadius: 8,
          padding: 20,
        }}
      >
        {/* Left: Prompt stack visualization */}
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: 11,
              color: colors.textSecondary,
              fontFamily: "var(--font-mono)",
              marginBottom: 10,
              textTransform: "uppercase",
              letterSpacing: 1,
            }}
          >
            프롬프트 구조
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {sections.map((section, idx) => {
              const regionColors = getRegionColor(section.region);
              const heightTokens = Math.max(section.tokens, 200);
              const minHeight = 44;
              const maxHeight = 120;
              const height = Math.min(
                maxHeight,
                Math.max(minHeight, Math.log2(heightTokens + 1) * 6),
              );

              const isCacheBreakTarget =
                cacheBreaking && section.id === "tools";

              return (
                <div key={section.id}>
                  {/* Ephemeral cache marker */}
                  {idx === ephemeralIndex && (
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "4px 0",
                      }}
                    >
                      <div
                        style={{
                          flex: 1,
                          height: 2,
                          background: `repeating-linear-gradient(90deg, ${colors.green} 0, ${colors.green} 6px, transparent 6px, transparent 12px)`,
                        }}
                      />
                      <span
                        style={{
                          fontSize: 10,
                          fontFamily: "var(--font-mono)",
                          color: colors.green,
                          whiteSpace: "nowrap",
                          opacity: 0.8,
                        }}
                      >
                        임시 캐시(1시간 TTL)
                      </span>
                      <div
                        style={{
                          flex: 1,
                          height: 2,
                          background: `repeating-linear-gradient(90deg, ${colors.green} 0, ${colors.green} 6px, transparent 6px, transparent 12px)`,
                        }}
                      />
                    </div>
                  )}

                  <motion.div
                    layout
                    animate={{
                      backgroundColor: isCacheBreakTarget
                        ? "rgba(239,68,68,0.2)"
                        : regionColors.bg,
                      borderColor: isCacheBreakTarget
                        ? colors.red
                        : regionColors.border,
                    }}
                    transition={{ duration: 0.3 }}
                    style={{
                      border: `1px solid ${regionColors.border}`,
                      borderRadius: 6,
                      padding: "8px 12px",
                      minHeight: height,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 8,
                      position: "relative",
                      overflow: "hidden",
                    }}
                  >
                    {/* Cache break flash overlay */}
                    <AnimatePresence>
                      {isCacheBreakTarget && (
                        <motion.div
                          initial={{ opacity: 0.6 }}
                          animate={{ opacity: 0 }}
                          exit={{ opacity: 0 }}
                          transition={{ duration: 1 }}
                          style={{
                            position: "absolute",
                            inset: 0,
                            background: "rgba(239,68,68,0.15)",
                            pointerEvents: "none",
                          }}
                        />
                      )}
                    </AnimatePresence>

                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        minWidth: 0,
                      }}
                    >
                      <div
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: "50%",
                          background: regionColors.dot,
                          flexShrink: 0,
                        }}
                      />
                      <div style={{ minWidth: 0 }}>
                        <div
                          style={{
                            fontSize: 13,
                            fontWeight: 600,
                            color: colors.text,
                            lineHeight: 1.3,
                          }}
                        >
                          {section.label}
                        </div>
                        <div
                          style={{
                            fontSize: 11,
                            color: colors.textSecondary,
                            lineHeight: 1.3,
                            marginTop: 1,
                          }}
                        >
                          {section.sublabel}
                        </div>
                      </div>
                    </div>

                    <motion.span
                      key={section.tokens}
                      initial={{ opacity: 0.5, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      style={{
                        fontSize: 12,
                        fontFamily: "var(--font-mono)",
                        fontWeight: 600,
                        color:
                          section.region === "volatile"
                            ? colors.amber
                            : colors.green,
                        flexShrink: 0,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {section.tokens > 0
                        ? `~${formatTokens(section.tokens)}`
                        : "0"}
                    </motion.span>
                  </motion.div>

                  {/* Dynamic boundary marker */}
                  {idx === boundaryIndex && (
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "6px 0",
                      }}
                    >
                      <div
                        style={{
                          flex: 1,
                          height: 3,
                          background: colors.terracotta,
                          borderRadius: 2,
                        }}
                      />
                      <span
                        style={{
                          fontSize: 10,
                          fontFamily: "var(--font-mono)",
                          fontWeight: 700,
                          color: colors.terracotta,
                          whiteSpace: "nowrap",
                          textTransform: "uppercase",
                          letterSpacing: 0.5,
                        }}
                      >
                        __동적_경계__
                      </span>
                      <div
                        style={{
                          flex: 1,
                          height: 3,
                          background: colors.terracotta,
                          borderRadius: 2,
                        }}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Legend */}
          <div
            style={{
              display: "flex",
              gap: 16,
              marginTop: 12,
              fontSize: 11,
              color: colors.textSecondary,
              fontFamily: "var(--font-mono)",
            }}
          >
            <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: colors.green,
                  display: "inline-block",
                }}
              />
              캐시됨
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: colors.amber,
                  display: "inline-block",
                }}
              />
              휘발성
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span
                style={{
                  width: 16,
                  height: 3,
                  background: colors.terracotta,
                  borderRadius: 2,
                  display: "inline-block",
                }}
              />
              캐시 경계
            </span>
          </div>
        </div>

        {/* Right: Controls + metrics */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Conversation length slider */}
          <div>
            <div
              style={{
                fontSize: 11,
                color: colors.textSecondary,
                fontFamily: "var(--font-mono)",
                marginBottom: 10,
                textTransform: "uppercase",
                letterSpacing: 1,
              }}
            >
              컨트롤
            </div>

            <div style={{ marginBottom: 14 }}>
              <div style={labelStyle}>
                <span>대화 길이</span>
                <span style={valueStyle}>{conversationLength} 회전</span>
              </div>
              <input
                type="range"
                min={0}
                max={50}
                step={1}
                value={conversationLength}
                onChange={(e) =>
                  setConversationLength(Number(e.target.value))
                }
                style={{
                  width: "100%",
                  accentColor: colors.terracotta,
                  cursor: "pointer",
                }}
              />
            </div>

            {/* Feature toggles */}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              {/* Extended thinking toggle */}
              <button
                onClick={handleThinkingToggle}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  background: "transparent",
                  border: `1px solid ${thinkingLatched ? `${colors.green}44` : colors.border}`,
                  borderRadius: 6,
                  padding: "6px 10px",
                  cursor: thinkingLatched ? "not-allowed" : "pointer",
                  opacity: thinkingLatched ? 0.7 : 1,
                  width: "100%",
                  textAlign: "left",
                }}
              >
                <span
                  style={{
                    width: 28,
                    height: 16,
                    borderRadius: 8,
                    background: extendedThinking
                      ? thinkingLatched
                        ? colors.muted
                        : colors.green
                      : colors.sliderTrack,
                    position: "relative",
                    flexShrink: 0,
                    transition: "background 0.2s",
                  }}
                >
                  <span
                    style={{
                      position: "absolute",
                      top: 2,
                      left: extendedThinking ? 14 : 2,
                      width: 12,
                      height: 12,
                      borderRadius: "50%",
                      background: isDark ? "#f5f4ed" : "#fff",
                      transition: "left 0.2s",
                      boxShadow: "0 1px 2px rgba(0,0,0,0.2)",
                    }}
                  />
                </span>
                <span
                  style={{
                    fontSize: 12,
                    color: colors.text,
                    fontFamily: "var(--font-serif)",
                    lineHeight: 1.2,
                  }}
                >
                  확장된 사고
                  {thinkingLatched && (
                    <span
                      style={{
                        fontSize: 10,
                        color: colors.muted,
                        display: "block",
                        fontFamily: "var(--font-mono)",
                      }}
                    >
                      끈끈한 걸쇠: 영원히 유지됩니다.
                    </span>
                  )}
                </span>
              </button>

              {/* Extra tools toggle (triggers cache break) */}
              <button
                onClick={triggerCacheBreak}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  background: "transparent",
                  border: `1px solid ${extraTools ? `${colors.amber}44` : colors.border}`,
                  borderRadius: 6,
                  padding: "6px 10px",
                  cursor: "pointer",
                  width: "100%",
                  textAlign: "left",
                }}
              >
                <span
                  style={{
                    width: 28,
                    height: 16,
                    borderRadius: 8,
                    background: extraTools ? colors.amber : colors.sliderTrack,
                    position: "relative",
                    flexShrink: 0,
                    transition: "background 0.2s",
                  }}
                >
                  <span
                    style={{
                      position: "absolute",
                      top: 2,
                      left: extraTools ? 14 : 2,
                      width: 12,
                      height: 12,
                      borderRadius: "50%",
                      background: isDark ? "#f5f4ed" : "#fff",
                      transition: "left 0.2s",
                      boxShadow: "0 1px 2px rgba(0,0,0,0.2)",
                    }}
                  />
                </span>
                <span
                  style={{
                    fontSize: 12,
                    color: colors.text,
                    fontFamily: "var(--font-serif)",
                    lineHeight: 1.2,
                  }}
                >
                  세션 중간에 MCP 도구
                  <span
                    style={{
                      fontSize: 10,
                      color: colors.muted,
                      display: "block",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    {extraTools ? "캐시 브레이크! 접두사에 +3K 토큰" : "캐시 무효화를 보려면 전환하세요."}
                  </span>
                </span>
              </button>

              {/* Beta headers toggle */}
              <button
                onClick={() => setBetaHeaders((prev) => !prev)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  background: "transparent",
                  border: `1px solid ${betaHeaders ? `${colors.green}44` : colors.border}`,
                  borderRadius: 6,
                  padding: "6px 10px",
                  cursor: "pointer",
                  width: "100%",
                  textAlign: "left",
                }}
              >
                <span
                  style={{
                    width: 28,
                    height: 16,
                    borderRadius: 8,
                    background: betaHeaders ? colors.green : colors.sliderTrack,
                    position: "relative",
                    flexShrink: 0,
                    transition: "background 0.2s",
                  }}
                >
                  <span
                    style={{
                      position: "absolute",
                      top: 2,
                      left: betaHeaders ? 14 : 2,
                      width: 12,
                      height: 12,
                      borderRadius: "50%",
                      background: isDark ? "#f5f4ed" : "#fff",
                      transition: "left 0.2s",
                      boxShadow: "0 1px 2px rgba(0,0,0,0.2)",
                    }}
                  />
                </span>
                <span
                  style={{
                    fontSize: 12,
                    color: colors.text,
                    fontFamily: "var(--font-serif)",
                  }}
                >
                  베타 헤더
                </span>
              </button>
            </div>
          </div>

          {/* Cache hit meter */}
          <div>
            <div
              style={{
                fontSize: 11,
                color: colors.textSecondary,
                fontFamily: "var(--font-mono)",
                marginBottom: 8,
                textTransform: "uppercase",
                letterSpacing: 1,
              }}
            >
              캐시 적중률
            </div>
            <div
              style={{
                height: 28,
                background: colors.sliderTrack,
                borderRadius: 6,
                overflow: "hidden",
                position: "relative",
              }}
            >
              <motion.div
                animate={{ width: `${cacheHitPercent}%` }}
                transition={{ duration: 0.4, ease: "easeOut" }}
                style={{
                  height: "100%",
                  background: `linear-gradient(90deg, ${colors.green}, ${colors.green}cc)`,
                  borderRadius: 6,
                }}
              />
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 12,
                  fontFamily: "var(--font-mono)",
                  fontWeight: 700,
                  color: cacheHitPercent > 50 ? "#fff" : colors.text,
                  mixBlendMode: cacheHitPercent > 50 ? "normal" : "normal",
                }}
              >
                {animCachePercent.toFixed(0)}% 캐시됨
              </div>
            </div>
          </div>

          {/* Cost comparison */}
          <div
            style={{
              background: colors.bgCard,
              borderRadius: 6,
              padding: "12px 14px",
            }}
          >
            <div
              style={{
                fontSize: 11,
                color: colors.textSecondary,
                fontFamily: "var(--font-mono)",
                marginBottom: 8,
                textTransform: "uppercase",
                letterSpacing: 1,
              }}
            >
              이번 턴의 비용
            </div>

            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "baseline",
                marginBottom: 6,
              }}
            >
              <span
                style={{
                  fontSize: 12,
                  color: colors.textSecondary,
                }}
              >
                캐시 포함
              </span>
              <span
                style={{
                  fontSize: 18,
                  fontWeight: 700,
                  fontFamily: "var(--font-mono)",
                  color: colors.green,
                }}
              >
                {formatCost(animCostWith)}
              </span>
            </div>

            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "baseline",
                marginBottom: 8,
                paddingBottom: 8,
                borderBottom: `1px solid ${colors.border}`,
              }}
            >
              <span
                style={{
                  fontSize: 12,
                  color: colors.textSecondary,
                }}
              >
                캐시 없음
              </span>
              <span
                style={{
                  fontSize: 14,
                  fontFamily: "var(--font-mono)",
                  color: colors.muted,
                  textDecoration: "line-through",
                }}
              >
                {formatCost(animCostWithout)}
              </span>
            </div>

            <div
              style={{
                fontSize: 11,
                fontFamily: "var(--font-mono)",
                color: colors.textSecondary,
                lineHeight: 1.6,
              }}
            >
              <div>
                총계: ~{formatTokens(Math.round(animTotalTokens))} 토큰
              </div>
              <div style={{ color: colors.green }}>
                절감액:{" "}
                {((1 - costWithCache / Math.max(costWithoutCache, 0.0001)) * 100).toFixed(0)}%
                ({formatCost(costWithoutCache - costWithCache)} 저장됨)
              </div>
            </div>
          </div>

          {/* Sticky latch explanation */}
          <AnimatePresence>
            {thinkingLatched && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                style={{
                  background: isDark
                    ? "rgba(217,119,87,0.1)"
                    : "rgba(217,119,87,0.06)",
                  border: `1px solid ${isDark ? "rgba(217,119,87,0.25)" : "rgba(217,119,87,0.18)"}`,
                  borderRadius: 6,
                  padding: "10px 12px",
                  fontSize: 11,
                  fontFamily: "var(--font-mono)",
                  color: colors.terracotta,
                  lineHeight: 1.5,
                }}
              >
                <strong>끈끈한 걸쇠:</strong> 일단 확장된 사고는
                활성화된 <code>생각깨끗한걸림</code> 필드 스테이
                사실. 이 기능을 끄면 캐시된 토큰이 최대 60,000개까지 파괴됩니다.
                프롬프트. 래치는 보존을 위해 세션 중간 토글을 희생합니다.
                캐시.
              </motion.div>
            )}
          </AnimatePresence>

          {/* Cache break alert */}
          <AnimatePresence>
            {cacheBreaking && (
              <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                transition={{ duration: 0.2 }}
                style={{
                  background: isDark
                    ? "rgba(239,68,68,0.12)"
                    : "rgba(239,68,68,0.06)",
                  border: `1px solid ${colors.red}44`,
                  borderRadius: 6,
                  padding: "10px 12px",
                  fontSize: 11,
                  fontFamily: "var(--font-mono)",
                  color: colors.red,
                  lineHeight: 1.5,
                }}
              >
                <strong>캐시 무효화!</strong> 세션 중간에 도구 추가
                안정적인 접두사에서 정렬된 도구 목록을 변경합니다. 모든 것
                변경 지점 이후에는 캐시 미스가 발생합니다. ~
                {formatTokens(cachedTokens)} 토큰을 다시 처리해야 합니다.
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
