import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";

// --- Dark mode hook ---

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

type Provider = "direct" | "bedrock" | "vertex";

interface PromptSection {
  id: string;
  label: string;
  tier: "static" | "boundary" | "dynamic";
  description: string;
  tokenEstimate: string;
  cacheScope: string;
  contents: string[];
}

const PROMPT_SECTIONS: PromptSection[] = [
  {
    id: "identity",
    label: "아이덴티티 & 소개",
    tier: "static",
    description: "시스템 정체성, 역할 설명 및 행동 기반",
    tokenEstimate: "~200",
    cacheScope: "global",
    contents: ["당신은 전문 소프트웨어 엔지니어 클로드 코드입니다...", "핵심 행동 규칙 및 안전 지침"],
  },
  {
    id: "behavior",
    label: "시스템 동작 규칙",
    tier: "static",
    description: "응답 형식, 안전 제약, 거부 패턴",
    tokenEstimate: "~500",
    cacheScope: "global",
    contents: ["도구 호출 규칙", "오류 처리 규칙", "안전 및 콘텐츠 정책"],
  },
  {
    id: "tasks",
    label: "작업 지침 수행",
    tier: "static",
    description: "다단계 작업, 계획, 검증에 접근하는 방법",
    tokenEstimate: "~400",
    cacheScope: "global",
    contents: ["작업 분해 규칙", "확인 요구 사항", "질문해야 할 때와 진행해야 할 때"],
  },
  {
    id: "actions",
    label: "조치 지침",
    tier: "static",
    description: "도구 정의, 스키마 및 사용 지침",
    tokenEstimate: "~2,000",
    cacheScope: "global",
    contents: ["읽기, 쓰기, 편집, Bash, Glob, Grep 도구 스키마", "도구 선택 휴리스틱", "파일 조작 규칙"],
  },
  {
    id: "tools",
    label: "도구 사용 지침",
    tier: "static",
    description: "자세한 도구별 사용 패턴 및 제약 사항",
    tokenEstimate: "~3,000",
    cacheScope: "global",
    contents: ["Git 워크플로 규칙", "패턴 생성 전 검색", "파일 편집 모범 사례"],
  },
  {
    id: "tone",
    label: "톤 & 스타일",
    tier: "static",
    description: "출력 형식, 간결성 규칙, 의사소통 스타일",
    tokenEstimate: "~300",
    cacheScope: "global",
    contents: ["기본적으로 간결함", "불필요한 서문 없음", "기술적 정밀도"],
  },
  {
    id: "efficiency",
    label: "출력 효율성",
    tier: "static",
    description: "유용성을 극대화하면서 토큰 출력을 최소화하기 위한 규칙",
    tokenEstimate: "~200",
    cacheScope: "global",
    contents: ["질문을 다시 언급하지 마세요", "관련 코드만 표시", "일괄 도구 호출"],
  },
  {
    id: "boundary",
    label: "=== 동적 경계 ===",
    tier: "boundary",
    description: "캐시 중단점: 위의 모든 내용은 모든 사용자가 전역적으로 공유됩니다. 아래의 모든 내용은 세션별입니다. 이 경계를 넘어 섹션을 이동하면 플릿 전체 캐시 성능에 영향을 미칩니다.",
    tokenEstimate: "marker",
    cacheScope: "break",
    contents: ["아래의 각 조건은 Blake2b 접두사 해시 변형(2^N)을 곱하는 런타임 비트입니다."],
  },
  {
    id: "session",
    label: "세션 안내",
    tier: "dynamic",
    description: "세션별 동작 재정의 및 기능 플래그",
    tokenEstimate: "~300",
    cacheScope: "per-session",
    contents: ["현재 권한 모드", "활성 기능 플래그", "세션 유형(REPL 대 원샷)"],
  },
  {
    id: "memory",
    label: "메모리(CLAUDE.md)",
    tier: "dynamic",
    description: "파일 시스템에서 로드된 프로젝트별 지침",
    tokenEstimate: "~2,000-50,000",
    cacheScope: "per-session",
    contents: ["사용자의 CLAUDE.md 콘텐츠", "프로젝트 규칙", "사용자 정의 규칙 및 기본 설정"],
  },
  {
    id: "environment",
    label: "환경정보",
    tier: "dynamic",
    description: "Git 상태, 작업 디렉토리, OS, 쉘 정보",
    tokenEstimate: "~500",
    cacheScope: "per-session",
    contents: ["Git 브랜치, 상태, 최근 커밋", "작업 디렉터리 경로", "OS 및 셸 버전"],
  },
  {
    id: "language",
    label: "언어 기본 설정",
    tier: "dynamic",
    description: "사용자가 선호하는 응답 언어",
    tokenEstimate: "~50",
    cacheScope: "per-session",
    contents: ["사용자의 언어로 응답"],
  },
  {
    id: "mcp",
    label: "MCP 지침",
    tier: "dynamic",
    description: "위험: 사용자별 MCP 도구 정의. MCP 정의는 사용자별로 고유하므로 존재하는 경우 전역 캐시 범위를 비활성화합니다.",
    tokenEstimate: "~1,000-10,000",
    cacheScope: "UNCACHED",
    contents: ["MCP 서버 도구 정의", "도구별 지침", "서버 연결 세부정보"],
  },
  {
    id: "output-style",
    label: "출력 스타일",
    tier: "dynamic",
    description: "세션별 출력 형식 지정 기본 설정",
    tokenEstimate: "~100",
    cacheScope: "per-session",
    contents: ["상세 모드 설정", "확장된 보기 기본 설정"],
  },
];

