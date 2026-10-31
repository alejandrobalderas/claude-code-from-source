import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";

// --- Types ---

type View = "grid" | "decision" | "oauth";

interface TransportType {
  id: string;
  name: string;
  category: string;
  categoryColor: string;
  description: string;
  howItWorks: string;
  whenToUse: string;
  connectionFlow: string[];
}

interface DecisionNode {
  id: string;
  question: string;
  options: { label: string; next: string }[];
  result?: string;
  resultTransport?: string;
}

interface OAuthStep {
  id: number;
  title: string;
  description: string;
  detail: string;
}

// --- Data ---

const transports: TransportType[] = [
  {
    id: "stdio",
    name: "stdio",
    category: "Local",
    categoryColor: "#4ade80",
    description: "stdin/stdout JSON-RPC를 사용하여 하위 프로세스를 수행합니다. 유형이 생략된 경우 기본값입니다.",
    howItWorks: "Claude Code는 하위 프로세스를 생성합니다. JSON-RPC 메시지는 stdin(클라이언트에서 서버로) 및 stdout(서버에서 클라이언트로)을 통해 파이프됩니다. 네트워크도 없고 인증도 없습니다.",
    whenToUse: "로컬 도구: 파일 시스템 액세스, 데이터베이스 쿼리, 사용자 정의 스크립트. 가장 일반적인 교통수단.",
    connectionFlow: ["생성 하위 프로세스", "파이프 표준 입력/표준 출력", "도구/목록 보내기", "준비"],
  },
  {
    id: "sse",
    name: "SSE(서버 전송 이벤트)",
    category: "Remote",
    categoryColor: "#60a5fa",
    description: "레거시 HTTP 전송. 클라이언트 POST 요청, 서버는 SSE 스트림을 통해 응답을 푸시합니다.",
    howItWorks: "클라이언트는 서버-클라이언트 메시지에 대한 SSE 연결을 설정합니다. 클라이언트-서버 메시지는 HTTP POST를 통해 전송됩니다. 널리 배포되었지만 대체되었습니다.",
    whenToUse: "2025년 이전에 배포된 레거시 MCP 서버. 생태계에서는 여전히 일반적입니다.",
    connectionFlow: ["HTTP GET /sse", "SSE 스트림이 설립되었습니다.", "POST 요청", "SSE 응답"],
  },
  {
    id: "http",
    name: "스트리밍 가능한 HTTP",
    category: "Remote",
    categoryColor: "#60a5fa",
    description: "현재 사양 권장 사항. 스트리밍 응답을 위한 선택적 SSE가 포함된 POST.",
    howItWorks: "클라이언트는 HTTP POST를 통해 JSON-RPC를 보냅니다. 서버는 JSON(단순)으로 응답하거나 SSE 스트림(스트리밍)으로 업그레이드할 수 있습니다. 세션 ID를 통한 양방향.",
    whenToUse: "새로운 원격 MCP 서버. 현재 사양 권장사항입니다.",
    connectionFlow: ["POST /mcp", "응답: JSON 또는 SSE", "세션 ID가 추적되었습니다.", "-32001에 다시 시도"],
  },
  {
    id: "ws",
    name: "WebSocket",
    category: "Remote",
    categoryColor: "#60a5fa",
    description: "전이중 양방향 통신. 실제로는 드물다.",
    howItWorks: "표준 WebSocket 연결. JSON-RPC 메시지는 양방향으로 흐릅니다. Bun과 Node에는 서로 다른 WebSocket API가 있습니다. 즉, 런타임 분할이 필요합니다.",
    whenToUse: "양방향 서버 시작 통신이 필요한 경우. 외부 IDE 통합은 거의 없습니다.",
    connectionFlow: ["WS 핸드셰이크", "양방향 채널", "JSON-RPC 양방향", "연결이 끊길 때 닫기"],
  },
  {
    id: "sdk",
    name: "SDK 전송",
    category: "In-Process",
    categoryColor: "#a78bfa",
    description: "SDK 내장 시나리오에 대해 stdin/stdout을 통해 메시지를 제어합니다.",
    howItWorks: "Claude Code가 SDK를 통해 하위 프로세스로 실행될 때 사용됩니다. 제어 메시지(MCP 요청)는 에이전트 통신에 사용되는 것과 동일한 stdin/stdout을 통해 다중화됩니다.",
    whenToUse: "공식 SDK를 통해 Claude Code를 기반으로 구축하는 경우.",
    connectionFlow: ["SDK가 Claude Code를 생성합니다.", "다중 제어 메시지", "표준 입력/표준 출력을 통한 MCP", "공유 채널"],
  },
  {
    id: "sse-ide",
    name: "IDE 스튜디오",
    category: "IDE",
    categoryColor: "#f472b6",
    description: "VS Code 또는 JetBrains 확장 프로그램은 stdio 채널을 통해 통신합니다.",
    howItWorks: "IDE 확장은 확장 API를 통해 MCP 서버를 제공합니다. 통신은 네트워크 대신 IDE에 내장된 stdio 채널을 사용합니다.",
    whenToUse: "IDE의 기본 채널을 통해 MCP 도구를 노출하는 VS Code 확장입니다.",
    connectionFlow: ["IDE 확장 로드", "stdio 채널이 열렸습니다", "MCP 핸드셰이크", "사용 가능한 도구"],
  },
  {
    id: "ws-ide",
    name: "IDE 웹소켓",
    category: "IDE",
    categoryColor: "#f472b6",
    description: "WebSocket을 통한 IDE 원격 연결. 런타임별(Bun 및 노드).",
    howItWorks: "원격으로 실행되는 IDE 확장에 대한 WebSocket 연결입니다. Bun의 WebSocket은 기본적으로 프록시/TLS를 허용합니다. 노드에는 ws 패키지가 필요합니다.",
    whenToUse: "원격 IDE 연결(예: JetBrains Gateway, VS Code Remote)",
    connectionFlow: ["WS가 IDE에 연결", "런타임 감지", "Bun 기본/노드 ws", "MCP 준비"],
  },
  {
    id: "inprocess",
    name: "In-Process",
    category: "In-Process",
    categoryColor: "#a78bfa",
    description: "연결된 전송 쌍. 직접 함수 호출. 총 63줄.",
    howItWorks: "두 개의 InProcessTransport 인스턴스가 피어로 연결됩니다. send()는 queueMicrotask()를 통해 전달하여 스택 깊이 문제를 방지합니다. close()는 피어로 캐스케이드됩니다.",
    whenToUse: "동일 프로세스 MCP 서버: Chrome MCP, 컴퓨터 사용 MCP. 네트워크 오버헤드가 없습니다.",
    connectionFlow: ["연결된 쌍 만들기", "대기열마이크로태스크 전달", "직접 함수 호출", "캐스케이드 닫기"],
  },
];

