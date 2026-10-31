import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";

// --- Dark Mode Hook ---

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

// --- Types ---

type Participant = "loop" | "factory" | "api" | "cache";

interface SequenceStep {
  id: number;
  from: Participant;
  to: Participant;
  label: string;
  sublabel?: string;
  description: string;
  highlight?: "cache" | "watchdog" | "error" | "retry";
  tokens?: number;
}

// --- Step Data ---

const normalSteps: SequenceStep[] = [
  {
    id: 1,
    from: "loop",
    to: "factory",
    label: "createStream(메시지)",
    description:
      "쿼리 루프는 API 호출을 시작하여 전체 메시지 배열과 구성을 전달합니다.",
  },
  {
    id: 2,
    from: "factory",
    to: "factory",
    label: "공급자 파견",
    sublabel: "직접 / 기반암 / 정점",
    description:
      "클라이언트 팩토리는 환경 변수를 통해 공급자를 선택합니다. 4개의 SDK는 모두 균일한 Anthropic 인터페이스로 캐스팅되었습니다.",
  },
  {
    id: 3,
    from: "factory",
    to: "api",
    label: "헤더 + 시스템 프롬프트",
    sublabel: "베타 헤더, 고정 래치, 캐시 제어",
    description:
      "끈끈한 래치로 조립된 베타 헤더(한 번 true로 설정되면 되돌릴 수 없음) 최적의 캐싱을 위해 동적 경계에서 시스템 프롬프트 분할.",
  },
  {
    id: 4,
    from: "api",
    to: "cache",
    label: "캐시 접두사 확인",
    sublabel: "50-70K 토큰 접두사",
    description:
      "서버는 안정적인 프롬프트 접두사가 캐시된 항목과 일치하는지 확인합니다. 정적 섹션은 전역 범위를 갖습니다. 동적 섹션은 세션별 범위를 갖습니다.",
    highlight: "cache",
  },
  {
    id: 5,
    from: "cache",
    to: "api",
    label: "캐시 적중",
    sublabel: "60,000개 토큰에서 ~$0.12 절약",
    description:
      "정적 접두사에 캐시 적중이 발생했습니다. 서버는 시스템 프롬프트 및 초기 대화 기록의 50-70K 토큰 재처리를 건너뜁니다.",
    highlight: "cache",
    tokens: 0,
  },
  {
    id: 6,
    from: "api",
    to: "loop",
    label: "SSE 스트림이 시작됩니다",
    sublabel: "원시 스트림<BetaRawMessageStreamEvent>",
    description:
      "응답은 서버에서 보낸 이벤트로 다시 스트리밍됩니다. O(n²) 부분 JSON 구문 분석을 방지하기 위해 원시 SSE(SDK의 BetaMessageStream 아님)를 사용합니다.",
    tokens: 0,
  },
  {
    id: 7,
    from: "loop",
    to: "loop",
    label: "유휴 워치독: 90초",
    sublabel: "각 청크에서 재설정",
    description:
      "setTimeout은 수신된 모든 청크에서 재설정됩니다. 90초 동안 청크가 도착하지 않으면 스트림이 중단되고 비스트리밍 대체가 실행됩니다.",
    highlight: "watchdog",
    tokens: 847,
  },
  {
    id: 8,
    from: "api",
    to: "loop",
    label: "토큰 스트리밍...",
    sublabel: "content_block_delta 이벤트",
    description:
      "텍스트 및 tool_use 블록은 증분적으로 도착합니다. 스트리밍 실행자는 응답이 완료되기 전에 동시성이 안전한 도구를 시작할 수 있습니다.",
    tokens: 2431,
  },
  {
    id: 9,
    from: "api",
    to: "loop",
    label: "스트림 완료",
    sublabel: "message_stop 이벤트",
    description:
      "마지막 SSE 이벤트가 시작됩니다. 응답은 텍스트 블록과 tool_use 블록이 있는 AssistantMessage로 구문 분석됩니다.",
    tokens: 3892,
  },
  {
    id: 10,
    from: "loop",
    to: "loop",
    label: "응답이 구문 분석되었습니다.",
    sublabel: "AssistantMessage + tool_use 블록",
    description:
      "루프는 전체 응답을 처리합니다. 즉, 도구 호출을 추출하고, 상태를 업데이트하고, 오류를 확인하고, 다음 반복을 준비합니다.",
    tokens: 3892,
  },
];

