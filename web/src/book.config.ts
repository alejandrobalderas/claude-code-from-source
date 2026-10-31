export interface PartConfig {
  number: number;
  title: string;
  epigraph: string;
  chapters: number[];
}

export interface ChapterConfig {
  number: number;
  slug: string;
  title: string;
  description: string;
}

export const parts: PartConfig[] = [
  {
    number: 1,
    title: "기초",
    epigraph: "에이전트가 생각하려면 먼저 프로세스가 실행되어야 한다.",
    chapters: [1, 2, 3, 4],
  },
  {
    number: 2,
    title: "핵심 루프",
    epigraph: "에이전트의 심장 박동: 스트리밍하고, 행동하고, 관찰하고, 반복한다.",
    chapters: [5, 6, 7],
  },
  {
    number: 3,
    title: "다중 에이전트 오케스트레이션",
    epigraph: "에이전트 하나도 강력하다. 여러 에이전트가 협력하면 가능성이 크게 달라진다.",
    chapters: [8, 9, 10],
  },
  {
    number: 4,
    title: "지속성과 지능",
    epigraph: "기억이 없는 에이전트는 같은 실수를 끝없이 반복한다.",
    chapters: [11, 12],
  },
  {
    number: 5,
    title: "인터페이스",
    epigraph: "사용자가 보는 모든 것은 이 계층을 거친다.",
    chapters: [13, 14],
  },
  {
    number: 6,
    title: "연결성",
    epigraph: "에이전트가 localhost 밖으로 나아간다.",
    chapters: [15, 16],
  },
  {
    number: 7,
    title: "성능 엔지니어링",
    epigraph: "사람이 내부 처리 과정을 의식하지 않을 만큼 모든 것을 빠르게 만든다.",
    chapters: [17, 18],
  },
];

export const chapters: ChapterConfig[] = [
  { number: 1, slug: 'ch01-architecture', title: "AI 에이전트의 아키텍처", description: "핵심 추상화 6가지, 데이터 흐름, 권한 시스템, 빌드 시스템" },
  { number: 2, slug: 'ch02-bootstrap', title: "빠른 시작 — 부트스트랩 파이프라인", description: "5단계 초기화, 모듈 수준 I/O 병렬 처리, 신뢰 경계" },
  { number: 3, slug: 'ch03-state', title: "상태 — 2계층 아키텍처", description: "부트스트랩 싱글턴, AppState 저장소, 고정 래치, 비용 추적" },
  { number: 4, slug: 'ch04-api-layer', title: "Claude와 대화하기 — API 계층", description: "여러 제공자를 지원하는 클라이언트, 프롬프트 캐시, 스트리밍, 오류 복구" },
  { number: 5, slug: 'ch05-agent-loop', title: "에이전트 루프", description: "query.ts 심층 분석, 4계층 압축, 오류 복구, 토큰 예산" },
  { number: 6, slug: 'ch06-tools', title: "도구 — 정의부터 실행까지", description: "도구 인터페이스, 14단계 파이프라인, 권한 시스템" },
  { number: 7, slug: 'ch07-concurrency', title: "도구 동시 실행", description: "분할 알고리즘, 스트리밍 실행기, 추측 실행" },
  { number: 8, slug: 'ch08-sub-agents', title: "하위 에이전트 생성", description: "AgentTool, 15단계 runAgent 수명 주기, 내장 에이전트 유형" },
  { number: 9, slug: 'ch09-fork-agents', title: "포크 에이전트와 프롬프트 캐시", description: "바이트 단위로 동일한 접두부를 만드는 기법, 캐시 공유, 비용 최적화" },
  { number: 10, slug: 'ch10-coordination', title: "작업, 조정, 에이전트 군집", description: "작업 상태 머신, 조정자 모드, 에이전트 군집의 메시지 교환" },
  { number: 11, slug: 'ch11-memory', title: "메모리 — 대화를 넘어 이어지는 학습", description: "파일 기반 메모리, 4가지 유형 분류, LLM 기반 기억 검색, 정보의 노후화" },
  { number: 12, slug: 'ch12-extensibility', title: "확장성 — 스킬과 훅", description: "2단계 스킬 로딩, 수명 주기 훅, 스냅샷 기반 보안" },
  { number: 13, slug: 'ch13-terminal-ui', title: "터미널 UI", description: "자체 수정한 Ink 포크, 렌더링 파이프라인, 이중 버퍼, 풀" },
  { number: 14, slug: 'ch14-input-interaction', title: "입력과 상호작용", description: "키 입력 해석, 키 바인딩, 연속 키 조합 지원, Vim 모드" },
  { number: 15, slug: 'ch15-mcp', title: "MCP — 범용 도구 프로토콜", description: "8가지 전송 방식, MCP용 OAuth, 도구 래핑" },
  { number: 16, slug: 'ch16-remote', title: "원격 제어와 클라우드 실행", description: "Bridge v1/v2, CCR, 업스트림 프록시" },
  { number: 17, slug: 'ch17-performance', title: "성능 — 밀리초 하나, 토큰 하나까지", description: "시작 속도, 컨텍스트 창, 프롬프트 캐시, 렌더링, 검색" },
  { number: 18, slug: 'ch18-epilogue', title: "에필로그 — 우리가 배운 것", description: "5가지 핵심 아키텍처 선택, 다른 시스템에 적용할 수 있는 요소, 에이전트의 미래 방향" },
];

export function getPartForChapter(chapterNumber: number): PartConfig | undefined {
  return parts.find(p => p.chapters.includes(chapterNumber));
}

export function getChapterNumber(slug: string): number {
  const match = slug.match(/^ch(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

export function getAdjacentChapters(chapterNumber: number) {
  const idx = chapters.findIndex(c => c.number === chapterNumber);
  return {
    prev: idx > 0 ? chapters[idx - 1] : null,
    next: idx < chapters.length - 1 ? chapters[idx + 1] : null,
  };
}

export function isFirstChapterOfPart(chapterNumber: number): boolean {
  return parts.some(p => p.chapters[0] === chapterNumber);
}
