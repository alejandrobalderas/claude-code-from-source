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

// --- Data Types ---

interface EscalationStep {
  id: number;
  label: string;
  description: string;
  detail: string;
  successCriteria: string;
}

interface ErrorType {
  id: string;
  title: string;
  code: string;
  icon: string;
  steps: EscalationStep[];
}

// --- Error Type Data ---

const errorTypes: ErrorType[] = [
  {
    id: "prompt-too-long",
    title: "프롬프트가 너무 김",
    code: "413",
    icon: "\u26A0",
    steps: [
      {
        id: 1,
        label: "컨텍스트 축소 드레인",
        description:
          "단계적 컨텍스트 축소 - 이미 제거 대상으로 표시된 자세한 도구 결과와 이전 대화 섹션을 제거합니다.",
        detail:
          "컨텍스트 파이프라인 단계가 사전에 축소됩니다. 이 단계에서는 단순히 플러시합니다. 저렴하고 빠릅니다.",
        successCriteria: "토큰 수가 모델의 컨텍스트 창 아래로 떨어집니다.",
      },
      {
        id: 2,
        label: "리액티브 컴팩트",
        description:
          "전용 컴팩트 하위 에이전트를 통한 긴급 요약. 전체 대화를 요약된 요약으로 다시 작성합니다.",
        detail:
          "원샷 가드: hasAttemptedReactiveCompact는 무한 루프를 방지합니다. 오류 유형별로 한 번만 발생하고 다시는 발생하지 않습니다.",
        successCriteria:
          "압축이 성공하고 새 토큰 수가 컨텍스트 창에 맞습니다.",
      },
      {
        id: 3,
        label: "표면 오류 및 종료",
        description:
          "모든 회복이 소진되었습니다. 오류가 최종적으로 사용자에게 표시되고 루프가 종료됩니다.",
        detail:
          "터미널 { 이유: \"prompt_too_long\" }을 반환합니다. 원천징수 패턴은 여기서 끝납니다. 사용자가 처음으로 오류를 보게 되는 경우입니다.",
        successCriteria: "해당 없음 - 터미널 상태",
      },
    ],
  },
  {
    id: "max-output-tokens",
    title: "최대 출력 토큰",
    code: "max_tokens",
    icon: "\u2702",
    steps: [
      {
        id: 1,
        label: "8K → 64K 에스컬레이션",
        description:
          "기본 출력 한도는 8,000개 토큰입니다(p99 출력은 4,911개입니다). 적중되면 maxOutputTokensOverride를 통해 64K로 에스컬레이션합니다.",
        detail:
          "요청의 1% 미만만이 8K 한도에 도달했습니다. 낮은 기본값은 차량 규모에서 상당한 비용을 절감합니다.",
        successCriteria: "64K 토큰 내에서 응답이 완료됩니다.",
      },
      {
        id: 2,
        label: "다회전 회복(×3)",
        description:
          "여전히 64K에 도달했습니다. 모델의 부분 응답이 유지되고 계속 요청이 전송됩니다. 최대 3회 시도 가능.",
        detail:
          "maxOutputTokensRecoveryCount는 시도를 추적합니다. 각 연속은 부분 출력을 추가하고 모델에 계속하도록 요청합니다.",
        successCriteria:
          "모델은 3번의 연속 시도 이내에 응답을 완료합니다.",
      },
      {
        id: 3,
        label: "표면 오류 및 종료",
        description:
          "3번의 복구 시도가 소진되었습니다. 누적된 부분 출력은 유지되지만 루프가 종료됩니다.",
        detail:
          "부분 출력과 함께 터미널 { 이유: \"완료\" }를 반환합니다. 사용자는 모델이 생성한 내용을 볼 수 있습니다.",
        successCriteria: "해당 없음 - 터미널 상태",
      },
    ],
  },
  {
    id: "media-size",
    title: "미디어/크기 오류",
    code: "media_error",
    icon: "\uD83D\uDDBC",
    steps: [
      {
        id: 1,
        label: "미디어 없이 재시도",
        description:
          "요청에서 미디어 첨부 파일(이미지, PDF)을 제거하고 재시도합니다. 너무 큰 콘텐츠 없이 컨텍스트를 다시 작성하기 위해 반응형 압축을 사용합니다.",
        detail:
          "ImageSizeError, ImageResizeError 또는 유사한 요인에 의해 트리거됩니다. 원샷 hasAttemptedReactiveCompact 가드가 여기에도 적용됩니다.",
        successCriteria:
          "미디어 제거 및 컨텍스트 재압축 후 요청 성공",
      },
      {
        id: 2,
        label: "표면 오류 및 종료",
        description:
          "미디어를 제거해도 문제가 해결되지 않았습니다. 오류가 사용자에게 표시됩니다.",
        detail:
          "터미널 { 이유: \"image_error\" }를 반환합니다. 명확한 최종 이유를 통해 발신자는 미디어별 안내를 표시할 수 있습니다.",
        successCriteria: "해당 없음 - 터미널 상태",
      },
    ],
  },
];

