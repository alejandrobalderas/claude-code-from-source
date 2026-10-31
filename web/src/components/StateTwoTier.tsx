import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";

// --- Dark mode hook (matches existing pattern) ---

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

// --- Data ---

interface BootstrapField {
  key: string;
  value: string;
  description: string;
}

interface AppStateField {
  key: string;
  value: string;
  description: string;
}

const bootstrapFields: BootstrapField[] = [
  { key: "sessionId", value: "a3f7c...", description: "crypto.randomUUID()를 통해 생성된 프로세스별로 고유합니다." },
  { key: "model", value: "claude-sonnet-4", description: "mainLoopModelOverride에 의해 설정된 API 호출의 현재 모델" },
  { key: "projectRoot", value: "/users/dev/proj", description: "NFC 정규화된 경로, init() 이후 고정됨" },
  { key: "totalCostUSD", value: "$0.42", description: "단조롭게 누적되는 세션 비용" },
  { key: "permissionMode", value: "default", description: "도구 실행을 위한 신뢰 경계" },
  { key: "isInteractive", value: "true", description: "REPL 대 원샷 모드 플래그" },
  { key: "promptCache1hEligible", value: "true", description: "고정 래치 - 확장된 캐시 TTL" },
  { key: "afkModeHeaderLatched", value: "null", description: "끈끈한 걸쇠 - 한번 참이면 결코 거짓이 아닙니다." },
];

const appStateFields: AppStateField[] = [
  { key: "mainLoopModel", value: "claude-sonnet-4", description: "UI에 표시되고 다음 API 호출에 사용되는 모델" },
  { key: "theme", value: "dark", description: "UI 테마 환경설정" },
  { key: "verbose", value: "false", description: "자세한 출력 토글 표시" },
  { key: "permissionMode", value: "default", description: "변경 시 Bootstrap STATE 및 CCR에 동기화됨" },
  { key: "messages", value: "[...28 msgs]", description: "UI 렌더링을 위한 대화 기록" },
  { key: "tasks", value: "{agent-1: ...}", description: "활성 하위 에이전트 작업 추적" },
];

type AnimationStep =
  | "idle"
  | "dispatch-appstate"
  | "onchange-fires"
  | "bootstrap-updates"
  | "api-reads";

const STEP_LABELS: Record<AnimationStep, string> = {
  idle: "2계층 흐름을 보려면 '모델 변경'을 클릭하세요.",
  "파견-앱 상태": "1. UI가 AppState 스토어로 전달됩니다.",
  "onchange-fires": "2. onChange 부작용이 동시에 발생합니다.",
  "부트스트랩 업데이트": "3. 부트스트랩 STATE.model이 업데이트되었습니다.",
  "API 읽기": "4. 다음 API 호출은 Bootstrap STATE에서 읽습니다.",
};

interface StickyLatch {
  value: boolean | null;
  label: string;
}

// --- Component ---

interface Props {
  className?: string;
}

