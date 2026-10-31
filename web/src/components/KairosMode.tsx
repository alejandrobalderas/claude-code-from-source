import { useState, useEffect } from "react";
import { motion } from "framer-motion";

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

interface Step {
  label: string;
  detail: string;
}

const standardSteps: Step[] = [
  { label: "모델 관찰", detail: "대화 중 패턴, 수정, 중요한 사실 감지" },
  { label: "메모리 파일 생성", detail: "분류된 .md 파일(user_, Feedback_, project_)을 즉시 작성합니다." },
  { label: "MEMORY.md 색인 업데이트", detail: "항상 로드되는 색인 파일에 참조 링크를 추가합니다." },
];

const kairosSteps: Step[] = [
  { label: "모델 관찰", detail: "감지는 동일하지만 구조화된 저장소가 연기됩니다." },
  { label: "일일 로그에 추가", detail: "오늘의 원시 로그에 빠르게 추가 - 흐름 중단 최소화" },
  { label: "야간/꿈 강화", detail: "일괄 프로세스: 중복 제거, 분류, 정리, 색인 업데이트" },
];

interface Props {
  className?: string;
}

export default function KairosMode({ className }: Props) {
  const isDark = useDarkMode();

  const colors = {
    text: isDark ? "#f5f4ed" : "#141413",
    textSecondary: "#87867f",
    cardBg: isDark ? "#1e1e1c" : "#ffffff",
    cardBorder: isDark ? "#333" : "#e8e6dc",
    terracotta: "#d97757",
    surfaceBg: isDark ? "#141413" : "#f5f4ed",
    connector: isDark ? "#555" : "#c2c0b6",
    kairosAccent: "#a78bfa",
    standardAccent: "#60a5fa",
  };

  const renderColumn = (
    title: string,
    subtitle: string,
    steps: Step[],
    accent: string,
    icon: React.ReactNode,
    delay: number
  ) => (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay }}
      style={{
        flex: 1,
        background: colors.cardBg,
        border: `1.5px solid ${colors.cardBorder}`,
        borderRadius: 12,
        padding: "20px",
        minWidth: 260,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 6,
        }}
      >
        {icon}
        <div
          style={{
            fontSize: 16,
            fontWeight: 700,
            color: accent,
            fontFamily: "var(--font-mono)",
          }}
        >
          {title}
        </div>
      </div>
      <div
        style={{
          fontSize: 12,
          color: colors.textSecondary,
          marginBottom: 20,
        }}
      >
        {subtitle}
      </div>

      {/* Steps */}
      <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
        {steps.map((step, i) => (
          <div key={step.label}>
            {/* Step card */}
            <div
              style={{
                display: "flex",
                gap: 12,
                alignItems: "flex-start",
              }}
            >
              {/* Step indicator */}
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  flexShrink: 0,
                }}
              >
                <div
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: "50%",
                    background: `${accent}18`,
                    border: `1.5px solid ${accent}50`,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 12,
                    fontWeight: 700,
                    fontFamily: "var(--font-mono)",
                    color: accent,
                  }}
                >
                  {i + 1}
                </div>
              </div>

              {/* Content */}
              <div style={{ paddingBottom: 4 }}>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: colors.text,
                    marginBottom: 3,
                  }}
                >
                  {step.label}
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: colors.textSecondary,
                    lineHeight: 1.5,
                  }}
                >
                  {step.detail}
                </div>
              </div>
            </div>

            {/* Connector line between steps */}
            {i < steps.length - 1 && (
              <div
                style={{
                  marginLeft: 13,
                  width: 2,
                  height: 16,
                  background: `${accent}30`,
                  borderRadius: 1,
                }}
              />
            )}
          </div>
        ))}
      </div>
    </motion.div>
  );

  // Sun icon for Standard
  const sunIcon = (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke={colors.standardAccent}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  );

  // Moon icon for KAIROS
  const moonIcon = (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke={colors.kairosAccent}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
    </svg>
  );

  return (
    <div className={className} style={{ fontFamily: "var(--font-serif)" }}>
      <div
        style={{
          display: "flex",
          gap: 20,
          alignItems: "stretch",
          flexWrap: "wrap",
        }}
      >
        {renderColumn(
          "Standard",
          "Immediate, structured writes",
          standardSteps,
          colors.standardAccent,
          sunIcon,
          0
        )}

        {/* VS divider */}
        <motion.div
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.2, duration: 0.3 }}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            alignSelf: "center",
          }}
        >
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: "50%",
              background: colors.surfaceBg,
              border: `1.5px solid ${colors.cardBorder}`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 11,
              fontWeight: 700,
              fontFamily: "var(--font-mono)",
              color: colors.textSecondary,
            }}
          >
            대
          </div>
        </motion.div>

        {renderColumn(
          "KAIROS",
          "Deferred, batch-consolidated",
          kairosSteps,
          colors.kairosAccent,
          moonIcon,
          0.15
        )}
      </div>

      {/* Comparison note */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.5, duration: 0.3 }}
        style={{
          marginTop: 16,
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 12,
        }}
      >
        <div
          style={{
            padding: "10px 14px",
            borderRadius: 8,
            background: `${colors.standardAccent}08`,
            border: `1px solid ${colors.standardAccent}25`,
            fontSize: 11,
            color: colors.textSecondary,
            textAlign: "center",
            fontFamily: "var(--font-mono)",
          }}
        >
          장점: 즉시 정리됩니다. 단점: 흐름을 중단하고 과도한 색인을 생성할 수 있음
        </div>
        <div
          style={{
            padding: "10px 14px",
            borderRadius: 8,
            background: `${colors.kairosAccent}08`,
            border: `1px solid ${colors.kairosAccent}25`,
            fontSize: 11,
            color: colors.textSecondary,
            textAlign: "center",
            fontFamily: "var(--font-mono)",
          }}
        >
          장점: 마찰이 적고 가지치기가 자연스럽습니다. 단점: /dream 규율 필요
        </div>
      </motion.div>
    </div>
  );
}
