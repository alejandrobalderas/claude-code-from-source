import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";

// --- Types ---

type PlayMode = "idle" | "playing" | "paused" | "done";

interface Participant {
  id: string;
  label: string;
  shortLabel: string;
}

interface SequenceMessage {
  id: number;
  from: string;
  to: string;
  label: string;
  detail: string;
  isLoopBack?: boolean;
  terminalText?: string;
  durationMs: number;
}

// --- Data ---

const participants: Participant[] = [
  { id: "user", label: "사용자 / REPL", shortLabel: "User" },
  { id: "query", label: "쿼리 루프", shortLabel: "Query" },
  { id: "model", label: "모델 API", shortLabel: "Model" },
  { id: "executor", label: "스트리밍 도구 실행기", shortLabel: "Executor" },
  { id: "tools", label: "도구 시스템", shortLabel: "Tools" },
];

const sequence: SequenceMessage[] = [
  {
    id: 1,
    from: "user",
    to: "query",
    label: "사용자 메시지",
    detail: "REPL은 입력을 캡처하고, UserMessage로 래핑하고, 쿼리 루프 생성기에 공급합니다.",
    terminalText: '> add error handling to the login function\n\n  Thinking...',
    durationMs: 200,
  },
  {
    id: 2,
    from: "query",
    to: "query",
    label: "토큰 개수 확인",
    detail: "컨텍스트 창 사용법을 확인하세요. 대화가 예산을 초과하는 경우 자동 압축",
    terminalText: '> add error handling to the login function\n\n  Thinking... (context: 12,847 tokens)',
    durationMs: 150,
  },
  {
    id: 3,
    from: "query",
    to: "model",
    label: "callModel() 스트림 요청",
    detail: "시스템 프롬프트 + 메모리 + Claude API로 전송된 대화 내역",
    terminalText: '> add error handling to the login function\n\n  Streaming response...',
    durationMs: 300,
  },
  {
    id: 4,
    from: "model",
    to: "query",
    label: "토큰이 다시 스트리밍됩니다.",
    detail: "응답은 스트리밍 청크로 도착합니다. 텍스트 블록과 tool_use 블록이 인터리브됩니다.",
    terminalText: '> add error handling to the login function\n\n  I\'ll read the login function first...',
    durationMs: 400,
  },
  {
    id: 5,
    from: "model",
    to: "executor",
    label: "tool_use 블록을 감지합니다.",
    detail: "StreamingToolExecutor는 응답이 완료되기 전에 tool_use 블록 중간 스트림을 가로챕니다.",
    terminalText: '> add error handling to the login function\n\n  I\'ll read the login function first...\n  [tool_use: Read /src/auth/login.ts]',
    durationMs: 250,
  },
  {
    id: 6,
    from: "executor",
    to: "tools",
    label: "동시성이 안전한 도구를 일찍 시작하세요",
    detail: "모델이 계속 스트리밍되는 동안 읽기 전용 도구(Read, Grep)가 예측적으로 시작됩니다.",
    terminalText: '> add error handling to the login function\n\n  Read /src/auth/login.ts (speculative)',
    durationMs: 300,
  },
  {
    id: 7,
    from: "tools",
    to: "executor",
    label: "결과(모델 이전에 완료될 수 있음)",
    detail: "도구 결과가 대기열에 추가되었습니다. 모델이 호출을 무효화하면 결과가 삭제됩니다.",
    terminalText: '> add error handling to the login function\n\n  Read /src/auth/login.ts -> 156 lines',
    durationMs: 200,
  },
  {
    id: 8,
    from: "query",
    to: "tools",
    label: "나머지 도구 실행",
    detail: "직렬/동시 배치: 유효성 검사 -> 훅 -> 권한 -> 실행",
    terminalText: '> add error handling to the login function\n\n  Edit /src/auth/login.ts (42 lines changed)',
    durationMs: 350,
  },
  {
    id: 9,
    from: "tools",
    to: "query",
    label: "도구결과메시지",
    detail: "ContentBlock[]에 매핑된 결과, 도구별 크기 제한에 대한 예산 책정, 기록에 추가됨",
    terminalText: '> add error handling to the login function\n\n  Edit applied. Checking if more changes needed...',
    durationMs: 200,
  },
  {
    id: 10,
    from: "query",
    to: "query",
    label: "확인 중지: 루프?",
    detail: "추가 도구 요청이 보류 중입니까? 루프를 계속하세요. 더 이상 전화가 없나요? 최종 응답 생성",
    isLoopBack: true,
    terminalText: '> add error handling to the login function\n\n  More tool calls detected -> loop continues',
    durationMs: 200,
  },
  {
    id: 11,
    from: "query",
    to: "model",
    label: "루프: 업데이트된 컨텍스트",
    detail: "메시지 기록에 도구 결과가 추가되었습니다. 전체 컨텍스트로 모델이 다시 호출됨",
    isLoopBack: true,
    terminalText: '> add error handling to the login function\n\n  Re-entering query loop with tool results...',
    durationMs: 300,
  },
  {
    id: 12,
    from: "model",
    to: "query",
    label: "최종 문자 응답",
    detail: "더 이상 tool_use 블록이 없습니다. 모델이 사용자에게 최종 텍스트 응답을 생성합니다.",
    terminalText: '> add error handling to the login function\n\n  Done. Added try-catch blocks with specific\n  error types for auth failures, rate limits,\n  and network errors.',
    durationMs: 400,
  },
  {
    id: 13,
    from: "query",
    to: "user",
    label: "수율 메시지 -> 렌더링",
    detail: "생성기는 최종 메시지를 생성합니다. REPL은 잉크를 통해 마크다운을 터미널로 렌더링합니다.",
    terminalText: '> add error handling to the login function\n\n  Done. Added try-catch blocks with specific\n  error types for auth failures, rate limits,\n  and network errors.\n\n  Files changed: /src/auth/login.ts',
    durationMs: 250,
  },
];