const decisionTree: DecisionNode[] = [
  {
    id: "start",
    question: "MCP 서버는 어디에 있습니까?",
    options: [
      { label: "동일한 머신(로컬 프로세스)", next: "local" },
      { label: "원격 서비스(HTTP/WS)", next: "remote" },
      { label: "동일한 프로세스(내장형)", next: "inprocess" },
      { label: "IDE 확장", next: "ide" },
    ],
  },
  {
    id: "local",
    question: "",
    options: [],
    result: "stdio를 사용하세요. 네트워크도 없고 인증도 없고 파이프만 있습니다. 기본적이고 가장 일반적인 전송입니다.",
    resultTransport: "stdio",
  },
  {
    id: "remote",
    question: "서버에 스트리밍 응답이 필요합니까?",
    options: [
      { label: "예, 스트리밍이 필요합니다", next: "remote-stream" },
      { label: "아니요, 단순 요청/응답", next: "remote-simple" },
      { label: "완전한 양방향이 필요함", next: "remote-bidi" },
    ],
  },
  {
    id: "remote-stream",
    question: "서버가 레거시(2025년 이전) 배포입니까?",
    options: [
      { label: "예, 레거시 서버", next: "remote-legacy" },
      { label: "아니요, 새 서버입니다.", next: "remote-new" },
    ],
  },
  {
    id: "remote-legacy",
    question: "",
    options: [],
    result: "SSE를 사용하세요. 레거시이지만 널리 배포됩니다. 서버는 서버 전송 이벤트를 통해 응답을 푸시합니다.",
    resultTransport: "sse",
  },
  {
    id: "remote-new",
    question: "",
    options: [],
    result: "스트리밍 가능한 HTTP 사용 - 현재 사양 권장 사항. 선택적 SSE 업그레이드가 포함된 POST.",
    resultTransport: "http",
  },
  {
    id: "remote-simple",
    question: "",
    options: [],
    result: "스트리밍 가능한 HTTP 사용 - 간단한 JSON 응답에도 작동합니다. 원격에 대한 사양 기본값입니다.",
    resultTransport: "http",
  },
  {
    id: "remote-bidi",
    question: "",
    options: [],
    result: "WebSocket 사용 - 전이중 양방향. 참고: ws 패키지에 대한 Bun/Node 런타임 분할.",
    resultTransport: "ws",
  },
  {
    id: "inprocess",
    question: "서버가 MCP SDK로 구축되어 있습니까?",
    options: [
      { label: "예, SDK 기반", next: "inprocess-sdk" },
      { label: "아니요, 동일한 프로세스에 있는 맞춤 서버입니다.", next: "inprocess-linked" },
    ],
  },
  {
    id: "inprocess-sdk",
    question: "",
    options: [],
    result: "SDK 전송 사용 - 기존 stdin/stdout 채널을 통해 MCP를 다중화합니다.",
    resultTransport: "sdk",
  },
  {
    id: "inprocess-linked",
    question: "",
    options: [],
    result: "InProcessTransport를 사용하세요. -- queueMicrotask 전달과 연결된 쌍입니다. 단 63줄.",
    resultTransport: "inprocess",
  },
  {
    id: "ide",
    question: "IDE가 로컬인가요, 아니면 원격인가요?",
    options: [
      { label: "로컬 IDE(VS Code, JetBrains)", next: "ide-local" },
      { label: "원격 IDE(게이트웨이, 원격 SSH)", next: "ide-remote" },
    ],
  },
  {
    id: "ide-local",
    question: "",
    options: [],
    result: "IDE stdio 사용 - IDE의 내장 확장 채널을 통해 통신합니다.",
    resultTransport: "sse-ide",
  },
  {
    id: "ide-remote",
    question: "",
    options: [],
    result: "IDE WebSocket 사용 - 원격으로 연결합니다. Bun/Node 런타임 차이를 처리합니다.",
    resultTransport: "ws-ide",
  },
];

