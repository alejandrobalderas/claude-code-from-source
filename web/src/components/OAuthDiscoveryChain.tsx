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
    blue: "#60a5fa",
    green: "#22c55e",
    purple: "#c084fc",
  };
}

// --- Chain Steps ---

interface ChainStep {
  number: number;
  title: string;
  description: string;
  method?: string;
  url?: string;
  result?: string;
  accent: string;
  phase: "discovery" | "configuration" | "exchange";
}

const chainSteps: ChainStep[] = [
  {
    number: 1,
    title: "인증 필요",
    description: "서버가 인증되지 않은 요청을 거부합니다.",
    method: "ANY",
    url: "/tools/list",
    result: "401 무단",
    accent: "#ef4444",
    phase: "discovery",
  },
  {
    number: 2,
    title: "자원 발견",
    description: "보호된 리소스 메타데이터에 대한 RFC 9728 프로브",
    method: "GET",
    url: "/.well-known/oauth-protected-resource",
    result: "{ \"authorization_servers\": [\"https://auth.example.com\"] }",
    accent: "#60a5fa",
    phase: "discovery",
  },
  {
    number: 3,
    title: "인증 서버 추출",
    description: "목록에서 첫 번째 인증 서버를 선택하세요.",
    result: "인증_서버[0]",
    accent: "#60a5fa",
    phase: "discovery",
  },
  {
    number: 4,
    title: "서버 구성",
    description: "엔드포인트에 대한 RFC 8414 OpenID 검색",
    method: "GET",
    url: "/.well-known/openid-configuration",
    result: "{ \"토큰_엔드포인트\", \"승인_엔드포인트\", ... }",
    accent: "#c084fc",
    phase: "configuration",
  },
  {
    number: 5,
    title: "PKCE 챌린지",
    description: "암호화 코드 검증기 및 챌린지 생성",
    result: "code_verifier = 무작위(43) → code_challenge = SHA256(검증기)",
    accent: "#22c55e",
    phase: "exchange",
  },
  {
    number: 6,
    title: "승인 + 토큰 교환",
    description: "사용자를 승인하도록 리디렉션한 다음 코드를 토큰으로 교환하세요.",
    method: "POST",
    url: "/oauth/token",
    result: "{ \"access_token\": \"eyJ...\" }",
    accent: "#22c55e",
    phase: "exchange",
  },
];

// --- Phase labels ---

const phaseLabels: Record<string, { label: string; color: string }> = {
  discovery: { label: "발견", color: "#60a5fa" },
  configuration: { label: "구성", color: "#c084fc" },
  exchange: { label: "토큰 교환", color: "#22c55e" },
};

// --- Down Arrow ---

function DownArrow({ color }: { color: string }) {
  return (
    <svg
      width="24"
      height="28"
      viewBox="0 0 24 28"
      fill="none"
      style={{ display: "block", margin: "0 auto" }}
    >
      <line
        x1="12"
        y1="2"
        x2="12"
        y2="22"
        stroke={color}
        strokeWidth="1.5"
      />
      <polyline
        points="7,18 12,25 17,18"
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// --- Step Card ---

function StepCard({
  step,
  colors,
  delay,
  showPhaseLabel,
}: {
  step: ChainStep;
  colors: ReturnType<typeof getColors>;
  delay: number;
  showPhaseLabel: boolean;
}) {
  const phase = phaseLabels[step.phase];

  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.3 }}
      style={{
        position: "relative",
        width: "100%",
      }}
    >
      {/* Phase label */}
      {showPhaseLabel && (
        <div
          style={{
            fontSize: 10,
            fontWeight: 600,
            color: phase.color,
            textTransform: "uppercase" as const,
            letterSpacing: "0.06em",
            marginBottom: 8,
            fontFamily: "var(--font-mono)",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <div
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              backgroundColor: phase.color,
              opacity: 0.6,
            }}
          />
          {phase.label}
        </div>
      )}

      <div
        style={{
          display: "flex",
          gap: 14,
          padding: "14px 18px",
          borderRadius: 10,
          border: `1px solid ${colors.border}`,
          backgroundColor: colors.surface,
          borderLeft: `3px solid ${step.accent}`,
        }}
      >
        {/* Step Number */}
        <div
          style={{
            width: 28,
            height: 28,
            borderRadius: "50%",
            backgroundColor: `${step.accent}22`,
            border: `1.5px solid ${step.accent}55`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 13,
            fontWeight: 700,
            color: step.accent,
            fontFamily: "var(--font-mono)",
            flexShrink: 0,
          }}
        >
          {step.number}
        </div>

        {/* Content */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: colors.text,
              lineHeight: 1.3,
              marginBottom: 3,
            }}
          >
            {step.title}
          </div>
          <div
            style={{
              fontSize: 12,
              color: colors.textMuted,
              lineHeight: 1.4,
              marginBottom: step.method || step.result ? 8 : 0,
            }}
          >
            {step.description}
          </div>

          {/* HTTP Method + URL */}
          {step.method && step.url && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginBottom: 6,
              }}
            >
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  color: step.accent,
                  backgroundColor: `${step.accent}18`,
                  padding: "2px 6px",
                  borderRadius: 4,
                  fontFamily: "var(--font-mono)",
                }}
              >
                {step.method}
              </span>
              <span
                style={{
                  fontSize: 12,
                  color: colors.text,
                  fontFamily: "var(--font-mono)",
                  opacity: 0.85,
                }}
              >
                {step.url}
              </span>
            </div>
          )}

          {/* Result */}
          {step.result && (
            <div
              style={{
                fontSize: 11,
                fontFamily: "var(--font-mono)",
                color: colors.textMuted,
                backgroundColor: `${colors.border}22`,
                padding: "5px 8px",
                borderRadius: 5,
                lineHeight: 1.4,
                overflowX: "auto",
                whiteSpace: "nowrap",
              }}
            >
              {step.result}
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}

// --- Main Component ---

export default function OAuthDiscoveryChain({
  className = "",
}: {
  className?: string;
}) {
  const isDark = useDarkMode();
  const colors = getColors(isDark);

  // Determine which steps start a new phase
  let lastPhase = "";

  return (
    <div
      className={className}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 0,
        width: "100%",
        maxWidth: 560,
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
        OAuth 2.0 + PKCE 디스커버리 체인
      </motion.div>

      {chainSteps.map((step, i) => {
        const showPhaseLabel = step.phase !== lastPhase;
        lastPhase = step.phase;

        return (
          <div key={step.number} style={{ width: "100%" }}>
            {i > 0 && <DownArrow color={colors.border} />}
            <StepCard
              step={step}
              colors={colors}
              delay={i * 0.08}
              showPhaseLabel={showPhaseLabel}
            />
          </div>
        );
      })}
    </div>
  );
}