export default function StateTwoTier({ className }: Props) {
  const isDark = useDarkMode();
  const [animStep, setAnimStep] = useState<AnimationStep>("idle");
  const [isAnimating, setIsAnimating] = useState(false);
  const [bootstrapModel, setBootstrapModel] = useState("claude-sonnet-4");
  const [appStateModel, setAppStateModel] = useState("claude-sonnet-4");

  // Sticky latch demo
  const [thinkingLatch, setThinkingLatch] = useState<StickyLatch>({
    value: null,
    label: "확장된 사고",
  });

  const timeoutRefs = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clearTimeouts = useCallback(() => {
    timeoutRefs.current.forEach(clearTimeout);
    timeoutRefs.current = [];
  }, []);

  useEffect(() => () => clearTimeouts(), [clearTimeouts]);

  const colors = {
    terracotta: "#d97757",
    text: isDark ? "#f5f4ed" : "#141413",
    textSecondary: isDark ? "#87867f" : "#87867f",
    bg: isDark ? "#1e1e1c" : "#ffffff",
    bgCard: isDark ? "#2a2a28" : "#f8f7f2",
    border: isDark ? "#333" : "#c2c0b6",
    bootstrapBg: isDark ? "#2a2520" : "#fdf6f0",
    bootstrapBorder: isDark ? "#5a3d30" : "#e8c9b8",
    appstateBg: isDark ? "#1f2a20" : "#f0f8f0",
    appstateBorder: isDark ? "#2d5a2d" : "#b8d8b8",
    highlightBootstrap: isDark ? "rgba(217,119,87,0.25)" : "rgba(217,119,87,0.15)",
    highlightAppstate: isDark ? "rgba(34,197,94,0.25)" : "rgba(34,197,94,0.12)",
    green: "#22c55e",
    amber: "#f59e0b",
    arrowColor: isDark ? "#d97757" : "#d97757",
    latchOn: "#22c55e",
    latchOff: isDark ? "#555" : "#ccc",
    latchStuck: "#ef4444",
  };

  const runModelChange = useCallback(() => {
    if (isAnimating) return;
    setIsAnimating(true);
    clearTimeouts();

    const newModel = bootstrapModel === "claude-sonnet-4" ? "claude-opus-4" : "claude-sonnet-4";

    // Step 1: dispatch to AppState
    setAnimStep("dispatch-appstate");
    setAppStateModel(newModel);

    const t1 = setTimeout(() => {
      // Step 2: onChange fires
      setAnimStep("onchange-fires");
    }, 900);

    const t2 = setTimeout(() => {
      // Step 3: Bootstrap updates
      setAnimStep("bootstrap-updates");
      setBootstrapModel(newModel);
    }, 1800);

    const t3 = setTimeout(() => {
      // Step 4: API reads
      setAnimStep("api-reads");
    }, 2700);

    const t4 = setTimeout(() => {
      setAnimStep("idle");
      setIsAnimating(false);
    }, 4000);

    timeoutRefs.current = [t1, t2, t3, t4];
  }, [isAnimating, bootstrapModel, clearTimeouts]);

  const toggleThinkingLatch = useCallback(() => {
    setThinkingLatch((prev) => {
      // Once latched true, it never goes back
      if (prev.value === true) return prev; // stuck!
      return { ...prev, value: true };
    });
  }, []);

  const resetLatch = useCallback(() => {
    setThinkingLatch({ value: null, label: "확장된 사고" });
  }, []);

  // Field row component
  const FieldRow = ({
    label,
    value,
    description,
    highlighted,
    isModel,
  }: {
    label: string;
    value: string;
    description: string;
    highlighted: boolean;
    isModel?: boolean;
  }) => (
    <motion.div
      animate={{
        backgroundColor: highlighted
          ? isModel
            ? colors.highlightBootstrap
            : colors.highlightAppstate
          : "transparent",
      }}
      transition={{ duration: 0.3 }}
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "5px 10px",
        borderRadius: 4,
        gap: 8,
      }}
      title={description}
    >
      <span
        style={{
          fontSize: 12,
          fontFamily: "var(--font-mono)",
          color: colors.textSecondary,
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </span>
      <motion.span
        key={value}
        initial={highlighted ? { scale: 1.1 } : false}
        animate={{ scale: 1 }}
        style={{
          fontSize: 12,
          fontFamily: "var(--font-mono)",
          fontWeight: 600,
          color: highlighted ? colors.terracotta : colors.text,
          whiteSpace: "nowrap",
        }}
      >
        {value}
      </motion.span>
    </motion.div>
  );

  return (
    <div className={className} style={{ fontFamily: "var(--font-serif)" }}>
      {/* Step indicator */}
      <div
        style={{
          textAlign: "center",
          marginBottom: 16,
          minHeight: 24,
        }}
      >
        <AnimatePresence mode="wait">
          <motion.div
            key={animStep}
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.2 }}
            style={{
              fontSize: 13,
              fontFamily: "var(--font-mono)",
              color: animStep === "idle" ? colors.textSecondary : colors.terracotta,
              fontWeight: animStep === "idle" ? 400 : 600,
            }}
          >
            {STEP_LABELS[animStep]}
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Two-column layout */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr auto 1fr",
          gap: 0,
          background: colors.bg,
          border: `1px solid ${colors.border}`,
          borderRadius: 8,
          overflow: "hidden",
        }}
      >
        {/* Left: Bootstrap STATE */}
        <div
          style={{
            padding: "16px 14px",
            background: colors.bootstrapBg,
            borderRight: `1px solid ${colors.border}`,
          }}
        >
          <div
            style={{
              fontSize: 11,
              fontFamily: "var(--font-mono)",
              textTransform: "uppercase",
              letterSpacing: 1,
              color: colors.terracotta,
              marginBottom: 4,
              fontWeight: 600,
            }}
          >
            부트스트랩 상태
          </div>
          <div
            style={{
              fontSize: 11,
              color: colors.textSecondary,
              marginBottom: 12,
              lineHeight: 1.4,
            }}
          >
            가변 싱글톤 - React가 마운트되기 전에 사용 가능합니다. getter/setter를 통해 액세스되는 최대 80개 필드.
          </div>

          {bootstrapFields.map((field) => {
            const isModelField = field.key === "model";
            const displayValue = isModelField ? bootstrapModel : field.value;
            const highlighted =
              isModelField &&
              (animStep === "bootstrap-updates" || animStep === "api-reads");

            return (
              <FieldRow
                key={field.key}
                label={field.key}
                value={displayValue}
                description={field.description}
                highlighted={highlighted}
                isModel={true}
              />
            );
          })}

          <div
            style={{
              marginTop: 10,
              padding: "6px 10px",
              borderRadius: 4,
              background: isDark ? "rgba(217,119,87,0.08)" : "rgba(217,119,87,0.06)",
              border: `1px solid ${isDark ? "rgba(217,119,87,0.2)" : "rgba(217,119,87,0.15)"}`,
              fontSize: 11,
              color: colors.textSecondary,
              fontFamily: "var(--font-mono)",
              lineHeight: 1.5,
            }}
          >
            DAG 리프: 아무것도 가져오지 않습니다. 순환 종속성 없이 어디서나 가져올 수 있습니다.
          </div>
        </div>

        {/* Center: Arrow/Bridge */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            padding: "16px 10px",
            gap: 8,
            minWidth: 80,
          }}
        >
          {/* Init arrow: Bootstrap -> AppState */}
          <div style={{ textAlign: "center", fontSize: 10, color: colors.textSecondary, fontFamily: "var(--font-mono)" }}>
            초기화
          </div>
          <svg width="60" height="20" viewBox="0 0 60 20">
            <defs>
              <marker id="arrow-right" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                <path d="M0,0 L8,4 L0,8" fill="none" stroke={colors.textSecondary} strokeWidth="1.5" />
              </marker>
            </defs>
            <line x1="10" y1="10" x2="50" y2="10" stroke={colors.textSecondary} strokeWidth="1.5" strokeDasharray="4,3" markerEnd="url(#arrow-right)" />
          </svg>

          {/* onChange arrow: AppState -> Bootstrap */}
          <motion.div
            animate={{
              opacity: animStep === "onchange-fires" ? 1 : 0.3,
              scale: animStep === "onchange-fires" ? 1.1 : 1,
            }}
            transition={{ duration: 0.3 }}
            style={{ textAlign: "center" }}
          >
            <div style={{ fontSize: 10, color: colors.terracotta, fontFamily: "var(--font-mono)", fontWeight: 600, marginBottom: 2 }}>
              변경 시
            </div>
            <svg width="60" height="20" viewBox="0 0 60 20">
              <defs>
                <marker id="arrow-left" markerWidth="8" markerHeight="8" refX="1" refY="4" orient="auto">
                  <path d="M8,0 L0,4 L8,8" fill="none" stroke={colors.terracotta} strokeWidth="1.5" />
                </marker>
              </defs>
              <line x1="50" y1="10" x2="10" y2="10" stroke={colors.terracotta} strokeWidth="1.5" markerEnd="url(#arrow-left)" />
            </svg>
          </motion.div>

          {/* Side effect label */}
          <div
            style={{
              fontSize: 9,
              fontFamily: "var(--font-mono)",
              color: colors.textSecondary,
              textAlign: "center",
              lineHeight: 1.4,
              maxWidth: 70,
            }}
          >
            부작용으로 계층이 연결됩니다.
          </div>
        </div>

        {/* Right: AppState */}
        <div
          style={{
            padding: "16px 14px",
            background: colors.appstateBg,
            borderLeft: `1px solid ${colors.border}`,
          }}
        >
          <div
            style={{
              fontSize: 11,
              fontFamily: "var(--font-mono)",
              textTransform: "uppercase",
              letterSpacing: 1,
              color: colors.green,
              marginBottom: 4,
              fontWeight: 600,
            }}
          >
            AppState 스토어
          </div>
          <div
            style={{
              fontSize: 11,
              color: colors.textSecondary,
              marginBottom: 12,
              lineHeight: 1.4,
            }}
          >
            반응형 저장소 - Object.is 동등성을 갖춘 34줄 클로저입니다. useSyncExternalStore를 통해 React를 구동합니다.
          </div>

          {appStateFields.map((field) => {
            const isModelField = field.key === "mainLoopModel";
            const displayValue = isModelField ? appStateModel : field.value;
            const highlighted =
              isModelField &&
              (animStep === "dispatch-appstate" || animStep === "onchange-fires");

            return (
              <FieldRow
                key={field.key}
                label={field.key}
                value={displayValue}
                description={field.description}
                highlighted={highlighted}
              />
            );
          })}

          <div
            style={{
              marginTop: 10,
              padding: "6px 10px",
              borderRadius: 4,
              background: isDark ? "rgba(34,197,94,0.08)" : "rgba(34,197,94,0.06)",
              border: `1px solid ${isDark ? "rgba(34,197,94,0.2)" : "rgba(34,197,94,0.15)"}`,
              fontSize: 11,
              color: colors.textSecondary,
              fontFamily: "var(--font-mono)",
              lineHeight: 1.5,
            }}
          >
            DeepImmutable 스냅샷. 업데이터 기능은 오래된 상태의 버그를 방지합니다.
          </div>
        </div>
      </div>

      {/* Controls */}
      <div
        style={{
          display: "flex",
          gap: 8,
          justifyContent: "center",
          marginTop: 16,
        }}
      >
        <button
          onClick={runModelChange}
          disabled={isAnimating}
          style={{
            background: isAnimating ? colors.textSecondary : colors.terracotta,
            color: "#fff",
            border: "none",
            borderRadius: 6,
            padding: "6px 18px",
            fontSize: 13,
            fontFamily: "var(--font-mono)",
            cursor: isAnimating ? "not-allowed" : "pointer",
            opacity: isAnimating ? 0.5 : 1,
            transition: "opacity 0.2s",
          }}
        >
          모델 변경
        </button>
      </div>

      {/* Sticky Latch Demo */}
      <div
        style={{
          marginTop: 24,
          background: colors.bg,
          border: `1px solid ${colors.border}`,
          borderRadius: 8,
          padding: 16,
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontFamily: "var(--font-mono)",
            textTransform: "uppercase",
            letterSpacing: 1,
            color: colors.terracotta,
            marginBottom: 12,
            fontWeight: 600,
          }}
        >
          고정 래치 데모
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            flexWrap: "wrap",
          }}
        >
          {/* Toggle */}
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 13, color: colors.text }}>
              {thinkingLatch.label}
            </span>
            <button
              onClick={toggleThinkingLatch}
              style={{
                width: 48,
                height: 26,
                borderRadius: 13,
                border: "none",
                cursor: thinkingLatch.value === true ? "not-allowed" : "pointer",
                position: "relative",
                background:
                  thinkingLatch.value === true
                    ? colors.latchStuck
                    : thinkingLatch.value === null
                      ? colors.latchOff
                      : colors.latchOn,
                transition: "background 0.2s",
              }}
            >
              <motion.div
                animate={{
                  x: thinkingLatch.value === true ? 22 : thinkingLatch.value === null ? 0 : 22,
                }}
                transition={{ type: "spring", stiffness: 500, damping: 30 }}
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: "50%",
                  background: "#fff",
                  position: "absolute",
                  top: 2,
                  left: 2,
                  boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
                }}
              />
            </button>
          </div>

          {/* State indicator */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 12,
              fontFamily: "var(--font-mono)",
            }}
          >
            <span style={{ color: colors.textSecondary }}>래치 상태:</span>
            <span
              style={{
                fontWeight: 600,
                color:
                  thinkingLatch.value === null
                    ? colors.textSecondary
                    : thinkingLatch.value
                      ? colors.latchStuck
                      : colors.textSecondary,
              }}
            >
              {thinkingLatch.value === null
                ? "null(평가되지 않음)"
                : thinkingLatch.value
                  ? "사실(래치됨)"
                  : "거짓"}
            </span>
          </div>

          {thinkingLatch.value === true && (
            <motion.button
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              onClick={resetLatch}
              style={{
                background: "transparent",
                border: `1px solid ${colors.border}`,
                borderRadius: 6,
                padding: "4px 12px",
                fontSize: 11,
                fontFamily: "var(--font-mono)",
                color: colors.textSecondary,
                cursor: "pointer",
              }}
            >
              데모 재설정
            </motion.button>
          )}
        </div>

        {/* Explanation */}
        <AnimatePresence>
          {thinkingLatch.value === true && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.3 }}
              style={{
                marginTop: 12,
                padding: "10px 12px",
                borderRadius: 6,
                background: isDark ? "rgba(239,68,68,0.1)" : "rgba(239,68,68,0.06)",
                border: `1px solid ${isDark ? "rgba(239,68,68,0.3)" : "rgba(239,68,68,0.15)"}`,
                fontSize: 12,
                color: colors.text,
                lineHeight: 1.6,
                overflow: "hidden",
              }}
            >
              <strong style={{ color: colors.latchStuck }}>토글이 켜져 있습니다.</strong>{" "}
              확장된 사고가 활성화되면, <code style={{ fontSize: 11, padding: "1px 4px", borderRadius: 3, background: isDark ? "#333" : "#e8e6dc" }}>생각깨끗한걸림</code> 깃발
              숙박 <code style={{ fontSize: 11, padding: "1px 4px", borderRadius: 3, background: isDark ? "#333" : "#e8e6dc" }}>사실</code> 남은 세션 동안.{" "}
              <strong>왜요?</strong> 사고 예산은 프롬프트 캐시 키의 일부인 API 요청 본문의 일부입니다.
              이를 끄면 50,000개 이상의 시스템 프롬프트 토큰에 대한 서버 측 캐시가 파열됩니다.
              래치는 필요할 때만 캐시 네임스페이스를 입력하고 그 상태를 유지하도록 보장합니다.
            </motion.div>
          )}
        </AnimatePresence>

        {/* Three-state type reference */}
        <div
          style={{
            marginTop: 12,
            display: "flex",
            gap: 16,
            fontSize: 11,
            fontFamily: "var(--font-mono)",
            color: colors.textSecondary,
            flexWrap: "wrap",
          }}
        >
          <span>
            <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: colors.latchOff, marginRight: 4, verticalAlign: "middle" }} />
            null = 평가되지 않음
          </span>
          <span>
            <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: colors.latchStuck, marginRight: 4, verticalAlign: "middle" }} />
            true = 래치됨(영구)
          </span>
          <span>
            <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: colors.textSecondary, marginRight: 4, verticalAlign: "middle" }} />
            결코 거짓으로 돌아가지 않는다
          </span>
        </div>
      </div>

      {/* Architecture summary table */}
      <div
        style={{
          marginTop: 16,
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 12,
        }}
      >
        <div
          style={{
            background: colors.bgCard,
            borderRadius: 6,
            padding: "10px 12px",
            fontSize: 11,
            fontFamily: "var(--font-mono)",
            color: colors.textSecondary,
            lineHeight: 1.7,
          }}
        >
          <div style={{ fontWeight: 600, color: colors.terracotta, marginBottom: 4 }}>부트스트랩 상태</div>
          <div>소비자: API 클라이언트, 비용 추적기, 컨텍스트 빌더</div>
          <div>지속성: 프로세스 종료 핸들러</div>
          <div>종속성: DAG 리프(없음)</div>
          <div>테스트 재설정: ResetStateForTests()</div>
        </div>
        <div
          style={{
            background: colors.bgCard,
            borderRadius: 6,
            padding: "10px 12px",
            fontSize: 11,
            fontFamily: "var(--font-mono)",
            color: colors.textSecondary,
            lineHeight: 1.7,
          }}
        >
          <div style={{ fontWeight: 600, color: colors.green, marginBottom: 4 }}>AppState 스토어</div>
          <div>소비자: React 구성요소, 부작용</div>
          <div>지속성: onChange를 통해 디스크로</div>
          <div>종속성: 코드베이스 전체에서 유형을 가져옵니다.</div>
          <div>테스트 재설정: 새 스토어 인스턴스 생성</div>
        </div>
      </div>
    </div>
  );
}
