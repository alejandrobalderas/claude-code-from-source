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

interface Provider {
  id: string;
  label: string;
  auth: string;
  color: string;
  icon: string;
}

const providers: Provider[] = [
  {
    id: "direct",
    label: "다이렉트 API",
    auth: "API 키 또는 OAuth",
    color: "#d97757",
    icon: "M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5",
  },
  {
    id: "bedrock",
    label: "AWS 기반암",
    auth: "AWS 자격 증명 + SSO",
    color: "#f59e0b",
    icon: "M13 2L3 14h9l-1 8 10-12h-9l1-8z",
  },
  {
    id: "vertex",
    label: "구글 버텍스 AI",
    auth: "구글 인증",
    color: "#4ade80",
    icon: "M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z",
  },
  {
    id: "foundry",
    label: "주조소",
    auth: "맞춤 인증",
    color: "#a78bfa",
    icon: "M12 3v18m-7-7l7 7 7-7M5 6l7-3 7 3",
  },
];

interface Props {
  className?: string;
}

export default function MultiProviderGraph({ className }: Props) {
  const isDark = useDarkMode();

  const colors = {
    text: isDark ? "#f5f4ed" : "#141413",
    textSecondary: "#87867f",
    cardBg: isDark ? "#1e1e1c" : "#ffffff",
    cardBorder: isDark ? "#333" : "#e8e6dc",
    terracotta: "#d97757",
    surfaceBg: isDark ? "#141413" : "#f5f4ed",
    connector: isDark ? "#555" : "#c2c0b6",
  };

  const stagger = {
    hidden: {},
    show: { transition: { staggerChildren: 0.1 } },
  };

  const fadeUp = {
    hidden: { opacity: 0, y: 12 },
    show: { opacity: 1, y: 0, transition: { duration: 0.4 } },
  };

  return (
    <div className={className} style={{ fontFamily: "var(--font-serif)" }}>
      <motion.div
        variants={stagger}
        initial="hidden"
        animate="show"
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 0,
        }}
      >
        {/* Provider Cards Row */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: 12,
            width: "100%",
            maxWidth: 720,
          }}
        >
          {providers.map((p) => (
            <motion.div
              key={p.id}
              variants={fadeUp}
              style={{
                background: colors.cardBg,
                border: `1px solid ${colors.cardBorder}`,
                borderRadius: 10,
                padding: "16px 12px",
                textAlign: "center",
                position: "relative",
              }}
            >
              <div
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: "50%",
                  background: `${p.color}18`,
                  border: `1.5px solid ${p.color}50`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  margin: "0 auto 10px",
                }}
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke={p.color}
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d={p.icon} />
                </svg>
              </div>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: colors.text,
                  marginBottom: 4,
                  fontFamily: "var(--font-mono)",
                }}
              >
                {p.label}
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: colors.textSecondary,
                  lineHeight: 1.4,
                }}
              >
                {p.auth}
              </div>
            </motion.div>
          ))}
        </div>

        {/* Connector SVG: providers -> center node */}
        <svg
          width="720"
          height="40"
          viewBox="0 0 720 40"
          style={{ display: "block", maxWidth: 720, width: "100%" }}
          preserveAspectRatio="xMidYMid meet"
        >
          {[0, 1, 2, 3].map((i) => {
            const x = 90 + i * (720 / 4 - 12 / 4) + (720 / 4 - 12) / 2;
            return (
              <line
                key={i}
                x1={x}
                y1={0}
                x2={360}
                y2={38}
                stroke={colors.connector}
                strokeWidth={1.5}
                strokeDasharray="4,3"
              />
            );
          })}
          <polygon
            points="355,38 360,46 365,38"
            fill={colors.connector}
          />
        </svg>

        {/* Center Node: getAnthropicClient() */}
        <motion.div
          variants={fadeUp}
          style={{
            background: `${colors.terracotta}12`,
            border: `2px solid ${colors.terracotta}`,
            borderRadius: 12,
            padding: "14px 28px",
            textAlign: "center",
          }}
        >
          <div
            style={{
              fontSize: 14,
              fontWeight: 700,
              fontFamily: "var(--font-mono)",
              color: colors.terracotta,
            }}
          >
            getAnthropicClient()
          </div>
          <div
            style={{
              fontSize: 11,
              color: colors.textSecondary,
              marginTop: 4,
            }}
          >
            공급자 확인, SDK 클라이언트 빌드
          </div>
        </motion.div>

        {/* Arrow down */}
        <svg
          width="20"
          height="32"
          viewBox="0 0 20 32"
          style={{ display: "block" }}
        >
          <line
            x1={10}
            y1={0}
            x2={10}
            y2={26}
            stroke={colors.connector}
            strokeWidth={1.5}
          />
          <polygon
            points="5,26 10,32 15,26"
            fill={colors.connector}
          />
        </svg>

        {/* SDK Node */}
        <motion.div
          variants={fadeUp}
          style={{
            background: colors.cardBg,
            border: `1px solid ${colors.cardBorder}`,
            borderRadius: 10,
            padding: "12px 24px",
            textAlign: "center",
          }}
        >
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              fontFamily: "var(--font-mono)",
              color: colors.text,
            }}
          >
            인류 SDK
          </div>
          <div
            style={{
              fontSize: 11,
              color: colors.textSecondary,
              marginTop: 2,
            }}
          >
            공급자에 관계없이 통합 인터페이스
          </div>
        </motion.div>

        {/* Arrow down */}
        <svg
          width="20"
          height="32"
          viewBox="0 0 20 32"
          style={{ display: "block" }}
        >
          <line
            x1={10}
            y1={0}
            x2={10}
            y2={26}
            stroke={colors.connector}
            strokeWidth={1.5}
          />
          <polygon
            points="5,26 10,32 15,26"
            fill={colors.connector}
          />
        </svg>

        {/* callModel() Node */}
        <motion.div
          variants={fadeUp}
          style={{
            background: colors.surfaceBg,
            border: `1.5px solid ${colors.cardBorder}`,
            borderRadius: 10,
            padding: "12px 24px",
            textAlign: "center",
          }}
        >
          <div
            style={{
              fontSize: 14,
              fontWeight: 700,
              fontFamily: "var(--font-mono)",
              color: colors.text,
            }}
          >
            콜모델()
          </div>
          <div
            style={{
              fontSize: 11,
              color: colors.textSecondary,
              marginTop: 2,
            }}
          >
            재시도가 포함된 스트리밍 API 요청
          </div>
        </motion.div>
      </motion.div>
    </div>
  );
}