const oauthSteps: OAuthStep[] = [
  {
    id: 1,
    title: "서버가 401을 반환합니다.",
    description: "MCP 서버에 인증이 필요합니다",
    detail: "MCP 서버에 대한 초기 요청은 HTTP 401 Unauthorized를 반환합니다. 그러면 OAuth 검색 체인이 트리거됩니다.",
  },
  {
    id: 2,
    title: "RFC 9728 발견",
    description: "/.well-known/oauth-protected-resource 프로브",
    detail: "서버의 잘 알려진 엔드포인트에 대한 GET 요청입니다. 발견된 경우 Authorization_servers[0]를 추출하고 해당 URL에 대한 RFC 8414 검색을 진행합니다.",
  },
  {
    id: 3,
    title: "RFC 8414 메타데이터",
    description: "인증 서버 메타데이터 검색",
    detail: "OpenID/OAuth 메타데이터 문서를 가져옵니다. 포함: token_endpoint, Authorization_endpoint, 지원되는 범위, PKCE 요구 사항. 찾을 수 없는 경우 경로 인식 프로빙으로 돌아갑니다.",
  },
  {
    id: 4,
    title: "OAuth 2.0 + PKCE 흐름",
    description: "코드 검증기를 사용한 브라우저 기반 인증",
    detail: "PKCE(코드 교환용 증명 키)는 인증 코드 가로채기를 방지합니다. code_verifier를 생성하고, code_challenge를 계산하고, 사용자를 승인하도록 리디렉션하고, 토큰에 대한 코드를 교환합니다.",
  },
];

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

// --- Component ---

interface Props {
  className?: string;
}