const PROVIDER_INFO: Record<Provider, { label: string; authDesc: string; envVar: string; color: string }> = {
  direct: {
    label: "다이렉트 API",
    authDesc: "API 키 또는 OAuth 토큰",
    envVar: "ANTHROPIC_API_KEY",
    color: "#d97757",
  },
  bedrock: {
    label: "AWS 기반암",
    authDesc: "AWS 자격 증명(IAM 역할/액세스 키)",
    envVar: "ANTHROPIC_BEDROCK_BASE_URL",
    color: "#ff9900",
  },
  vertex: {
    label: "구글 버텍스 AI",
    authDesc: "Google 인증(서비스 계정/ADC)",
    envVar: "ANTHROPIC_VERTEX_PROJECT_ID",
    color: "#4285f4",
  },
};

interface ToggleFeature {
  id: string;
  label: string;
  default: boolean;
  effect: string;
}

const TOGGLE_FEATURES: ToggleFeature[] = [
  { id: "extended-thinking", label: "확장된 사고", default: false, effect: "요청 본문에 생각 예산 추가 - 캐시 키 변경" },
  { id: "mcp-tools", label: "MCP 도구", default: false, effect: "사용자별 도구 정의 추가 - 전역 캐시 범위 비활성화" },
  { id: "auto-mode", label: "자동 모드(AFK)", default: false, effect: "베타 헤더 추가 - 일단 래치되면 세션 동안 유지됩니다." },
];

// --- Component ---

interface Props {
  className?: string;
}