// --- Step Status ---

type StepStatus = "idle" | "active" | "success" | "failure";

// --- Component ---

export default function ErrorEscalation({
  className = "",
}: {
  className?: string;
}) {
  const isDark = useDarkMode();
  const [selectedError, setSelectedError] = useState<string>("prompt-too-long");
  const [stepStatuses, setStepStatuses] = useState<Record<string, StepStatus>>(
    {}
  );
  const [recoveryStep, setRecoveryStep] = useState<number>(1);
  const [isAnimating, setIsAnimating] = useState(false);
  const [showWithholding, setShowWithholding] = useState(false);
  const animationRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const currentError = errorTypes.find((e) => e.id === selectedError)!;
  const maxSteps = currentError.steps.length;

  // Colors
  const colors = {
    bg: isDark ? "#1e1e1c" : "#ffffff",
    surface: isDark ? "#2a2a28" : "#f5f4ed",
    surfaceHover: isDark ? "#333331" : "#e8e6dc",
    text: isDark ? "#f5f4ed" : "#141413",
    textMuted: isDark ? "#87867f" : "#87867f",
    border: isDark ? "#444" : "#c2c0b6",
    terracotta: "#d97757",
    green: "#22c55e",
    red: "#ef4444",
    greenBg: isDark ? "rgba(34, 197, 94, 0.1)" : "rgba(34, 197, 94, 0.08)",
    redBg: isDark ? "rgba(239, 68, 68, 0.1)" : "rgba(239, 68, 68, 0.08)",
    terracottaBg: isDark
      ? "rgba(217, 119, 87, 0.15)"
      : "rgba(217, 119, 87, 0.1)",
    withholdBg: isDark
      ? "rgba(237, 161, 0, 0.12)"
      : "rgba(237, 161, 0, 0.08)",
  };

  const resetAnimation = useCallback(() => {
    if (animationRef.current) clearTimeout(animationRef.current);
    setStepStatuses({});
    setIsAnimating(false);
    setShowWithholding(false);
  }, []);

  // Reset when error type changes
  useEffect(() => {
    resetAnimation();
  }, [selectedError, resetAnimation]);

  const triggerError = useCallback(() => {
    if (isAnimating) return;
    resetAnimation();
    setIsAnimating(true);
    setShowWithholding(true);

    const steps = currentError.steps;
    let delay = 600;

    // Animate through steps
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const stepKey = `${currentError.id}-${step.id}`;
      const isRecoveryPoint = i + 1 === recoveryStep;
      const isLastStep = i === steps.length - 1;

      // Mark active
      const activateDelay = delay;
      animationRef.current = setTimeout(() => {
        setStepStatuses((prev) => ({ ...prev, [stepKey]: "active" }));
      }, activateDelay);
      delay += 1200;

      // Mark result
      const resultDelay = delay;
      if (isRecoveryPoint && !isLastStep) {
        // Recovery succeeds here
        animationRef.current = setTimeout(() => {
          setStepStatuses((prev) => ({ ...prev, [stepKey]: "success" }));
          setShowWithholding(false);
          setTimeout(() => setIsAnimating(false), 400);
        }, resultDelay);
        break;
      } else if (isLastStep) {
        // Terminal failure
        animationRef.current = setTimeout(() => {
          setStepStatuses((prev) => ({ ...prev, [stepKey]: "failure" }));
          setShowWithholding(false);
          setTimeout(() => setIsAnimating(false), 400);
        }, resultDelay);
      } else {
        // Step fails, escalate
        animationRef.current = setTimeout(() => {
          setStepStatuses((prev) => ({ ...prev, [stepKey]: "failure" }));
        }, resultDelay);
        delay += 600;
      }
    }
  }, [isAnimating, currentError, recoveryStep, resetAnimation]);

  const getStepStatus = (stepId: number): StepStatus => {
    return stepStatuses[`${currentError.id}-${stepId}`] || "idle";
  };

  const statusIcon = (status: StepStatus) => {
    switch (status) {
      case "success":
        return "\u2713";
      case "failure":
        return "\u2717";
      case "active":
        return "\u25CF";
      default:
        return null;
    }
  };

  const statusColor = (status: StepStatus) => {
    switch (status) {
      case "success":
        return colors.green;
      case "failure":
        return colors.red;
      case "active":
        return colors.terracotta;
      default:
        return colors.border;
    }
  };

  const statusBg = (status: StepStatus) => {
    switch (status) {
      case "success":
        return colors.greenBg;
      case "failure":
        return colors.redBg;
      case "active":
        return colors.terracottaBg;
      default:
        return "transparent";
    }
  };

  return (
    <div
      className={className}
      style={{
        fontFamily: "var(--font-serif)",
        color: colors.text,
        maxWidth: 820,
        margin: "0 auto",
      }}
    >
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <h3
          style={{
            fontFamily: "var(--font-serif)",
            fontSize: 20,
            fontWeight: 600,
            margin: "0 0 6px 0",
            color: colors.text,
          }}
        >
          오류 복구 에스컬레이션 사다리
        </h3>
        <p
          style={{
            fontSize: 14,
            color: colors.textMuted,
            margin: 0,
            lineHeight: 1.5,
          }}
        >
          오류는{" "}
          <strong style={{ color: colors.terracotta }}>
            스트림에서 보류
          </strong>{" "}
          복구 시도는 자동으로 수행됩니다. 다음과 같은 경우에만 사용자에게 오류가 표시됩니다.
          모든 단계가 실패합니다.
        </p>
      </div>

      {/* Error Type Tabs */}
      <div
        style={{
          display: "flex",
          gap: 8,
          marginBottom: 20,
          flexWrap: "wrap",
        }}
      >
        {errorTypes.map((err) => {
          const isSelected = selectedError === err.id;
          return (
            <button
              key={err.id}
              onClick={() => setSelectedError(err.id)}
              style={{
                padding: "8px 16px",
                borderRadius: 8,
                border: `1px solid ${isSelected ? colors.terracotta : colors.border}`,
                background: isSelected ? colors.terracottaBg : colors.surface,
                color: isSelected ? colors.terracotta : colors.text,
                cursor: "pointer",
                fontFamily: "var(--font-mono)",
                fontSize: 13,
                fontWeight: isSelected ? 600 : 400,
                transition: "all 0.15s ease",
              }}
            >
              <span style={{ marginRight: 6 }}>{err.icon}</span>
              {err.title}
              <span
                style={{
                  marginLeft: 8,
                  fontSize: 11,
                  opacity: 0.6,
                }}
              >
                {err.code}
              </span>
            </button>
          );
        })}
      </div>

      {/* Controls Row */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          marginBottom: 20,
          flexWrap: "wrap",
        }}
      >
        <button
          onClick={triggerError}
          disabled={isAnimating}
          style={{
            padding: "8px 20px",
            borderRadius: 8,
            border: "none",
            background: isAnimating ? colors.textMuted : colors.terracotta,
            color: "#fff",
            cursor: isAnimating ? "not-allowed" : "pointer",
            fontFamily: "var(--font-mono)",
            fontSize: 13,
            fontWeight: 600,
            transition: "all 0.15s ease",
          }}
        >
          {isAnimating ? "복구 중..." : "트리거 오류"}
        </button>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 13,
            color: colors.textMuted,
          }}
        >
          <label
            style={{
              fontFamily: "var(--font-mono)",
              whiteSpace: "nowrap",
            }}
          >
            다음 단계에서 복구가 성공합니다.
          </label>
          <div style={{ display: "flex", gap: 4 }}>
            {currentError.steps.map((step, i) => {
              const isTerminal = i === currentError.steps.length - 1;
              return (
                <button
                  key={step.id}
                  onClick={() => {
                    if (!isAnimating) {
                      setRecoveryStep(step.id);
                      resetAnimation();
                    }
                  }}
                  disabled={isAnimating}
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 6,
                    border: `1px solid ${recoveryStep === step.id ? colors.terracotta : colors.border}`,
                    background:
                      recoveryStep === step.id
                        ? colors.terracottaBg
                        : colors.surface,
                    color:
                      recoveryStep === step.id
                        ? colors.terracotta
                        : isTerminal
                          ? colors.red
                          : colors.text,
                    cursor: isAnimating ? "not-allowed" : "pointer",
                    fontFamily: "var(--font-mono)",
                    fontSize: 13,
                    fontWeight: recoveryStep === step.id ? 700 : 400,
                  }}
                  title={
                    isTerminal
                      ? "All recovery fails"
                      : `Recovery succeeds at step ${step.id}`
                  }
                >
                  {isTerminal ? "\u2717" : step.id}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Withholding Banner */}
      <AnimatePresence>
        {showWithholding && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            style={{
              background: colors.withholdBg,
              border: `1px solid rgba(237, 161, 0, 0.3)`,
              borderRadius: 8,
              padding: "10px 16px",
              marginBottom: 16,
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              color: "#eda100",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <motion.span
              animate={{ opacity: [1, 0.4, 1] }}
              transition={{ duration: 1.5, repeat: Infinity }}
            >
              \u25CF
            </motion.span>
            <span>
              스트림에서 오류가 보류되었습니다. 복구가 진행 중입니다. 사용자가 본다
              아무것도.
            </span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Escalation Ladder */}
      <div
        style={{
          border: `1px solid ${colors.border}`,
          borderRadius: 12,
          overflow: "hidden",
          background: colors.surface,
        }}
      >
        <AnimatePresence mode="wait">
          <motion.div
            key={currentError.id}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2 }}
          >
            {currentError.steps.map((step, idx) => {
              const status = getStepStatus(step.id);
              const isLast = idx === currentError.steps.length - 1;

              return (
                <div key={step.id}>
                  <motion.div
                    animate={{
                      backgroundColor: statusBg(status),
                    }}
                    transition={{ duration: 0.3 }}
                    style={{
                      padding: "16px 20px",
                      position: "relative",
                    }}
                  >
                    {/* Step Header */}
                    <div
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 12,
                      }}
                    >
                      {/* Step Number / Status */}
                      <motion.div
                        animate={{
                          borderColor: statusColor(status),
                          color: statusColor(status),
                        }}
                        transition={{ duration: 0.3 }}
                        style={{
                          width: 32,
                          height: 32,
                          borderRadius: "50%",
                          border: `2px solid ${statusColor(status)}`,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontFamily: "var(--font-mono)",
                          fontSize: 14,
                          fontWeight: 700,
                          flexShrink: 0,
                        }}
                      >
                        {status === "active" ? (
                          <motion.span
                            animate={{ scale: [1, 1.3, 1] }}
                            transition={{
                              duration: 0.8,
                              repeat: Infinity,
                            }}
                          >
                            {statusIcon(status)}
                          </motion.span>
                        ) : statusIcon(status) ? (
                          <motion.span
                            initial={{ scale: 0 }}
                            animate={{ scale: 1 }}
                            transition={{
                              type: "spring",
                              stiffness: 300,
                              damping: 15,
                            }}
                          >
                            {statusIcon(status)}
                          </motion.span>
                        ) : (
                          step.id
                        )}
                      </motion.div>

                      {/* Step Content */}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "baseline",
                            gap: 8,
                            marginBottom: 4,
                          }}
                        >
                          <span
                            style={{
                              fontFamily: "var(--font-mono)",
                              fontSize: 14,
                              fontWeight: 600,
                              color:
                                status !== "idle"
                                  ? statusColor(status)
                                  : colors.text,
                            }}
                          >
                            {step.label}
                          </span>
                          {status === "success" && (
                            <motion.span
                              initial={{ opacity: 0, x: -8 }}
                              animate={{ opacity: 1, x: 0 }}
                              style={{
                                fontFamily: "var(--font-mono)",
                                fontSize: 12,
                                color: colors.green,
                                fontWeight: 600,
                              }}
                            >
                              회복되었습니다!
                            </motion.span>
                          )}
                          {status === "failure" && isLast && (
                            <motion.span
                              initial={{ opacity: 0, x: -8 }}
                              animate={{ opacity: 1, x: 0 }}
                              style={{
                                fontFamily: "var(--font-mono)",
                                fontSize: 12,
                                color: colors.red,
                                fontWeight: 600,
                              }}
                            >
                              모든 회복이 소진되었습니다.
                            </motion.span>
                          )}
                        </div>
                        <p
                          style={{
                            fontSize: 13,
                            color: colors.textMuted,
                            margin: "0 0 6px 0",
                            lineHeight: 1.5,
                          }}
                        >
                          {step.description}
                        </p>
                        <div
                          style={{
                            fontFamily: "var(--font-mono)",
                            fontSize: 11,
                            color: colors.textMuted,
                            opacity: 0.8,
                            lineHeight: 1.5,
                          }}
                        >
                          {step.detail}
                        </div>

                        {/* Success criteria */}
                        <div
                          style={{
                            marginTop: 8,
                            fontSize: 12,
                            fontFamily: "var(--font-mono)",
                            color:
                              status === "success"
                                ? colors.green
                                : colors.textMuted,
                            opacity: status === "idle" ? 0.5 : 0.9,
                          }}
                        >
                          <span style={{ opacity: 0.6 }}>\u2192 </span>
                          {step.successCriteria}
                        </div>
                      </div>
                    </div>
                  </motion.div>

                  {/* Escalation Arrow */}
                  {!isLast && (
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        paddingLeft: 34,
                        height: 28,
                        position: "relative",
                      }}
                    >
                      <motion.div
                        animate={{
                          opacity:
                            getStepStatus(step.id) === "failure" ? 1 : 0.3,
                          color:
                            getStepStatus(step.id) === "failure"
                              ? colors.red
                              : colors.border,
                        }}
                        transition={{ duration: 0.3 }}
                        style={{
                          fontFamily: "var(--font-mono)",
                          fontSize: 12,
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                        }}
                      >
                        <span style={{ fontSize: 16 }}>\u2193</span>
                        <span>
                          {getStepStatus(step.id) === "failure"
                            ? "실패 — 에스컬레이션 중..."
                            : "에스컬레이션"}
                        </span>
                      </motion.div>
                    </div>
                  )}
                </div>
              );
            })}
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Death Spiral Guards */}
      <div
        style={{
          marginTop: 16,
          padding: "12px 16px",
          borderRadius: 8,
          background: colors.surface,
          border: `1px solid ${colors.border}`,
          fontSize: 12,
          fontFamily: "var(--font-mono)",
          color: colors.textMuted,
          lineHeight: 1.6,
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: 6, color: colors.text }}>
          죽음의 나선 경비대
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span>
            \u2022 <code>hasAttemptedReactiveCompact</code> -- 원샷 플래그,
            오류당 한 번 실행됩니다.
          </span>
          <span>
            \u2022 <code>MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3</code> -- 어렵다
            연속극 한도
          </span>
          <span>
            \u2022 3회 연속 실패 후 회로 차단기가 자동 압축됨
          </span>
          <span>
            \u2022 오류 응답 시 중지 훅 없음(오류 \u2192 훅 방지)
            \u2192 재시도 \u2192 오류 루프)
          </span>
        </div>
      </div>
    </div>
  );
}
