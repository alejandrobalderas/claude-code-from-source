import { useState, useCallback, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";

// --- Types ---

interface ComponentNode {
  id: string;
  name: string;
  description: string;
  lines: string;
  keyProps: string[];
  reRenderTriggers: string[];
  isHotPath: boolean;
  children?: ComponentNode[];
}

// --- Data ---

const componentTree: ComponentNode = {
  id: "repl",
  name: "REPL",
  description:
    "전체 대화형 경험의 루트 조정자입니다. ~9개 섹션: 가져오기, 기능 플래그, 상태 관리, QueryGuard, 메시지 처리, 도구 권한 흐름, 세션 관리, 키 바인딩 설정 및 렌더링 트리. 전체적으로 React Compiler로 컴파일되었습니다.",
  lines: "~5,000",
  keyProps: ["bootstrapState", "commands", "history", "sessionId"],
  reRenderTriggers: [
    "메시지 스트림 토큰",
    "도구 사용 상태 변경",
    "권한 대화상자 열기/닫기",
    "입력 모드 변경",
  ],
  isHotPath: true,
  children: [
    {
      id: "message-list",
      name: "VirtualMessageList",
      description:
        "가상 스크롤을 사용하여 대화 메시지를 렌더링합니다. 뷰포트와 버퍼에 표시되는 메시지만 마운트합니다. 메시지당 높이 캐시가 터미널 열 변경 시 무효화됩니다. 검색 탐색을 위한 점프 핸들입니다.",
      lines: "~800",
      keyProps: ["messages", "scrollTop", "viewportHeight", "searchQuery"],
      reRenderTriggers: [
        "새 메시지가 추가되었습니다.",
        "스크롤 위치 변경",
        "검색 하이라이트 업데이트",
      ],
      isHotPath: true,
      children: [
        {
          id: "user-message",
          name: "UserMessage",
          description:
            "사용자 입력 블록. MessageRow에 래핑됩니다. 프롬프트 텍스트와 첨부된 이미지가 포함됩니다.",
          lines: "~150",
          keyProps: ["content", "images", "index"],
          reRenderTriggers: ["마운트 전용(정적 콘텐츠)"],
          isHotPath: false,
        },
        {
          id: "assistant-message",
          name: "StreamingMarkdown",
          description:
            "스트리밍 마크다운을 사용한 모델 출력. 모듈 수준 LRU(500개 항목)를 통한 토큰 캐싱. 빠른 경로 감지는 일반 텍스트에 대해 GFM 파서를 우회합니다. React Suspense를 통한 게으른 구문 강조.",
          lines: "~400",
          keyProps: ["content", "isStreaming", "highlight"],
          reRenderTriggers: [
            "모든 새 토큰(10-50/초)",
            "구문 강조 표시 해결",
          ],
          isHotPath: true,
        },
        {
          id: "tool-result",
          name: "ToolUseBlock",
          description:
            "도구 실행 결과. 도구 이름, 상태(실행 중/완료/오류) 및 축소 가능한 출력을 표시합니다. 실행 중 경과 시간 카운터를 포함합니다.",
          lines: "~300",
          keyProps: ["toolName", "status", "result", "elapsed"],
          reRenderTriggers: [
            "상태변경(실행중->완료)",
            "경과 시간 틱",
          ],
          isHotPath: false,
        },
        {
          id: "offscreen-freeze",
          name: "OffscreenFreeze",
          description:
            "성능 최적화: 메시지가 뷰포트 위로 스크롤되면 React 요소를 캐시하고 하위 트리를 고정합니다. 화면 외부 메시지의 타이머 기반 업데이트(회전자, 경과된 카운터)가 터미널 재설정을 트리거하는 것을 방지합니다.",
          lines: "~60",
          keyProps: ["isVisible", "children"],
          reRenderTriggers: ["가시성만 변경됨"],
          isHotPath: false,
        },
      ],
    },
    {
      id: "input-area",
      name: "PromptInput",
      description:
        "키 바인딩 지원, vim 모드 및 자동 완성 기능을 갖춘 텍스트 입력. 삽입/일반 모드 상태, 커서 위치 및 여러 줄 편집을 관리합니다.",
      lines: "~600",
      keyProps: ["mode", "value", "cursorPosition", "vimState"],
      reRenderTriggers: ["모든 키 입력", "모드 변경(insert/normal/vim)"],
      isHotPath: true,
      children: [
        {
          id: "prompt-line",
          name: "PromptLine",
          description:
            "모드 표시기가 있는 \">\" 프롬프트. 현재 모드(insert/normal/vim), 보류 중인 코드 접두사 및 모델 이름을 표시합니다.",
          lines: "~80",
          keyProps: ["mode", "pendingChord", "modelName"],
          reRenderTriggers: ["모드 변경", "코드 상태 변경"],
          isHotPath: false,
        },
        {
          id: "multi-line-editor",
          name: "MultiLineEditor",
          description:
            "여러 줄 입력을 처리하는 텍스트 편집기 구성 요소입니다. IME/CJK 지원을 위해 useDeclaredCursor를 통한 커서 선언. 문자소 경계 인식으로 단어 줄바꿈.",
          lines: "~350",
          keyProps: ["value", "cursor", "selection", "wrap"],
          reRenderTriggers: ["모든 키 입력", "선택 변경"],
          isHotPath: true,
        },
      ],
    },
    {
      id: "status-bar",
      name: "StatusLine",
      description:
        "모델 이름, 누적 비용, 토큰 수 및 백그라운드 작업 표시기가 포함된 하단 표시줄입니다. 새로운 토큰/비용 데이터로 모든 API 응답을 업데이트합니다.",
      lines: "~120",
      keyProps: ["model", "cost", "tokens", "activeTasks"],
      reRenderTriggers: ["API 응답(비용/토큰 업데이트)", "작업 상태 변경"],
      isHotPath: false,
    },
    {
      id: "permission-prompt",
      name: "PermissionRequest",
      description:
        "도구 권한 승인을 위한 모달 대화 상자입니다. 도구 이름, 설명, 제안된 권한을 표시합니다. 확인 컨텍스트를 통해 y/n/a(한 번 허용/거부/항상 허용) 키 바인딩을 처리합니다.",
      lines: "~250",
      keyProps: ["toolName", "description", "suggestions", "onAllow", "onDeny"],
      reRenderTriggers: ["새로운 권한 요청"],
      isHotPath: false,
    },
    {
      id: "keybinding-setup",
      name: "KeybindingSetup",
      description:
        "와이어 키 바인딩 공급자: GlobalKeybindingHandlers, CommandKeybindingHandlers, CancelRequestHandler. 컨텍스트 등록 및 코드 인터셉터를 관리합니다.",
      lines: "~200",
      keyProps: ["bindings", "contexts", "handlers"],
      reRenderTriggers: ["컨텍스트 활성화/비활성화"],
      isHotPath: false,
    },
    {
      id: "logo-header",
      name: "LogoHeader",
      description:
        "Claude 브랜딩, 모델 정보, 세션 ID가 포함된 세션 헤더입니다. 메시지 목록 상단에 한 번 렌더링됩니다.",
      lines: "~40",
      keyProps: ["sessionId", "model"],
      reRenderTriggers: ["마운트 전용"],
      isHotPath: false,
    },
  ],
};

const dataFlowSteps = [
  { from: "input-area", label: "사용자 유형을 입력하고 Enter 키를 누릅니다." },
  { from: "repl", label: "REPL은 메시지와 함께 query()를 호출합니다." },
  { from: "assistant-message", label: "토큰은 StreamingMarkdown으로 스트리밍됩니다." },
  { from: "tool-result", label: "도구 호출에 대해 도구 사용 블록이 나타납니다." },
  { from: "status-bar", label: "StatusLine은 비용/토큰 수를 업데이트합니다." },
  { from: "message-list", label: "VirtualMessageList가 맨 아래로 스크롤됩니다." },
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

function flattenTree(node: ComponentNode): ComponentNode[] {
  const result: ComponentNode[] = [node];
  if (node.children) {
    for (const child of node.children) {
      result.push(...flattenTree(child));
    }
  }
  return result;
}

// --- Component ---

interface Props {
  className?: string;
}

export default function REPLComponentTree({ className }: Props) {
  const isDark = useDarkMode();
  const [expandedIds, setExpandedIds] = useState<Set<string>>(
    new Set(["repl", "message-list", "input-area"])
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showDataFlow, setShowDataFlow] = useState(false);
  const [dataFlowStep, setDataFlowStep] = useState(-1);
  const dataFlowTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const colors = {
    text: isDark ? "#f5f4ed" : "#141413",
    textSecondary: "#87867f",
    cardBg: isDark ? "#1e1e1c" : "#ffffff",
    cardBorder: isDark ? "#333" : "#e8e6dc",
    terracotta: "#d97757",
    terracottaBg: isDark
      ? "rgba(217, 119, 87, 0.15)"
      : "rgba(217, 119, 87, 0.08)",
    surfaceBg: isDark ? "#141413" : "#f5f4ed",
    hotPath: isDark ? "rgba(237, 161, 0, 0.15)" : "rgba(237, 161, 0, 0.08)",
    hotPathBorder: "#eda100",
    treeLine: isDark ? "#444" : "#d4d2c8",
    selectedBg: isDark
      ? "rgba(217, 119, 87, 0.12)"
      : "rgba(217, 119, 87, 0.06)",
  };

  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleDataFlow = useCallback(() => {
    if (showDataFlow) {
      setShowDataFlow(false);
      setDataFlowStep(-1);
      if (dataFlowTimerRef.current) {
        clearInterval(dataFlowTimerRef.current);
        dataFlowTimerRef.current = null;
      }
      return;
    }

    setShowDataFlow(true);
    setDataFlowStep(0);
    // Expand all nodes to show the flow
    setExpandedIds(
      new Set(flattenTree(componentTree).map((n) => n.id))
    );

    let step = 0;
    dataFlowTimerRef.current = setInterval(() => {
      step++;
      if (step >= dataFlowSteps.length) {
        if (dataFlowTimerRef.current) {
          clearInterval(dataFlowTimerRef.current);
          dataFlowTimerRef.current = null;
        }
        return;
      }
      setDataFlowStep(step);
    }, 1200);
  }, [showDataFlow]);

  useEffect(() => {
    return () => {
      if (dataFlowTimerRef.current) clearInterval(dataFlowTimerRef.current);
    };
  }, []);

  const allNodes = flattenTree(componentTree);
  const selectedNode = selectedId
    ? allNodes.find((n) => n.id === selectedId)
    : null;

  function renderNode(node: ComponentNode, depth: number = 0) {
    const isExpanded = expandedIds.has(node.id);
    const hasChildren = node.children && node.children.length > 0;
    const isSelected = selectedId === node.id;
    const isDataFlowActive =
      showDataFlow &&
      dataFlowStep >= 0 &&
      dataFlowStep < dataFlowSteps.length &&
      dataFlowSteps[dataFlowStep].from === node.id;

    return (
      <div key={node.id}>
        <motion.div
          animate={{
            backgroundColor: isDataFlowActive
              ? colors.terracottaBg
              : isSelected
              ? colors.selectedBg
              : "transparent",
          }}
          transition={{ duration: 0.3 }}
          onClick={() => setSelectedId(isSelected ? null : node.id)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 10px",
            paddingLeft: depth * 24 + 10,
            borderRadius: 6,
            cursor: "pointer",
            position: "relative",
            borderLeft: isDataFlowActive
              ? `2px solid ${colors.terracotta}`
              : "2px solid transparent",
            transition: "border-color 0.3s",
          }}
        >
          {/* Tree lines */}
          {depth > 0 &&
            Array.from({ length: depth }).map((_, i) => (
              <div
                key={i}
                style={{
                  position: "absolute",
                  left: i * 24 + 20,
                  top: 0,
                  bottom: 0,
                  width: 1,
                  background: colors.treeLine,
                }}
              />
            ))}

          {/* Expand/collapse toggle */}
          {hasChildren ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                toggleExpanded(node.id);
              }}
              style={{
                width: 18,
                height: 18,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "transparent",
                border: "none",
                cursor: "pointer",
                color: colors.textSecondary,
                fontSize: 12,
                flexShrink: 0,
                padding: 0,
                fontFamily: "var(--font-mono)",
              }}
            >
              {isExpanded ? (
                <svg width="10" height="10" viewBox="0 0 10 10">
                  <path
                    d="M2 3.5 L5 6.5 L8 3.5"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    fill="none"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              ) : (
                <svg width="10" height="10" viewBox="0 0 10 10">
                  <path
                    d="M3.5 2 L6.5 5 L3.5 8"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    fill="none"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </button>
          ) : (
            <div style={{ width: 18, flexShrink: 0 }} />
          )}

          {/* Component name */}
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 13,
              fontWeight: isSelected ? 600 : 500,
              color: isDataFlowActive
                ? colors.terracotta
                : isSelected
                ? colors.terracotta
                : colors.text,
              transition: "color 0.2s",
            }}
          >
            {"<"}
            {node.name}
            {" />"}
          </span>

          {/* Hot path badge */}
          {node.isHotPath && (
            <span
              style={{
                padding: "1px 6px",
                fontFamily: "var(--font-mono)",
                fontSize: 9,
                fontWeight: 600,
                background: colors.hotPath,
                color: colors.hotPathBorder,
                borderRadius: 4,
                border: `1px solid ${colors.hotPathBorder}`,
                whiteSpace: "nowrap",
                textTransform: "uppercase",
                letterSpacing: "0.5px",
              }}
            >
              핫 패스
            </span>
          )}

          {/* Lines count */}
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              color: colors.textSecondary,
              marginLeft: "auto",
              whiteSpace: "nowrap",
            }}
          >
            {node.lines}
          </span>

          {/* Data flow arrow */}
          <AnimatePresence>
            {isDataFlowActive && (
              <motion.div
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 8 }}
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  color: colors.terracotta,
                  whiteSpace: "nowrap",
                  maxWidth: 200,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {dataFlowSteps[dataFlowStep].label}
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>

        {/* Children */}
        <AnimatePresence>
          {hasChildren && isExpanded && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.2 }}
              style={{ overflow: "hidden" }}
            >
              {node.children!.map((child) => renderNode(child, depth + 1))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  }

  return (
    <div className={className} style={{ fontFamily: "var(--font-serif)" }}>
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "16px 20px",
          background: colors.cardBg,
          border: `1px solid ${colors.cardBorder}`,
          borderRadius: "12px 12px 0 0",
          borderBottom: "none",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: colors.terracotta,
            }}
          />
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 14,
              color: colors.terracotta,
              fontWeight: 600,
            }}
          >
            REPL 구성 요소 계층 구조
          </span>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              padding: "2px 8px",
              background: colors.terracottaBg,
              color: colors.terracotta,
              borderRadius: 4,
              fontWeight: 700,
            }}
          >
            ~5,000줄
          </span>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={toggleDataFlow}
            style={{
              padding: "6px 12px",
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              fontWeight: 600,
              background: showDataFlow ? colors.terracotta : "transparent",
              color: showDataFlow ? "#fff" : colors.textSecondary,
              border: `1px solid ${
                showDataFlow ? colors.terracotta : colors.cardBorder
              }`,
              borderRadius: 6,
              cursor: "pointer",
              transition: "all 0.2s",
            }}
          >
            {showDataFlow ? "흐름 중지" : "데이터 흐름 표시"}
          </button>
          <button
            onClick={() =>
              setExpandedIds(
                expandedIds.size > 3
                  ? new Set(["repl"])
                  : new Set(flattenTree(componentTree).map((n) => n.id))
              )
            }
            style={{
              padding: "6px 12px",
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              background: "transparent",
              color: colors.textSecondary,
              border: `1px solid ${colors.cardBorder}`,
              borderRadius: 6,
              cursor: "pointer",
            }}
          >
            {expandedIds.size > 3 ? "접기" : "모두 확장"}
          </button>
        </div>
      </div>

      {/* Tree + Detail */}
      <div
        style={{
          display: "flex",
          gap: 0,
          borderRadius: "0 0 12px 12px",
          overflow: "hidden",
          border: `1px solid ${colors.cardBorder}`,
        }}
      >
        {/* Tree panel */}
        <div
          style={{
            flex: "1 1 auto",
            minWidth: 0,
            padding: "12px 8px",
            background: colors.cardBg,
            borderRight: selectedNode
              ? `1px solid ${colors.cardBorder}`
              : "none",
            maxHeight: 500,
            overflowY: "auto",
          }}
        >
          {renderNode(componentTree)}
        </div>

        {/* Detail panel */}
        <AnimatePresence>
          {selectedNode && (
            <motion.div
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 320, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              style={{
                flexShrink: 0,
                background: colors.cardBg,
                overflow: "hidden",
              }}
            >
              <div style={{ padding: "16px 20px", width: 320 }}>
                {/* Component name */}
                <div
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 15,
                    fontWeight: 600,
                    color: colors.terracotta,
                    marginBottom: 4,
                  }}
                >
                  {"<"}
                  {selectedNode.name}
                  {" />"}
                </div>
                <div
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                    color: colors.textSecondary,
                    marginBottom: 12,
                  }}
                >
                  {selectedNode.lines} 라인
                  {selectedNode.isHotPath && (
                    <span style={{ color: colors.hotPathBorder }}>
                      {" "}
                      -- 핫 패스
                    </span>
                  )}
                </div>

                {/* Description */}
                <p
                  style={{
                    fontSize: 12,
                    color: colors.text,
                    lineHeight: 1.6,
                    marginBottom: 16,
                  }}
                >
                  {selectedNode.description}
                </p>

                {/* Key Props */}
                <div
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 10,
                    color: colors.textSecondary,
                    textTransform: "uppercase",
                    letterSpacing: "0.5px",
                    marginBottom: 6,
                  }}
                >
                  주요 소품
                </div>
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 4,
                    marginBottom: 16,
                  }}
                >
                  {selectedNode.keyProps.map((prop) => (
                    <span
                      key={prop}
                      style={{
                        padding: "2px 8px",
                        fontFamily: "var(--font-mono)",
                        fontSize: 11,
                        background: colors.surfaceBg,
                        color: colors.text,
                        borderRadius: 4,
                        border: `1px solid ${colors.cardBorder}`,
                      }}
                    >
                      {prop}
                    </span>
                  ))}
                </div>

                {/* Re-render triggers */}
                <div
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 10,
                    color: colors.textSecondary,
                    textTransform: "uppercase",
                    letterSpacing: "0.5px",
                    marginBottom: 6,
                  }}
                >
                  재렌더링 트리거
                </div>
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 3,
                  }}
                >
                  {selectedNode.reRenderTriggers.map((trigger) => (
                    <div
                      key={trigger}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        fontSize: 11,
                        color: colors.textSecondary,
                      }}
                    >
                      <div
                        style={{
                          width: 4,
                          height: 4,
                          borderRadius: "50%",
                          background: selectedNode.isHotPath
                            ? colors.hotPathBorder
                            : colors.terracotta,
                          flexShrink: 0,
                        }}
                      />
                      {trigger}
                    </div>
                  ))}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Data flow legend */}
      <AnimatePresence>
        {showDataFlow && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            style={{
              marginTop: 12,
              padding: "12px 16px",
              background: colors.cardBg,
              border: `1px solid ${colors.cardBorder}`,
              borderRadius: 8,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                color: colors.textSecondary,
                marginBottom: 8,
              }}
            >
              메시지 흐름: 렌더링된 출력에 대한 사용자 입력
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {dataFlowSteps.map((step, index) => (
                <div
                  key={index}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <div
                    style={{
                      width: 20,
                      height: 20,
                      borderRadius: "50%",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontFamily: "var(--font-mono)",
                      fontSize: 10,
                      fontWeight: 700,
                      background:
                        dataFlowStep >= index
                          ? colors.terracotta
                          : "transparent",
                      color:
                        dataFlowStep >= index ? "#fff" : colors.textSecondary,
                      border: `1.5px solid ${
                        dataFlowStep >= index
                          ? colors.terracotta
                          : colors.cardBorder
                      }`,
                      transition: "all 0.3s",
                      flexShrink: 0,
                    }}
                  >
                    {index + 1}
                  </div>
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 10,
                      color:
                        dataFlowStep === index
                          ? colors.terracotta
                          : colors.textSecondary,
                      transition: "color 0.3s",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {step.label}
                  </span>
                  {index < dataFlowSteps.length - 1 && (
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 12 12"
                      style={{ flexShrink: 0 }}
                    >
                      <path
                        d="M3 6h6M7 4l2 2-2 2"
                        stroke={
                          dataFlowStep > index
                            ? colors.terracotta
                            : colors.textSecondary
                        }
                        strokeWidth="1.5"
                        fill="none"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        style={{ transition: "stroke 0.3s" }}
                      />
                    </svg>
                  )}
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