export default function APICallLifecycle({ className }: Props) {
  const isDark = useDarkMode();
  const [selectedProvider, setSelectedProvider] = useState<Provider>("direct");
  const [hoveredSection, setHoveredSection] = useState<string | null>(null);
  const [features, setFeatures] = useState<Record<string, boolean>>({
    "extended-thinking": false,
    "mcp-tools": false,
    "auto-mode": false,
  });

  const colors = {
    terracotta: "#d97757",
    text: isDark ? "#f5f4ed" : "#141413",
    textSecondary: isDark ? "#87867f" : "#87867f",
    bg: isDark ? "#1e1e1c" : "#ffffff",
    bgCard: isDark ? "#2a2a28" : "#f8f7f2",
    border: isDark ? "#333" : "#c2c0b6",
    // Cache tiers
    staticBg: isDark ? "rgba(34,197,94,0.1)" : "rgba(34,197,94,0.06)",
    staticBorder: isDark ? "rgba(34,197,94,0.3)" : "rgba(34,197,94,0.2)",
    staticAccent: "#22c55e",
    boundaryBg: isDark ? "rgba(217,119,87,0.15)" : "rgba(217,119,87,0.08)",
    boundaryBorder: isDark ? "rgba(217,119,87,0.5)" : "rgba(217,119,87,0.4)",
    dynamicBg: isDark ? "rgba(245,158,11,0.1)" : "rgba(245,158,11,0.06)",
    dynamicBorder: isDark ? "rgba(245,158,11,0.3)" : "rgba(245,158,11,0.2)",
    dynamicAccent: "#f59e0b",
    uncachedBg: isDark ? "rgba(239,68,68,0.1)" : "rgba(239,68,68,0.06)",
    uncachedBorder: isDark ? "rgba(239,68,68,0.3)" : "rgba(239,68,68,0.2)",
    uncachedAccent: "#ef4444",
  };

  const toggleFeature = useCallback((id: string) => {
    setFeatures((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);

  // Compute effective sections based on features
  const effectiveSections = PROMPT_SECTIONS.filter((section) => {
    if (section.id === "mcp" && !features["mcp-tools"]) return false;
    return true;
  });

  // Calculate total tokens for static vs dynamic
  const staticTokens = effectiveSections
    .filter((s) => s.tier === "static")
    .reduce((sum, s) => {
      const match = s.tokenEstimate.match(/[\d,]+/);
      return sum + (match ? parseInt(match[0].replace(",", "")) : 0);
    }, 0);

  const hasMcp = features["mcp-tools"];
  const globalCacheDisabled = hasMcp;

  const getSectionBackground = (section: PromptSection) => {
    if (section.tier === "boundary") return colors.boundaryBg;
    if (section.tier === "static") return colors.staticBg;
    if (section.id === "mcp") return colors.uncachedBg;
    return colors.dynamicBg;
  };

  const getSectionBorder = (section: PromptSection) => {
    if (section.tier === "boundary") return colors.boundaryBorder;
    if (section.tier === "static") return colors.staticBorder;
    if (section.id === "mcp") return colors.uncachedBorder;
    return colors.dynamicBorder;
  };

  const getSectionAccent = (section: PromptSection) => {
    if (section.tier === "boundary") return colors.terracotta;
    if (section.tier === "static") return colors.staticAccent;
    if (section.id === "mcp") return colors.uncachedAccent;
    return colors.dynamicAccent;
  };

  const getCacheScopeLabel = (section: PromptSection) => {
    if (section.tier === "boundary") return "BREAK";
    if (section.tier === "static") {
      return globalCacheDisabled ? "per-session (MCP present)" : "global";
    }
    if (section.id === "mcp") return "UNCACHED";
    return "per-session";
  };

  return (
    <div className={className} style={{ fontFamily: "var(--font-serif)" }}>
      {/* Provider selector */}
      <div
        style={{
          display: "flex",
          gap: 8,
          justifyContent: "center",
          marginBottom: 16,
          flexWrap: "wrap",
        }}
      >
        <span
          style={{
            fontSize: 12,
            color: colors.textSecondary,
            fontFamily: "var(--font-mono)",
            alignSelf: "center",
          }}
        >
          제공자:
        </span>
        {(Object.keys(PROVIDER_INFO) as Provider[]).map((provider) => {
          const info = PROVIDER_INFO[provider];
          const isActive = selectedProvider === provider;
          return (
            <button
              key={provider}
              onClick={() => setSelectedProvider(provider)}
              style={{
                background: isActive ? info.color : "transparent",
                color: isActive ? "#fff" : colors.textSecondary,
                border: `1px solid ${isActive ? info.color : colors.border}`,
                borderRadius: 6,
                padding: "4px 12px",
                fontSize: 12,
                fontFamily: "var(--font-mono)",
                cursor: "pointer",
                transition: "all 0.2s",
              }}
            >
              {info.label}
            </button>
          );
        })}
      </div>

      {/* Provider info strip */}
      <AnimatePresence mode="wait">
        <motion.div
          key={selectedProvider}
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 4 }}
          transition={{ duration: 0.2 }}
          style={{
            textAlign: "center",
            marginBottom: 16,
            fontSize: 12,
            fontFamily: "var(--font-mono)",
            color: colors.textSecondary,
          }}
        >
          인증: {PROVIDER_INFO[selectedProvider].authDesc} -- 환경: <code style={{ fontSize: 11, padding: "1px 4px", borderRadius: 3, background: isDark ? "#333" : "#e8e6dc" }}>{PROVIDER_INFO[selectedProvider].envVar}</code>
          <div style={{ fontSize: 11, marginTop: 2, opacity: 0.7 }}>
            모든 공급자는 다음으로 전송됩니다. <code style={{ fontSize: 10, padding: "1px 4px", borderRadius: 3, background: isDark ? "#333" : "#e8e6dc" }}>Anthropic</code> 유형 삭제를 통해 - 소비자는 공급자를 분기하지 않습니다.
          </div>
        </motion.div>
      </AnimatePresence>

      {/* Main layout: prompt stack + details */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 280px",
          gap: 16,
          background: colors.bg,
          border: `1px solid ${colors.border}`,
          borderRadius: 8,
          padding: 16,
        }}
      >
        {/* Left: Prompt section stack */}
        <div>
          <div
            style={{
              fontSize: 11,
              fontFamily: "var(--font-mono)",
              textTransform: "uppercase",
              letterSpacing: 1,
              color: colors.textSecondary,
              marginBottom: 10,
            }}
          >
            시스템 프롬프트 구조
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            {effectiveSections.map((section) => {
              const isHovered = hoveredSection === section.id;
              const accent = getSectionAccent(section);
              const isBoundary = section.tier === "boundary";

              return (
                <motion.div
                  key={section.id}
                  onMouseEnter={() => setHoveredSection(section.id)}
                  onMouseLeave={() => setHoveredSection(null)}
                  animate={{
                    scale: isHovered ? 1.01 : 1,
                    borderColor: isHovered ? accent : getSectionBorder(section),
                  }}
                  transition={{ duration: 0.15 }}
                  style={{
                    background: getSectionBackground(section),
                    border: `1px solid ${getSectionBorder(section)}`,
                    borderRadius: isBoundary ? 0 : 6,
                    padding: isBoundary ? "8px 12px" : "8px 12px",
                    cursor: "pointer",
                    position: "relative",
                    borderLeft: isBoundary ? `3px solid ${colors.terracotta}` : `3px solid ${accent}`,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <span
                      style={{
                        fontSize: isBoundary ? 11 : 12,
                        fontFamily: "var(--font-mono)",
                        fontWeight: isBoundary ? 700 : 500,
                        color: isBoundary ? colors.terracotta : colors.text,
                        letterSpacing: isBoundary ? 1 : 0,
                      }}
                    >
                      {section.label}
                    </span>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      {!isBoundary && (
                        <span
                          style={{
                            fontSize: 10,
                            fontFamily: "var(--font-mono)",
                            color: colors.textSecondary,
                            opacity: 0.8,
                          }}
                        >
                          {section.tokenEstimate}
                        </span>
                      )}
                      <span
                        style={{
                          fontSize: 9,
                          fontFamily: "var(--font-mono)",
                          padding: "1px 6px",
                          borderRadius: 3,
                          background: isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)",
                          color: accent,
                          fontWeight: 600,
                        }}
                      >
                        {getCacheScopeLabel(section)}
                      </span>
                    </div>
                  </div>

                  {/* Expanded on hover */}
                  <AnimatePresence>
                    {isHovered && !isBoundary && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.15 }}
                        style={{ overflow: "hidden" }}
                      >
                        <div
                          style={{
                            marginTop: 6,
                            fontSize: 11,
                            color: colors.textSecondary,
                            lineHeight: 1.5,
                          }}
                        >
                          {section.description}
                        </div>
                        <div
                          style={{
                            marginTop: 4,
                            fontSize: 10,
                            fontFamily: "var(--font-mono)",
                            color: colors.textSecondary,
                            opacity: 0.8,
                          }}
                        >
                          {section.contents.map((c, i) => (
                            <div key={i} style={{ paddingLeft: 8, borderLeft: `1px solid ${accent}40`, marginBottom: 2 }}>
                              {c}
                            </div>
                          ))}
                        </div>
                      </motion.div>
                    )}
                    {isHovered && isBoundary && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.15 }}
                        style={{ overflow: "hidden" }}
                      >
                        <div
                          style={{
                            marginTop: 6,
                            fontSize: 11,
                            color: colors.terracotta,
                            lineHeight: 1.5,
                          }}
                        >
                          {section.description}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.div>
              );
            })}
          </div>
        </div>

        {/* Right: Info panel */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {/* Cache indicator */}
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
                fontFamily: "var(--font-mono)",
                textTransform: "uppercase",
                letterSpacing: 1,
                color: colors.textSecondary,
                marginBottom: 8,
              }}
            >
              캐시 상태
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginBottom: 6,
              }}
            >
              <div
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  background: globalCacheDisabled ? colors.dynamicAccent : colors.staticAccent,
                }}
              />
              <span style={{ fontSize: 12, fontFamily: "var(--font-mono)", color: colors.text }}>
                {globalCacheDisabled ? "글로벌 캐시가 비활성화되었습니다." : "글로벌 캐시 활성"}
              </span>
            </div>
            <div style={{ fontSize: 11, color: colors.textSecondary, lineHeight: 1.5 }}>
              {globalCacheDisabled
                ? "MCP 도구 정의는 사용자마다 다릅니다. 글로벌 캐시를 수백만 개의 고유한 접두사로 조각화합니다."
                : `Static sections (~${staticTokens.toLocaleString()} tokens) are cached across all Claude Code users, sessions, and organizations.`}
            </div>
          </div>

          {/* Feature toggles */}
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
                fontFamily: "var(--font-mono)",
                textTransform: "uppercase",
                letterSpacing: 1,
                color: colors.textSecondary,
                marginBottom: 8,
              }}
            >
              기능 토글
            </div>

            {TOGGLE_FEATURES.map((feature) => {
              const isOn = features[feature.id];
              return (
                <div key={feature.id} style={{ marginBottom: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
                    <button
                      onClick={() => toggleFeature(feature.id)}
                      style={{
                        width: 36,
                        height: 20,
                        borderRadius: 10,
                        border: "none",
                        cursor: "pointer",
                        position: "relative",
                        background: isOn ? colors.terracotta : (isDark ? "#444" : "#ccc"),
                        transition: "background 0.2s",
                        flexShrink: 0,
                      }}
                    >
                      <motion.div
                        animate={{ x: isOn ? 16 : 0 }}
                        transition={{ type: "spring", stiffness: 500, damping: 30 }}
                        style={{
                          width: 16,
                          height: 16,
                          borderRadius: "50%",
                          background: "#fff",
                          position: "absolute",
                          top: 2,
                          left: 2,
                          boxShadow: "0 1px 2px rgba(0,0,0,0.2)",
                        }}
                      />
                    </button>
                    <span style={{ fontSize: 12, color: colors.text }}>{feature.label}</span>
                  </div>
                  <AnimatePresence>
                    {isOn && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.15 }}
                        style={{
                          fontSize: 10,
                          fontFamily: "var(--font-mono)",
                          color: colors.terracotta,
                          paddingLeft: 44,
                          lineHeight: 1.4,
                          overflow: "hidden",
                        }}
                      >
                        {feature.effect}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              );
            })}
          </div>

          {/* 2^N explanation */}
          <div
            style={{
              background: isDark ? "rgba(217,119,87,0.08)" : "rgba(217,119,87,0.05)",
              border: `1px solid ${isDark ? "rgba(217,119,87,0.2)" : "rgba(217,119,87,0.15)"}`,
              borderRadius: 6,
              padding: "10px 12px",
              fontSize: 11,
              color: colors.textSecondary,
              lineHeight: 1.6,
            }}
          >
            <div style={{ fontWeight: 600, color: colors.terracotta, marginBottom: 4, fontFamily: "var(--font-mono)", fontSize: 10 }}>
              2^N 문제
            </div>
            경계 앞의 각 조건은 고유한 전역 캐시 항목 수를 두 배로 늘립니다.
            {Object.values(features).filter(Boolean).length > 0 && (
              <span style={{ color: colors.terracotta, fontWeight: 600 }}>
                {" "}현재 활성 토글: {Object.values(features).filter(Boolean).length} = {Math.pow(2, Object.values(features).filter(Boolean).length)} 캐시 변형.
              </span>
            )}
            {" "}정적 섹션은 캐시 조각화를 방지하기 위해 의도적으로 무조건적입니다.
          </div>

          {/* Legend */}
          <div
            style={{
              fontSize: 11,
              fontFamily: "var(--font-mono)",
              color: colors.textSecondary,
              lineHeight: 1.8,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
              <span style={{ display: "inline-block", width: 12, height: 12, borderRadius: 2, background: colors.staticBg, border: `1px solid ${colors.staticBorder}` }} />
              <span>정적(전역적으로 캐시됨)</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
              <span style={{ display: "inline-block", width: 12, height: 12, borderRadius: 2, background: colors.boundaryBg, border: `1px solid ${colors.boundaryBorder}` }} />
              <span>동적 경계</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
              <span style={{ display: "inline-block", width: 12, height: 12, borderRadius: 2, background: colors.dynamicBg, border: `1px solid ${colors.dynamicBorder}` }} />
              <span>동적(세션별)</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ display: "inline-block", width: 12, height: 12, borderRadius: 2, background: colors.uncachedBg, border: `1px solid ${colors.uncachedBorder}` }} />
              <span>캐시되지 않음(위험)</span>
            </div>
          </div>

          {/* Hover hint */}
          <div
            style={{
              textAlign: "center",
              fontSize: 11,
              color: colors.textSecondary,
              fontStyle: "italic",
            }}
          >
            자세한 내용을 보려면 섹션에 마우스를 올리세요.
          </div>
        </div>
      </div>

      {/* DANGEROUS naming convention callout */}
      <div
        style={{
          marginTop: 12,
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
            lineHeight: 1.6,
          }}
        >
          <div style={{ fontWeight: 600, color: colors.staticAccent, marginBottom: 4 }}>
            시스템프롬프트섹션()
          </div>
          안전합니다. 콘텐츠가 경계보다 먼저 이동합니다. 전역적으로 캐시됩니다. 런타임 조건은 허용되지 않습니다.
        </div>
        <div
          style={{
            background: colors.bgCard,
            borderRadius: 6,
            padding: "10px 12px",
            fontSize: 11,
            fontFamily: "var(--font-mono)",
            color: colors.textSecondary,
            lineHeight: 1.6,
          }}
        >
          <div style={{ fontWeight: 600, color: colors.uncachedAccent, marginBottom: 4 }}>
            DANGEROUS_uncachedSystemPromptSection(_reason)
          </div>
          캐시 파괴. 이유 문자열이 필요합니다. _reason 매개변수는 소스의 필수 문서입니다.
        </div>
      </div>
    </div>
  );
}