const TOTAL_DURATION = "~3.2 seconds";

// --- Helpers ---

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

function ArrowIcon({ direction, color }: { direction: "right" | "left"; color: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      {direction === "right" ? (
        <path d="M2 7h10M9 4l3 3-3 3" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <path d="M12 7H2M5 4L2 7l3 3" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  );
}

function LoopIcon({ color }: { color: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M11 7a4 4 0 0 1-7.46 2M3 7a4 4 0 0 1 7.46-2" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
      <path d="M3 11V9h2M11 3v2h-2" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// --- Component ---

interface Props {
  className?: string;
}

export default function GoldenPath({ className }: Props) {
  const isDark = useDarkMode();
  const [mode, setMode] = useState<PlayMode>("idle");
  const [currentStep, setCurrentStep] = useState(-1);
  const abortRef = useRef(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const colors = {
    accent: "#d97757",
    accentDim: "rgba(217, 119, 87, 0.3)",
    accentBg: isDark ? "rgba(217, 119, 87, 0.08)" : "rgba(217, 119, 87, 0.05)",
    text: isDark ? "#f5f4ed" : "#141413",
    textSecondary: "#87867f",
    cardBg: isDark ? "#1e1e1c" : "#ffffff",
    cardBorder: isDark ? "#333" : "#e8e6dc",
    terminalBg: isDark ? "#0a0a09" : "#141413",
    terminalText: "#22c55e",
    terminalDim: "#87867f",
    loopBg: isDark ? "rgba(217, 119, 87, 0.12)" : "rgba(217, 119, 87, 0.08)",
  };

  const reset = useCallback(() => {
    abortRef.current = true;
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setMode("idle");
    setCurrentStep(-1);
  }, []);

  const advanceStep = useCallback((step: number) => {
    if (step >= sequence.length) {
      setMode("done");
      return;
    }
    setCurrentStep(step);
  }, []);

  const playAll = useCallback(async () => {
    reset();
    await new Promise((r) => setTimeout(r, 50));
    abortRef.current = false;
    setMode("playing");

    for (let i = 0; i < sequence.length; i++) {
      if (abortRef.current) return;
      setCurrentStep(i);
      await new Promise<void>((resolve) => {
        timeoutRef.current = setTimeout(resolve, sequence[i].durationMs + 400);
      });
    }
    if (!abortRef.current) {
      setMode("done");
    }
  }, [reset]);

  const stepForward = useCallback(() => {
    if (mode === "idle") {
      setMode("paused");
      setCurrentStep(0);
    } else if (mode === "paused" || mode === "done") {
      const next = currentStep + 1;
      if (next >= sequence.length) {
        setMode("done");
      } else {
        setMode("paused");
        setCurrentStep(next);
      }
    }
  }, [mode, currentStep]);

  useEffect(() => {
    return () => {
      abortRef.current = true;
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const getParticipantIndex = (id: string) => participants.findIndex((p) => p.id === id);

  const currentMessage = currentStep >= 0 && currentStep < sequence.length ? sequence[currentStep] : null;

  return (
    <div className={className} style={{ fontFamily: "var(--font-serif)" }}>
      {/* Controls */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 12,
          marginBottom: 24,
          padding: "16px 20px",
          background: colors.cardBg,
          border: `1px solid ${colors.cardBorder}`,
          borderRadius: 12,
        }}
      >
        <button
          onClick={mode === "playing" ? reset : playAll}
          style={{
            padding: "8px 20px",
            borderRadius: 8,
            border: "none",
            background: mode === "playing" ? colors.textSecondary : colors.accent,
            color: "#fff",
            fontSize: 13,
            fontWeight: 600,
            fontFamily: "var(--font-mono)",
            cursor: "pointer",
            transition: "background 0.2s",
          }}
        >
          {mode === "playing" ? "중지" : mode === "done" ? "재생" : "플레이"}
        </button>

        <button
          onClick={stepForward}
          disabled={mode === "playing"}
          style={{
            padding: "8px 20px",
            borderRadius: 8,
            border: `1px solid ${colors.cardBorder}`,
            background: colors.cardBg,
            color: mode === "playing" ? colors.textSecondary : colors.text,
            fontSize: 13,
            fontWeight: 600,
            fontFamily: "var(--font-mono)",
            cursor: mode === "playing" ? "not-allowed" : "pointer",
            transition: "background 0.2s",
            opacity: mode === "playing" ? 0.5 : 1,
          }}
        >
          단계
        </button>

        <button
          onClick={reset}
          disabled={mode === "idle"}
          style={{
            padding: "8px 16px",
            borderRadius: 8,
            border: `1px solid ${colors.cardBorder}`,
            background: colors.cardBg,
            color: mode === "idle" ? colors.textSecondary : colors.text,
            fontSize: 13,
            fontFamily: "var(--font-mono)",
            cursor: mode === "idle" ? "not-allowed" : "pointer",
            opacity: mode === "idle" ? 0.5 : 1,
          }}
        >
          재설정
        </button>

        <div style={{ flex: 1, minWidth: 20 }} />

        <span
          style={{
            fontSize: 12,
            fontFamily: "var(--font-mono)",
            color: colors.textSecondary,
          }}
        >
          {currentStep >= 0 ? `Step ${currentStep + 1}/${sequence.length}` : "준비"}{" "}
          &amp;middot; 합계: {TOTAL_DURATION}
        </span>
      </div>

      {/* Participant columns header */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${participants.length}, 1fr)`,
          gap: 8,
          marginBottom: 16,
        }}
      >
        {participants.map((p) => {
          const isActive =
            currentMessage &&
            (currentMessage.from === p.id || currentMessage.to === p.id);
          return (
            <motion.div
              key={p.id}
              animate={{
                borderColor: isActive ? colors.accent : colors.cardBorder,
                background: isActive ? colors.accentBg : colors.cardBg,
              }}
              transition={{ duration: 0.3 }}
              style={{
                padding: "10px 8px",
                borderRadius: 10,
                border: `1.5px solid ${colors.cardBorder}`,
                textAlign: "center",
              }}
            >
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  fontFamily: "var(--font-mono)",
                  color: isActive ? colors.accent : colors.text,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                <span className="golden-path-full-label">{p.label}</span>
                <span className="golden-path-short-label">{p.shortLabel}</span>
              </div>
            </motion.div>
          );
        })}
      </div>

      <style>{".golden-path-short-label { 표시: 없음; }\n        @media (최대 너비: 640px) {\n          .golden-path-full-label { 표시: 없음; }\n          .golden-path-short-label { 디스플레이: 인라인; }\n        }"}</style>

      {/* Sequence messages */}
      <div style={{ position: "relative" }}>
        {sequence.map((msg, i) => {
          const fromIdx = getParticipantIndex(msg.from);
          const toIdx = getParticipantIndex(msg.to);
          const isSelf = fromIdx === toIdx;
          const leftCol = Math.min(fromIdx, toIdx);
          const rightCol = Math.max(fromIdx, toIdx);
          const colSpan = rightCol - leftCol + 1;
          const goesRight = toIdx > fromIdx;

          const isVisible = i <= currentStep;
          const isCurrent = i === currentStep;

          return (
            <AnimatePresence key={msg.id}>
              {isVisible && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3 }}
                  style={{
                    display: "grid",
                    gridTemplateColumns: `repeat(${participants.length}, 1fr)`,
                    gap: 8,
                    marginBottom: 6,
                  }}
                >
                  <motion.div
                    animate={{
                      background: isCurrent
                        ? msg.isLoopBack
                          ? colors.loopBg
                          : colors.accentBg
                        : "transparent",
                      borderColor: isCurrent ? colors.accent : "transparent",
                    }}
                    transition={{ duration: 0.3 }}
                    style={{
                      gridColumn: `${leftCol + 1} / ${leftCol + colSpan + 1}`,
                      padding: "8px 12px",
                      borderRadius: 8,
                      border: "1px solid transparent",
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      minHeight: 36,
                    }}
                  >
                    {msg.isLoopBack ? (
                      <LoopIcon color={isCurrent ? colors.accent : colors.textSecondary} />
                    ) : isSelf ? (
                      <LoopIcon color={isCurrent ? colors.accent : colors.textSecondary} />
                    ) : goesRight ? (
                      <ArrowIcon direction="right" color={isCurrent ? colors.accent : colors.textSecondary} />
                    ) : (
                      <ArrowIcon direction="left" color={isCurrent ? colors.accent : colors.textSecondary} />
                    )}

                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 13,
                          fontWeight: 600,
                          fontFamily: "var(--font-mono)",
                          color: isCurrent ? colors.accent : colors.text,
                          opacity: isCurrent ? 1 : 0.6,
                        }}
                      >
                        {msg.label}
                      </div>
                      {isCurrent && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: "auto", opacity: 1 }}
                          transition={{ duration: 0.2 }}
                          style={{
                            fontSize: 12,
                            color: colors.textSecondary,
                            marginTop: 2,
                            lineHeight: 1.4,
                          }}
                        >
                          {msg.detail}
                        </motion.div>
                      )}
                    </div>

                    <span
                      style={{
                        fontSize: 10,
                        fontFamily: "var(--font-mono)",
                        color: colors.textSecondary,
                        whiteSpace: "nowrap",
                        opacity: isCurrent ? 1 : 0.4,
                      }}
                    >
                      {msg.durationMs}ms
                    </span>
                  </motion.div>
                </motion.div>
              )}
            </AnimatePresence>
          );
        })}
      </div>

      {/* Mini terminal preview */}
      <AnimatePresence>
        {currentMessage?.terminalText && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -5 }}
            transition={{ duration: 0.3 }}
            style={{
              marginTop: 20,
              borderRadius: 12,
              overflow: "hidden",
              border: `1px solid ${colors.cardBorder}`,
            }}
          >
            {/* Terminal title bar */}
            <div
              style={{
                background: isDark ? "#1a1a18" : "#1e1e1c",
                padding: "8px 14px",
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#ef4444" }} />
              <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#eab308" }} />
              <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#22c55e" }} />
              <span
                style={{
                  marginLeft: 8,
                  fontSize: 11,
                  fontFamily: "var(--font-mono)",
                  color: "#87867f",
                }}
              >
                터미널
              </span>
            </div>
            {/* Terminal body */}
            <div
              style={{
                background: colors.terminalBg,
                padding: "14px 16px",
                minHeight: 80,
              }}
            >
              <pre
                style={{
                  margin: 0,
                  fontSize: 12,
                  fontFamily: "var(--font-mono)",
                  color: colors.terminalText,
                  lineHeight: 1.6,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {currentMessage.terminalText}
              </pre>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Completion badge */}
      <AnimatePresence>
        {mode === "done" && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            style={{
              marginTop: 16,
              padding: "14px 20px",
              borderRadius: 12,
              border: `1px solid ${colors.accentDim}`,
              background: colors.accentBg,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: 8,
            }}
          >
            <div>
              <div
                style={{
                  fontSize: 14,
                  fontWeight: 600,
                  color: colors.accent,
                  fontFamily: "var(--font-mono)",
                }}
              >
                황금길 완성
              </div>
              <div style={{ fontSize: 12, color: colors.textSecondary, marginTop: 2 }}>
                메시지 13개, 도구 루프 반복 1개, {TOTAL_DURATION} 엔드투엔드
              </div>
            </div>
            <div
              style={{
                fontSize: 11,
                fontFamily: "var(--font-mono)",
                color: colors.textSecondary,
                padding: "4px 10px",
                borderRadius: 6,
                background: isDark ? "rgba(217, 119, 87, 0.15)" : "rgba(217, 119, 87, 0.12)",
              }}
            >
              생성기가 Terminal.Success를 생성했습니다.
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