const errorSteps: SequenceStep[] = [
  ...normalSteps.slice(0, 6),
  {
    id: 7,
    from: "api",
    to: "loop",
    label: "529 과부하",
    sublabel: "용량이 부족한 서버",
    description:
      "API는 529 상태를 반환합니다. withRetry() 생성기는 UI가 재시도 상태를 표시할 수 있도록 SystemAPIErrorMessage를 생성합니다.",
    highlight: "error",
    tokens: 0,
  },
  {
    id: 8,
    from: "loop",
    to: "loop",
    label: "백오프: 1초",
    sublabel: "3개 중 1개 시도",
    description:
      "지수 백오프가 시작됩니다. 재시도 진행 상황은 사이드 채널 알림이 아닌 이벤트 스트림의 자연스러운 부분으로 나타납니다.",
    highlight: "retry",
    tokens: 0,
  },
  {
    id: 9,
    from: "loop",
    to: "api",
    label: "재시도 요청",
    sublabel: "동일한 매개변수",
    description:
      "요청이 동일한 매개변수로 다시 전송됩니다. 선택적으로 529에서 빠른 모드를 다운그레이드합니다.",
    highlight: "retry",
    tokens: 0,
  },
  {
    id: 10,
    from: "api",
    to: "loop",
    label: "다시 529",
    sublabel: "여전히 과부하",
    description: "두 번째 실패. 백오프 간격이 두 배로 늘어납니다.",
    highlight: "error",
    tokens: 0,
  },
  {
    id: 11,
    from: "loop",
    to: "loop",
    label: "백오프: 2초",
    sublabel: "2/3 시도",
    description:
      "더 오래 기다리십시오. 생성기는 UI가 로딩 표시기로 렌더링하는 상태 이벤트를 생성합니다.",
    highlight: "retry",
    tokens: 0,
  },
  {
    id: 12,
    from: "loop",
    to: "api",
    label: "재시도 요청",
    sublabel: "시도 3",
    description: "이것도 실패할 경우 4초 백오프를 사용하여 최종 재시도를 시도합니다.",
    highlight: "retry",
    tokens: 0,
  },
  {
    id: 13,
    from: "api",
    to: "loop",
    label: "200 OK -- 스트리밍",
    sublabel: "복구 성공",
    description:
      "재시도 시 요청이 성공합니다. 정상적인 스트리밍이 재개됩니다. 이전 오류는 소비자로부터 보류되었습니다.",
    tokens: 3892,
  },
];

// --- Participant Layout ---

const participants: { id: Participant; label: string; short: string }[] = [
  { id: "loop", label: "쿼리 루프", short: "Loop" },
  { id: "factory", label: "클라이언트 공장", short: "Factory" },
  { id: "api", label: "공급자 API", short: "API" },
  { id: "cache", label: "캐시", short: "Cache" },
];

const participantX: Record<Participant, number> = {
  loop: 0,
  factory: 1,
  api: 2,
  cache: 3,
};

// --- Component ---

