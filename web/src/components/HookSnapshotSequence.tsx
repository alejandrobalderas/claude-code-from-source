import { useEffect, useState } from "react";
import { motion } from "framer-motion";

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

// --- Colors ---

function getColors(isDark: boolean) {
  return {
    bg: isDark ? "#1e1e1c" : "#ffffff",
    surface: isDark ? "#2a2a28" : "#f5f4ed",
    text: isDark ? "#f5f4ed" : "#141413",
    textMuted: isDark ? "#87867f" : "#87867f",
    border: isDark ? "#444" : "#c2c0b6",
    terracotta: "#d97757",
  };
}

// --- Step Data ---

interface Step {
  number: number;
  title: string;
  description: string;
  icon: string;
  iconBg: string;
  iconColor: string;
  accent: string;
}

const steps: Step[] = [
  {
    number: 1,
    title: "시작",
    description: "디스크에서 구성 읽기 및 메모리에 고정된 스냅샷",
    icon: "\u{1F512}",
    iconBg: "#22c55e22",
    iconColor: "#22c55e",
    accent: "#22c55e",
  },
  {
    number: 2,
    title: "런타임",
    description: "공격자가 디스크의 구성 파일을 수정합니다.",
    icon: "\u{26A0}\u{FE0F}",
    iconBg: "#ef444422",
    iconColor: "#ef4444",
    accent: "#ef4444",
  },
  {
    number: 3,
    title: "훅 화재",
    description: "디스크가 아닌 고정된 스냅샷에서 읽기 — 공격 실패",
    icon: "\u{1F6E1}\u{FE0F}",
    iconBg: "#22c55e22",
    iconColor: "#22c55e",
    accent: "#22c55e",
  },
];

// --- Down Arrow ---

function DownArrow({ color }: { color: string }) {
  return (
    <svg
      width="24"
      height="36"
      viewBox="0 0 24 36"
      fill="none"
      style={{ display: "block", margin: "0 auto" }}
    >
      <line
        x1="12"
        y1="2"
        x2="12"
        y2="28"
        stroke={color}
        strokeWidth="1.5"
        strokeDasharray="4 3"
      />
      <polyline
        points="7,24 12,32 17,24"
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// --- Detail Row ---

function DetailRow({
  label,
  value,
  mono,
  colors,
}: {
  label: string;
  value: string;
  mono?: boolean;
  colors: ReturnType<typeof getColors>;
}) {
  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        fontSize: 12,
        lineHeight: 1.4,
      }}
    >
      <span style={{ color: colors.textMuted, flexShrink: 0 }}>{label}</span>
      <span
        style={{
          color: colors.text,
          fontFamily: mono ? "var(--font-mono)" : "inherit",
          fontWeight: 500,
        }}
      >
        {value}
      </span>
    </div>
  );
}

// --- Main Component ---

export default function HookSnapshotSequence({
  className = "",
}: {
  className?: string;
}) {
  const isDark = useDarkMode();
  const colors = getColors(isDark);

  return (
    <div
      className={className}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 0,
        width: "100%",
        maxWidth: 520,
        margin: "0 auto",
      }}
    >
      {/* Title */}
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: colors.terracotta,
          textTransform: "uppercase" as const,
          letterSpacing: "0.05em",
          marginBottom: 20,
          fontFamily: "var(--font-mono)",
        }}
      >
        스냅샷 보안 모델
      </motion.div>

      {steps.map((step, i) => (
        <div key={step.number} style={{ width: "100%" }}>
          {/* Arrow between steps */}
          {i > 0 && <DownArrow color={colors.border} />}

          {/* Step Card */}
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.12, duration: 0.35 }}
            style={{
              display: "flex",
              gap: 16,
              padding: "16px 20px",
              borderRadius: 12,
              border: `1px solid ${step.accent}33`,
              backgroundColor: colors.surface,
              alignItems: "flex-start",
            }}
          >
            {/* Step Number + Icon */}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 6,
                flexShrink: 0,
              }}
            >
              <div
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: "50%",
                  backgroundColor: step.iconBg,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 18,
                  border: `1.5px solid ${step.accent}44`,
                }}
              >
                {step.icon}
              </div>
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  color: step.accent,
                  fontFamily: "var(--font-mono)",
                }}
              >
                단계 {step.number}
              </span>
            </div>

            {/* Content */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 15,
                  fontWeight: 600,
                  color: colors.text,
                  marginBottom: 4,
                  fontFamily: "var(--font-serif)",
                }}
              >
                {step.title}
              </div>
              <div
                style={{
                  fontSize: 13,
                  color: colors.textMuted,
                  lineHeight: 1.5,
                  marginBottom: 8,
                }}
              >
                {step.description}
              </div>

              {/* Step-specific details */}
              {step.number === 1 && (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 4,
                  }}
                >
                  <DetailRow
                    label="Source:"
                    value="~/.claude/settings.json"
                    mono
                    colors={colors}
                  />
                  <DetailRow
                    label="Result:"
                    value="Object.freeze(configSnapshot)"
                    mono
                    colors={colors}
                  />
                </div>
              )}
              {step.number === 2 && (
                <div
                  style={{
                    padding: "6px 10px",
                    borderRadius: 6,
                    backgroundColor: "#ef444411",
                    border: "1px solid #ef444422",
                    fontSize: 12,
                    fontFamily: "var(--font-mono)",
                    color: "#ef4444",
                    lineHeight: 1.5,
                  }}
                >
                  {"$ echo '{\"hooks\": {\"malicious\": true}}' > settings.json"}
                </div>
              )}
              {step.number === 3 && (
                <div
                  style={{
                    display: "flex",
                    gap: 12,
                    fontSize: 12,
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  <span
                    style={{
                      textDecoration: "line-through",
                      color: "#ef4444",
                      opacity: 0.6,
                    }}
                  >
                    디스크 구성
                  </span>
                  <span style={{ color: "#22c55e", fontWeight: 600 }}>
                    고정된 스냅샷
                  </span>
                </div>
              )}
            </div>
          </motion.div>
        </div>
      ))}
    </div>
  );
}