export default function MCPTransports({ className }: Props) {
  const isDark = useDarkMode();
  const [view, setView] = useState<View>("grid");
  const [selectedTransport, setSelectedTransport] = useState<string | null>(null);
  const [decisionPath, setDecisionPath] = useState<string[]>(["start"]);
  const [activeOAuthStep, setActiveOAuthStep] = useState<number | null>(null);

  const colors = {
    accent: "#d97757",
    accentBg: isDark ? "rgba(217, 119, 87, 0.08)" : "rgba(217, 119, 87, 0.05)",
    accentBorder: "rgba(217, 119, 87, 0.5)",
    text: isDark ? "#f5f4ed" : "#141413",
    textSecondary: "#87867f",
    cardBg: isDark ? "#1e1e1c" : "#ffffff",
    cardBorder: isDark ? "#333" : "#e8e6dc",
    surfaceBg: isDark ? "#30302e" : "#f5f4ed",
    green: "#4ade80",
    greenBg: isDark ? "rgba(74, 222, 128, 0.1)" : "rgba(74, 222, 128, 0.08)",
  };

  const currentDecisionNode = decisionTree.find(
    (n) => n.id === decisionPath[decisionPath.length - 1]
  );

  const advanceDecision = useCallback(
    (nextId: string) => {
      setDecisionPath((prev) => [...prev, nextId]);
    },
    []
  );

  const resetDecision = useCallback(() => {
    setDecisionPath(["start"]);
  }, []);

  const goBackDecision = useCallback(() => {
    setDecisionPath((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev));
  }, []);

  return (
    <div className={className} style={{ fontFamily: "var(--font-serif)" }}>
      {/* View tabs */}
      <div
        style={{
          display: "flex",
          gap: 0,
          marginBottom: 24,
          borderBottom: `1px solid ${colors.cardBorder}`,
        }}
      >
        {([
          { id: "grid" as View, label: "8개의 운송수단" },
          { id: "decision" as View, label: "어느 것을 사용해야 합니까?" },
          { id: "oauth" as View, label: "OAuth 검색" },
        ]).map((tab) => (
          <button
            key={tab.id}
            onClick={() => setView(tab.id)}
            style={{
              padding: "12px 20px",
              fontSize: 13,
              fontWeight: 600,
              fontFamily: "var(--font-mono)",
              background: "none",
              border: "none",
              borderBottom:
                view === tab.id
                  ? `2px solid ${colors.accent}`
                  : "2px solid transparent",
              color: view === tab.id ? colors.accent : colors.textSecondary,
              cursor: "pointer",
              transition: "all 0.2s",
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <AnimatePresence mode="wait">
        {view === "grid" && (
          <motion.div
            key="grid"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.2 }}
          >
            <TransportGrid
              colors={colors}
              isDark={isDark}
              selectedTransport={selectedTransport}
              setSelectedTransport={setSelectedTransport}
            />
          </motion.div>
        )}
        {view === "decision" && (
          <motion.div
            key="decision"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.2 }}
          >
            <DecisionTree
              colors={colors}
              isDark={isDark}
              currentNode={currentDecisionNode!}
              path={decisionPath}
              onAdvance={advanceDecision}
              onReset={resetDecision}
              onBack={goBackDecision}
            />
          </motion.div>
        )}
        {view === "oauth" && (
          <motion.div
            key="oauth"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.2 }}
          >
            <OAuthFlow
              colors={colors}
              isDark={isDark}
              activeStep={activeOAuthStep}
              setActiveStep={setActiveOAuthStep}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// --- Transport Grid ---

function TransportGrid({
  colors,
  isDark,
  selectedTransport,
  setSelectedTransport,
}: {
  colors: Record<string, string>;
  isDark: boolean;
  selectedTransport: string | null;
  setSelectedTransport: (id: string | null) => void;
}) {
  const categories = ["Local", "Remote", "In-Process", "IDE"];

  return (
    <div>
      {/* Category legend */}
      <div style={{ display: "flex", gap: 16, marginBottom: 16, flexWrap: "wrap" }}>
        {categories.map((cat) => {
          const t = transports.find((tr) => tr.category === cat);
          return (
            <div key={cat} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <div
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  background: t?.categoryColor || "#888",
                }}
              />
              <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: colors.textSecondary }}>
                {cat}
              </span>
            </div>
          );
        })}
      </div>

      {/* Grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
          gap: 10,
          marginBottom: 16,
        }}
      >
        {transports.map((transport) => {
          const isSelected = selectedTransport === transport.id;
          return (
            <motion.button
              key={transport.id}
              onClick={() =>
                setSelectedTransport(isSelected ? null : transport.id)
              }
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              style={{
                padding: "14px 16px",
                borderRadius: 10,
                border: `1px solid ${isSelected ? transport.categoryColor : colors.cardBorder}`,
                background: isSelected
                  ? `${transport.categoryColor}10`
                  : colors.cardBg,
                cursor: "pointer",
                textAlign: "left",
                transition: "all 0.2s",
                position: "relative",
              }}
            >
              {/* Category dot */}
              <div
                style={{
                  position: "absolute",
                  top: 14,
                  right: 14,
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: transport.categoryColor,
                }}
              />

              <div
                style={{
                  fontSize: 14,
                  fontWeight: 600,
                  fontFamily: "var(--font-mono)",
                  color: isSelected ? transport.categoryColor : colors.text,
                  marginBottom: 4,
                  paddingRight: 20,
                }}
              >
                {transport.name}
              </div>
              <div
                style={{
                  fontSize: 10,
                  fontFamily: "var(--font-mono)",
                  color: transport.categoryColor,
                  marginBottom: 8,
                }}
              >
                {transport.category}
              </div>
              <div style={{ fontSize: 11, color: colors.textSecondary, lineHeight: 1.5 }}>
                {transport.description}
              </div>
            </motion.button>
          );
        })}
      </div>

      {/* Selected transport detail */}
      <AnimatePresence>
        {selectedTransport && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            style={{ overflow: "hidden" }}
          >
            {(() => {
              const t = transports.find((tr) => tr.id === selectedTransport);
              if (!t) return null;
              return (
                <div
                  style={{
                    padding: "18px 22px",
                    borderRadius: 12,
                    border: `1px solid ${t.categoryColor}40`,
                    background: `${t.categoryColor}08`,
                  }}
                >
                  <div
                    style={{
                      fontSize: 15,
                      fontWeight: 600,
                      color: colors.text,
                      marginBottom: 16,
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    {t.name}
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
                    <div>
                      <div
                        style={{
                          fontSize: 11,
                          fontWeight: 600,
                          color: t.categoryColor,
                          fontFamily: "var(--font-mono)",
                          marginBottom: 6,
                          textTransform: "uppercase",
                          letterSpacing: "0.05em",
                        }}
                      >
                        작동 방식
                      </div>
                      <div style={{ fontSize: 12, color: colors.textSecondary, lineHeight: 1.6 }}>
                        {t.howItWorks}
                      </div>
                    </div>
                    <div>
                      <div
                        style={{
                          fontSize: 11,
                          fontWeight: 600,
                          color: t.categoryColor,
                          fontFamily: "var(--font-mono)",
                          marginBottom: 6,
                          textTransform: "uppercase",
                          letterSpacing: "0.05em",
                        }}
                      >
                        사용 시기
                      </div>
                      <div style={{ fontSize: 12, color: colors.textSecondary, lineHeight: 1.6 }}>
                        {t.whenToUse}
                      </div>
                    </div>
                  </div>

                  {/* Connection flow */}
                  <div
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      color: t.categoryColor,
                      fontFamily: "var(--font-mono)",
                      marginBottom: 8,
                      textTransform: "uppercase",
                      letterSpacing: "0.05em",
                    }}
                  >
                    연결 흐름
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 0 }}>
                    {t.connectionFlow.map((step, i) => (
                      <div key={i} style={{ display: "flex", alignItems: "center", flex: 1 }}>
                        <div
                          style={{
                            flex: 1,
                            textAlign: "center",
                            padding: "8px 6px",
                            borderRadius: 8,
                            background: isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.03)",
                            fontSize: 11,
                            fontFamily: "var(--font-mono)",
                            color: colors.text,
                          }}
                        >
                          {step}
                        </div>
                        {i < t.connectionFlow.length - 1 && (
                          <svg width="16" height="12" viewBox="0 0 16 12" fill="none" style={{ flexShrink: 0 }}>
                            <path d="M2 6H14M14 6L10 2M14 6L10 10" stroke={t.categoryColor} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// --- Decision Tree ---

function DecisionTree({
  colors,
  isDark,
  currentNode,
  path,
  onAdvance,
  onReset,
  onBack,
}: {
  colors: Record<string, string>;
  isDark: boolean;
  currentNode: DecisionNode;
  path: string[];
  onAdvance: (id: string) => void;
  onReset: () => void;
  onBack: () => void;
}) {
  const isResult = !!currentNode.result;

  return (
    <div>
      {/* Path breadcrumb */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginBottom: 20,
          flexWrap: "wrap",
        }}
      >
        {path.map((nodeId, i) => {
          const node = decisionTree.find((n) => n.id === nodeId);
          return (
            <div key={nodeId} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {i > 0 && (
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path d="M4 2L8 6L4 10" stroke={colors.textSecondary} strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              )}
              <span
                style={{
                  fontSize: 11,
                  fontFamily: "var(--font-mono)",
                  color: i === path.length - 1 ? colors.accent : colors.textSecondary,
                  fontWeight: i === path.length - 1 ? 600 : 400,
                }}
              >
                {node?.result ? "결과" : node?.question?.split("?")[0] || "Start"}
              </span>
            </div>
          );
        })}
      </div>

      {/* Current node */}
      <motion.div
        key={currentNode.id}
        initial={{ opacity: 0, x: 20 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.2 }}
        style={{
          padding: "24px 28px",
          borderRadius: 14,
          border: `1px solid ${isResult ? colors.green : colors.cardBorder}`,
          background: isResult ? colors.greenBg : colors.cardBg,
          marginBottom: 20,
        }}
      >
        {isResult ? (
          <div>
            <div
              style={{
                fontSize: 11,
                fontFamily: "var(--font-mono)",
                fontWeight: 600,
                color: colors.green,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                marginBottom: 8,
              }}
            >
              추천
            </div>
            <div style={{ fontSize: 15, color: colors.text, lineHeight: 1.6, marginBottom: 16 }}>
              {currentNode.result}
            </div>
            {currentNode.resultTransport && (
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "8px 14px",
                  borderRadius: 8,
                  background: isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.03)",
                  fontFamily: "var(--font-mono)",
                  fontSize: 13,
                  fontWeight: 600,
                  color: transports.find((t) => t.id === currentNode.resultTransport)?.categoryColor || colors.accent,
                }}
              >
                <div
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: transports.find((t) => t.id === currentNode.resultTransport)?.categoryColor || colors.accent,
                  }}
                />
                {transports.find((t) => t.id === currentNode.resultTransport)?.name}
              </div>
            )}
          </div>
        ) : (
          <div>
            <div
              style={{
                fontSize: 18,
                fontWeight: 600,
                color: colors.text,
                marginBottom: 20,
              }}
            >
              {currentNode.question}
            </div>
            <div style={{ display: "grid", gap: 8 }}>
              {currentNode.options.map((opt) => (
                <motion.button
                  key={opt.next}
                  onClick={() => onAdvance(opt.next)}
                  whileHover={{ scale: 1.01, x: 4 }}
                  whileTap={{ scale: 0.99 }}
                  style={{
                    padding: "14px 18px",
                    borderRadius: 10,
                    border: `1px solid ${colors.cardBorder}`,
                    background: colors.surfaceBg,
                    cursor: "pointer",
                    textAlign: "left",
                    fontSize: 13,
                    color: colors.text,
                    fontWeight: 500,
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    transition: "border-color 0.2s",
                  }}
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
                    <path d="M6 4L10 8L6 12" stroke={colors.accent} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  {opt.label}
                </motion.button>
              ))}
            </div>
          </div>
        )}
      </motion.div>

      {/* Navigation */}
      <div style={{ display: "flex", gap: 8 }}>
        {path.length > 1 && (
          <button
            onClick={onBack}
            style={{
              padding: "8px 16px",
              borderRadius: 8,
              border: `1px solid ${colors.cardBorder}`,
              background: "transparent",
              color: colors.textSecondary,
              fontSize: 12,
              fontWeight: 600,
              fontFamily: "var(--font-mono)",
              cursor: "pointer",
            }}
          >
            뒤로
          </button>
        )}
        {path.length > 1 && (
          <button
            onClick={onReset}
            style={{
              padding: "8px 16px",
              borderRadius: 8,
              border: `1px solid ${colors.cardBorder}`,
              background: "transparent",
              color: colors.textSecondary,
              fontSize: 12,
              fontWeight: 600,
              fontFamily: "var(--font-mono)",
              cursor: "pointer",
            }}
          >
            다시 시작
          </button>
        )}
      </div>
    </div>
  );
}

// --- OAuth Flow ---

function OAuthFlow({
  colors,
  isDark,
  activeStep,
  setActiveStep,
}: {
  colors: Record<string, string>;
  isDark: boolean;
  activeStep: number | null;
  setActiveStep: (step: number | null) => void;
}) {
  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 600, color: colors.text, marginBottom: 6 }}>
        RFC 9728 + RFC 8414 OAuth 검색 체인
      </div>
      <div style={{ fontSize: 12, color: colors.textSecondary, marginBottom: 20, lineHeight: 1.5 }}>
        MCP 서버가 401을 반환하면 Claude Code는 다단계 검색 체인을 통해 인증 서버를 찾습니다.
        자세한 내용을 보려면 각 단계를 클릭하세요.
      </div>

      <div style={{ position: "relative", paddingLeft: 28 }}>
        {/* Vertical connector */}
        <div
          style={{
            position: "absolute",
            left: 14,
            top: 20,
            bottom: 20,
            width: 2,
            background: colors.cardBorder,
          }}
        />

        {oauthSteps.map((step, i) => {
          const isActive = activeStep === step.id;
          return (
            <div key={step.id} style={{ position: "relative", marginBottom: i < oauthSteps.length - 1 ? 10 : 0 }}>
              {/* Dot */}
              <motion.div
                animate={{
                  background: isActive ? colors.accent : colors.textSecondary,
                  scale: isActive ? 1.3 : 1,
                }}
                style={{
                  position: "absolute",
                  left: -28 + 14 - 5,
                  top: 18,
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  zIndex: 1,
                  transition: "all 0.2s",
                }}
              />

              <motion.button
                onClick={() => setActiveStep(isActive ? null : step.id)}
                whileHover={{ scale: 1.01 }}
                style={{
                  width: "100%",
                  padding: "14px 18px",
                  borderRadius: 10,
                  border: `1px solid ${isActive ? colors.accent : colors.cardBorder}`,
                  background: isActive ? colors.accentBg : colors.cardBg,
                  cursor: "pointer",
                  textAlign: "left",
                  transition: "all 0.2s",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      fontFamily: "var(--font-mono)",
                      color: isActive ? colors.accent : colors.textSecondary,
                      minWidth: 24,
                    }}
                  >
                    {String(step.id).padStart(2, "0")}
                  </span>
                  <span
                    style={{
                      fontSize: 14,
                      fontWeight: 600,
                      color: isActive ? colors.accent : colors.text,
                      flex: 1,
                    }}
                  >
                    {step.title}
                  </span>
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: colors.textSecondary,
                    marginTop: 4,
                    marginLeft: 34,
                  }}
                >
                  {step.description}
                </div>

                <AnimatePresence>
                  {isActive && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.2 }}
                      style={{ overflow: "hidden" }}
                    >
                      <div
                        style={{
                          fontSize: 12,
                          color: colors.textSecondary,
                          marginTop: 10,
                          marginLeft: 34,
                          padding: "10px 14px",
                          borderRadius: 8,
                          background: colors.surfaceBg,
                          lineHeight: 1.6,
                        }}
                      >
                        {step.detail}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.button>
            </div>
          );
        })}
      </div>

      {/* Fallback chain */}
      <div
        style={{
          marginTop: 20,
          padding: "14px 18px",
          borderRadius: 12,
          border: `1px solid ${colors.cardBorder}`,
          background: colors.cardBg,
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 600, color: colors.text, marginBottom: 8 }}>
          폴백 체인
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 0, flexWrap: "wrap" }}>
          {[
            { label: "RFC 9728", desc: "보호된 리소스" },
            { label: "RFC 8414", desc: "인증 서버 메타데이터" },
            { label: "경로 인식 프로빙", desc: "MCP 서버 URL에 대해" },
            { label: "authServerMetadataUrl", desc: "탈출 해치 구성" },
          ].map((step, i) => (
            <div key={step.label} style={{ display: "flex", alignItems: "center" }}>
              <div
                style={{
                  textAlign: "center",
                  padding: "8px 10px",
                  borderRadius: 8,
                  background: colors.surfaceBg,
                  minWidth: 80,
                }}
              >
                <div style={{ fontSize: 10, fontWeight: 600, fontFamily: "var(--font-mono)", color: colors.accent }}>
                  {step.label}
                </div>
                <div style={{ fontSize: 9, color: colors.textSecondary, marginTop: 2 }}>{step.desc}</div>
              </div>
              {i < 3 && (
                <div style={{ padding: "0 4px" }}>
                  <svg width="16" height="12" viewBox="0 0 16 12" fill="none">
                    <path d="M2 6H14M14 6L10 2M14 6L10 10" stroke={colors.textSecondary} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
              )}
            </div>
          ))}
        </div>
        <div style={{ fontSize: 11, color: colors.textSecondary, marginTop: 10, lineHeight: 1.5 }}>
          는 <code style={{ fontFamily: "var(--font-mono)", fontSize: 10 }}>authServerMetadataUrl</code> 일부 OAuth 서버는 RFC를 구현하지 않기 때문에 탈출 해치가 존재합니다.
        </div>
      </div>
    </div>
  );
}
