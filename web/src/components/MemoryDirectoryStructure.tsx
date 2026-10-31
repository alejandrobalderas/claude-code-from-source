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

interface FileEntry {
  name: string;
  isDir?: boolean;
  indent: number;
  annotation?: string;
  highlighted?: boolean;
}

const entries: FileEntry[] = [
  { name: "~/.claude/", isDir: true, indent: 0 },
  { name: "projects/", isDir: true, indent: 1 },
  { name: "<project-slug>/", isDir: true, indent: 2 },
  { name: "memory/", isDir: true, indent: 3 },
  {
    name: "MEMORY.md",
    indent: 4,
    annotation: "항상 로드됨, 인덱스 파일",
    highlighted: true,
  },
  {
    name: "user_role.md",
    indent: 4,
    annotation: "user_ 접두사 = 자동 분류됨",
  },
  {
    name: "feedback_testing.md",
    indent: 4,
    annotation: "피드백_ 접두사 = 수정 중심",
  },
  {
    name: "project_auth.md",
    indent: 4,
    annotation: "project_ 접두사 = 도메인 지식",
  },
  {
    name: "reference_docs.md",
    indent: 4,
    annotation: "참조_ 접두사 = 외부 링크",
  },
];

interface Props {
  className?: string;
}

export default function MemoryDirectoryStructure({ className }: Props) {
  const isDark = useDarkMode();

  const colors = {
    text: isDark ? "#f5f4ed" : "#141413",
    textSecondary: "#87867f",
    cardBg: isDark ? "#1e1e1c" : "#ffffff",
    cardBorder: isDark ? "#333" : "#e8e6dc",
    terracotta: "#d97757",
    surfaceBg: isDark ? "#141413" : "#f5f4ed",
    treeLine: isDark ? "#444" : "#d4d2ca",
    folderColor: "#f59e0b",
    fileColor: isDark ? "#c2c0b6" : "#87867f",
  };

  return (
    <div className={className} style={{ fontFamily: "var(--font-serif)" }}>
      <div
        style={{
          background: colors.cardBg,
          border: `1px solid ${colors.cardBorder}`,
          borderRadius: 12,
          padding: "20px 24px",
          overflow: "hidden",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
          {entries.map((entry, i) => {
            const isLast =
              i === entries.length - 1 ||
              (entries[i + 1] && entries[i + 1].indent <= entry.indent);

            return (
              <motion.div
                key={entry.name}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.25, delay: i * 0.06 }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  padding: "5px 0",
                  marginLeft: entry.indent * 24,
                  position: "relative",
                }}
              >
                {/* Tree lines */}
                {entry.indent > 0 && (
                  <div
                    style={{
                      position: "absolute",
                      left: -16,
                      top: 0,
                      bottom: isLast ? "50%" : 0,
                      width: 1,
                      background: colors.treeLine,
                    }}
                  />
                )}
                {entry.indent > 0 && (
                  <div
                    style={{
                      position: "absolute",
                      left: -16,
                      top: "50%",
                      width: 12,
                      height: 1,
                      background: colors.treeLine,
                    }}
                  />
                )}

                {/* Icon */}
                {entry.isDir ? (
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill={colors.folderColor}
                    style={{ marginRight: 8, flexShrink: 0 }}
                  >
                    <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
                  </svg>
                ) : (
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke={entry.highlighted ? colors.terracotta : colors.fileColor}
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{ marginRight: 8, flexShrink: 0 }}
                  >
                    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                  </svg>
                )}

                {/* Name */}
                <span
                  style={{
                    fontSize: 13,
                    fontFamily: "var(--font-mono)",
                    fontWeight: entry.highlighted ? 700 : entry.isDir ? 600 : 400,
                    color: entry.highlighted
                      ? colors.terracotta
                      : entry.isDir
                        ? colors.folderColor
                        : colors.text,
                  }}
                >
                  {entry.name}
                </span>

                {/* Annotation */}
                {entry.annotation && (
                  <span
                    style={{
                      marginLeft: 12,
                      fontSize: 11,
                      color: entry.highlighted
                        ? colors.terracotta
                        : colors.textSecondary,
                      fontStyle: "italic",
                      fontWeight: entry.highlighted ? 600 : 400,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {entry.highlighted ? `\u2190 ${entry.annotation}` : entry.annotation}
                  </span>
                )}
              </motion.div>
            );
          })}
        </div>
      </div>

      {/* Legend */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.5, duration: 0.3 }}
        style={{
          display: "flex",
          justifyContent: "center",
          gap: 20,
          marginTop: 12,
          fontSize: 11,
          color: colors.textSecondary,
          fontFamily: "var(--font-mono)",
          flexWrap: "wrap",
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: 2,
              background: colors.terracotta,
              display: "inline-block",
            }}
          />
          항상 로드됨(인덱스)
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: 2,
              background: colors.fileColor,
              display: "inline-block",
            }}
          />
          MEMORY.md 참조를 통해 요청 시 로드됨
        </span>
      </motion.div>
    </div>
  );
}