export default function APIRequestFlow({
  className = "",
}: {
  className?: string;
}) {
  const isDark = useDarkMode();
  const [currentStep, setCurrentStep] = useState(-1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [simulateError, setSimulateError] = useState(false);
  const [tokenCount, setTokenCount] = useState(0);
  const [watchdogTime, setWatchdogTime] = useState(90);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const watchdogRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const steps = simulateError ? errorSteps : normalSteps;

  const colors = {
    bg: isDark ? "#1e1e1c" : "#ffffff",
    surface: isDark ? "#2a2a28" : "#f5f4ed",
    text: isDark ? "#f5f4ed" : "#141413",
    textMuted: isDark ? "#87867f" : "#87867f",
    border: isDark ? "#444" : "#c2c0b6",
    terracotta: "#d97757",
    green: "#22c55e",
    red: "#ef4444",
    amber: "#eda100",
    blue: isDark ? "#60a5fa" : "#3b82f6",
    cacheBg: isDark
      ? "rgba(34, 197, 94, 0.12)"
      : "rgba(34, 197, 94, 0.08)",
    errorBg: isDark
      ? "rgba(239, 68, 68, 0.12)"
      : "rgba(239, 68, 68, 0.08)",
    retryBg: isDark
      ? "rgba(237, 161, 0, 0.12)"
      : "rgba(237, 161, 0, 0.08)",
    watchdogBg: isDark
      ? "rgba(96, 165, 250, 0.12)"
      : "rgba(59, 130, 246, 0.08)",
  };

  const cleanup = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (watchdogRef.current) {
      clearInterval(watchdogRef.current);
      watchdogRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    cleanup();
    setCurrentStep(-1);
    setIsPlaying(false);
    setTokenCount(0);
    setWatchdogTime(90);
  }, [cleanup]);

  // Cleanup on unmount
  useEffect(() => cleanup, [cleanup]);

  // Reset when toggling error mode
  useEffect(() => {
    reset();
  }, [simulateError, reset]);

  // Auto-play logic
  useEffect(() => {
    if (!isPlaying) return;

    if (currentStep >= steps.length - 1) {
      setIsPlaying(false);
      return;
    }

    const delay = steps[currentStep + 1]?.highlight === "retry" ? 1500 : 900;
    timerRef.current = setTimeout(() => {
      setCurrentStep((prev) => prev + 1);
    }, delay) as unknown as ReturnType<typeof setInterval>;

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [isPlaying, currentStep, steps]);

  // Update token count and watchdog on step change
  useEffect(() => {
    if (currentStep < 0) return;
    const step = steps[currentStep];
    if (step?.tokens !== undefined) {
      setTokenCount(step.tokens);
    }

    // Reset watchdog on streaming steps
    if (step?.highlight === "watchdog") {
      setWatchdogTime(90);
      // Start countdown
      watchdogRef.current = setInterval(() => {
        setWatchdogTime((prev) => {
          if (prev <= 0) {
            if (watchdogRef.current) clearInterval(watchdogRef.current);
            return 0;
          }
          return prev - 1;
        });
      }, 50) as ReturnType<typeof setInterval>;
    } else if (
      step?.from === "api" &&
      step?.to === "loop" &&
      !step?.highlight
    ) {
      // Reset watchdog on normal chunks
      setWatchdogTime(90);
    }
  }, [currentStep, steps]);

  const stepForward = () => {
    if (currentStep < steps.length - 1) {
      setCurrentStep((prev) => prev + 1);
    }
  };

  const play = () => {
    if (currentStep >= steps.length - 1) {
      reset();
      setTimeout(() => {
        setIsPlaying(true);
        setCurrentStep(0);
      }, 100);
    } else {
      setIsPlaying(true);
      if (currentStep < 0) setCurrentStep(0);
    }
  };

  const highlightColor = (h?: string) => {
    switch (h) {
      case "cache":
        return colors.green;
      case "watchdog":
        return colors.blue;
      case "error":
        return colors.red;
      case "retry":
        return colors.amber;
      default:
        return colors.terracotta;
    }
  };

  const highlightBg = (h?: string) => {
    switch (h) {
      case "cache":
        return colors.cacheBg;
      case "error":
        return colors.errorBg;
      case "retry":
        return colors.retryBg;
      case "watchdog":
        return colors.watchdogBg;
      default:
        return "transparent";
    }
  };

  // Compute column width based on container
  const colWidth = 160;
  const diagramWidth = colWidth * 4;

  return (
    <div
      className={className}
      style={{
        fontFamily: "var(--font-serif)",
        color: colors.text,
        maxWidth: 860,
        margin: "0 auto",
      }}
    >
      {/* Header */}
      <div style={{ marginBottom: 20 }}>
        <h3
          style={{
            fontFamily: "var(--font-serif)",
            fontSize: 20,
            fontWeight: 600,
            margin: "0 0 6px 0",
            color: colors.text,
          }}
        >
          API 요청/응답 수명주기
        </h3>
        <p
          style={{
            fontSize: 14,
            color: colors.textMuted,
            margin: 0,
            lineHeight: 1.5,
          }}
        >
          공급자를 통해 쿼리 루프에서 추적된 단일 API 호출
          선택, 캐싱, 스트리밍 및 오류 복구.
        </p>
      </div>

      {/* Controls */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginBottom: 20,
          flexWrap: "wrap",
        }}
      >
        <button
          onClick={isPlaying ? () => setIsPlaying(false) : play}
          style={{
            padding: "8px 20px",
            borderRadius: 8,
            border: "none",
            background: colors.terracotta,
            color: "#fff",
            cursor: "pointer",
            fontFamily: "var(--font-mono)",
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          {isPlaying
            ? "⏸ 일시 정지"
            : currentStep >= steps.length - 1
              ? "↻ 다시보기"
              : "▶ 플레이"}
        </button>

        <button
          onClick={stepForward}
          disabled={isPlaying || currentStep >= steps.length - 1}
          style={{
            padding: "8px 16px",
            borderRadius: 8,
            border: `1px solid ${colors.border}`,
            background: colors.surface,
            color:
              isPlaying || currentStep >= steps.length - 1
                ? colors.textMuted
                : colors.text,
            cursor:
              isPlaying || currentStep >= steps.length - 1
                ? "not-allowed"
                : "pointer",
            fontFamily: "var(--font-mono)",
            fontSize: 13,
          }}
        >
          단계 \u25B6\u258F
        </button>

        <button
          onClick={reset}
          style={{
            padding: "8px 16px",
            borderRadius: 8,
            border: `1px solid ${colors.border}`,
            background: colors.surface,
            color: colors.text,
            cursor: "pointer",
            fontFamily: "var(--font-mono)",
            fontSize: 13,
          }}
        >
          재설정
        </button>

        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontFamily: "var(--font-mono)",
            fontSize: 13,
            color: colors.textMuted,
            cursor: "pointer",
            marginLeft: 4,
          }}
        >
          <input
            type="checkbox"
            checked={simulateError}
            onChange={(e) => setSimulateError(e.target.checked)}
            style={{ accentColor: colors.red }}
          />
          529 오류 시뮬레이션
        </label>
      </div>

      {/* Status Bar */}
      <div
        style={{
          display: "flex",
          gap: 16,
          marginBottom: 16,
          flexWrap: "wrap",
        }}
      >
        {/* Token Counter */}
        <div
          style={{
            padding: "8px 14px",
            borderRadius: 8,
            background: colors.surface,
            border: `1px solid ${colors.border}`,
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span style={{ color: colors.textMuted }}>토큰:</span>
          <motion.span
            key={tokenCount}
            initial={{ y: -4, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            style={{ fontWeight: 700, color: colors.terracotta }}
          >
            {tokenCount.toLocaleString()}
          </motion.span>
        </div>

        {/* Watchdog Timer */}
        {currentStep >= 0 && (
          <div
            style={{
              padding: "8px 14px",
              borderRadius: 8,
              background: colors.watchdogBg,
              border: `1px solid ${isDark ? "rgba(96,165,250,0.3)" : "rgba(59,130,246,0.2)"}`,
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <span style={{ color: colors.blue }}>워치독:</span>
            <span
              style={{
                fontWeight: 700,
                color: watchdogTime < 30 ? colors.amber : colors.blue,
              }}
            >
              {watchdogTime}s
            </span>
          </div>
        )}

        {/* Cache Savings */}
        {currentStep >= 4 &&
          steps[Math.min(currentStep, steps.length - 1)]?.highlight ===
            "cache" && (
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              style={{
                padding: "8px 14px",
                borderRadius: 8,
                background: colors.cacheBg,
                border: `1px solid ${isDark ? "rgba(34,197,94,0.3)" : "rgba(34,197,94,0.2)"}`,
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                display: "flex",
                alignItems: "center",
                gap: 6,
                color: colors.green,
                fontWeight: 600,
              }}
            >
              $ 캐시 저장 ~60K 토큰
            </motion.div>
          )}

        {/* Step counter */}
        <div
          style={{
            padding: "8px 14px",
            borderRadius: 8,
            background: colors.surface,
            border: `1px solid ${colors.border}`,
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            color: colors.textMuted,
            marginLeft: "auto",
          }}
        >
          {currentStep + 1} / {steps.length}
        </div>
      </div>

      {/* Sequence Diagram */}
      <div
        style={{
          border: `1px solid ${colors.border}`,
          borderRadius: 12,
          overflow: "hidden",
          background: colors.surface,
        }}
      >
        {/* Participant Headers */}
        <div
          style={{
            display: "flex",
            borderBottom: `1px solid ${colors.border}`,
            background: isDark ? "#252523" : "#eae9e1",
          }}
        >
          {participants.map((p) => (
            <div
              key={p.id}
              style={{
                flex: 1,
                padding: "10px 8px",
                textAlign: "center",
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                fontWeight: 600,
                color: colors.text,
              }}
            >
              <span className="hidden sm:inline">{p.label}</span>
              <span className="sm:hidden">{p.short}</span>
            </div>
          ))}
        </div>

        {/* Lifelines + Steps */}
        <div style={{ position: "relative", minHeight: 60 }}>
          {/* Vertical lifelines */}
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              display: "flex",
              pointerEvents: "none",
            }}
          >
            {participants.map((p) => (
              <div
                key={p.id}
                style={{
                  flex: 1,
                  display: "flex",
                  justifyContent: "center",
                }}
              >
                <div
                  style={{
                    width: 1,
                    height: "100%",
                    background: colors.border,
                    opacity: 0.4,
                  }}
                />
              </div>
            ))}
          </div>

          {/* Step rows */}
          <AnimatePresence>
            {steps.map((step, idx) => {
              if (idx > currentStep) return null;

              const fromX = participantX[step.from];
              const toX = participantX[step.to];
              const isSelf = fromX === toX;
              const leftCol = Math.min(fromX, toX);
              const rightCol = Math.max(fromX, toX);
              const goingRight = toX >= fromX;

              return (
                <motion.div
                  key={`${step.id}-${simulateError ? "e" : "n"}`}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3 }}
                  style={{
                    position: "relative",
                    padding: "10px 12px",
                    borderBottom: `1px solid ${isDark ? "rgba(68,68,68,0.3)" : "rgba(194,192,182,0.3)"}`,
                    background:
                      idx === currentStep
                        ? highlightBg(step.highlight)
                        : "transparent",
                  }}
                >
                  {/* Arrow visualization */}
                  <div
                    style={{
                      display: "flex",
                      position: "relative",
                      height: 24,
                      marginBottom: 4,
                    }}
                  >
                    {participants.map((p, pIdx) => {
                      const isFrom = pIdx === fromX;
                      const isTo = pIdx === toX;
                      const isBetween =
                        !isSelf && pIdx > leftCol && pIdx < rightCol;
                      const isEndpoint = isFrom || isTo;

                      return (
                        <div
                          key={p.id}
                          style={{
                            flex: 1,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            position: "relative",
                          }}
                        >
                          {/* Dot at endpoints */}
                          {isEndpoint && (
                            <motion.div
                              initial={
                                idx === currentStep ? { scale: 0 } : undefined
                              }
                              animate={{ scale: 1 }}
                              style={{
                                width: 8,
                                height: 8,
                                borderRadius: "50%",
                                background: highlightColor(step.highlight),
                                zIndex: 2,
                              }}
                            />
                          )}

                          {/* Self-arrow (loop) */}
                          {isSelf && isFrom && (
                            <motion.div
                              initial={
                                idx === currentStep
                                  ? { scaleX: 0 }
                                  : undefined
                              }
                              animate={{ scaleX: 1 }}
                              style={{
                                position: "absolute",
                                right: -8,
                                top: -2,
                                width: 28,
                                height: 28,
                                border: `2px solid ${highlightColor(step.highlight)}`,
                                borderRadius: "0 12px 12px 0",
                                borderLeft: "none",
                                transformOrigin: "left center",
                              }}
                            />
                          )}

                          {/* Line between endpoints */}
                          {isBetween && (
                            <motion.div
                              initial={
                                idx === currentStep
                                  ? { scaleX: 0 }
                                  : undefined
                              }
                              animate={{ scaleX: 1 }}
                              transition={{ duration: 0.3 }}
                              style={{
                                position: "absolute",
                                left: 0,
                                right: 0,
                                height: 2,
                                background: highlightColor(step.highlight),
                                transformOrigin: goingRight
                                  ? "left center"
                                  : "right center",
                              }}
                            />
                          )}

                          {/* Line from 'from' to next */}
                          {isFrom && !isSelf && (
                            <motion.div
                              initial={
                                idx === currentStep
                                  ? { scaleX: 0 }
                                  : undefined
                              }
                              animate={{ scaleX: 1 }}
                              transition={{ duration: 0.3 }}
                              style={{
                                position: "absolute",
                                [goingRight ? "left" : "right"]: "50%",
                                [goingRight ? "right" : "left"]: 0,
                                height: 2,
                                background: highlightColor(step.highlight),
                                transformOrigin: goingRight
                                  ? "left center"
                                  : "right center",
                              }}
                            />
                          )}

                          {/* Line to 'to' from previous */}
                          {isTo && !isSelf && (
                            <motion.div
                              initial={
                                idx === currentStep
                                  ? { scaleX: 0 }
                                  : undefined
                              }
                              animate={{ scaleX: 1 }}
                              transition={{ duration: 0.3 }}
                              style={{
                                position: "absolute",
                                [goingRight ? "right" : "left"]: "50%",
                                [goingRight ? "left" : "right"]: 0,
                                height: 2,
                                background: highlightColor(step.highlight),
                                transformOrigin: goingRight
                                  ? "right center"
                                  : "left center",
                              }}
                            />
                          )}

                          {/* Arrowhead at 'to' */}
                          {isTo && !isSelf && (
                            <motion.div
                              initial={
                                idx === currentStep
                                  ? { opacity: 0, scale: 0 }
                                  : undefined
                              }
                              animate={{ opacity: 1, scale: 1 }}
                              transition={{ delay: 0.2 }}
                              style={{
                                position: "absolute",
                                [goingRight ? "left" : "right"]: "calc(50% - 6px)",
                                width: 0,
                                height: 0,
                                borderTop: "5px solid transparent",
                                borderBottom: "5px solid transparent",
                                [goingRight
                                  ? "borderLeft"
                                  : "borderRight"]: `6px solid ${highlightColor(step.highlight)}`,
                                zIndex: 3,
                              }}
                            />
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {/* Label */}
                  <div
                    style={{
                      textAlign: "center",
                      fontFamily: "var(--font-mono)",
                      fontSize: 12,
                      lineHeight: 1.4,
                    }}
                  >
                    <span
                      style={{
                        fontWeight: 600,
                        color:
                          idx === currentStep
                            ? highlightColor(step.highlight)
                            : colors.text,
                      }}
                    >
                      {step.label}
                    </span>
                    {step.sublabel && (
                      <span
                        style={{
                          display: "block",
                          fontSize: 11,
                          color: colors.textMuted,
                          marginTop: 1,
                        }}
                      >
                        {step.sublabel}
                      </span>
                    )}
                  </div>
                </motion.div>
              );
            })}
          </AnimatePresence>

          {/* Empty state */}
          {currentStep < 0 && (
            <div
              style={{
                padding: "32px 16px",
                textAlign: "center",
                fontFamily: "var(--font-mono)",
                fontSize: 13,
                color: colors.textMuted,
              }}
            >
              API 호출 시퀀스를 시작하려면 재생 또는 단계를 누르세요.
            </div>
          )}
        </div>
      </div>

      {/* Current Step Detail */}
      <AnimatePresence mode="wait">
        {currentStep >= 0 && currentStep < steps.length && (
          <motion.div
            key={currentStep}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.2 }}
            style={{
              marginTop: 16,
              padding: "14px 18px",
              borderRadius: 8,
              background: colors.surface,
              border: `1px solid ${colors.border}`,
              fontSize: 13,
              lineHeight: 1.6,
              color: colors.textMuted,
            }}
          >
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                fontWeight: 600,
                color: highlightColor(steps[currentStep].highlight),
                marginBottom: 4,
              }}
            >
              단계 {currentStep + 1}: {steps[currentStep].label}
            </div>
            {steps[currentStep].description}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
