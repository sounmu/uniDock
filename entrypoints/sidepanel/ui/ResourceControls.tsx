import { useId } from "react";
import type { AssignmentFreshnessState } from "./AssignmentRefresh";
import { ViewControls } from "./ViewControls";
import { Select } from "./Select";

export type ResourceSource = "all" | "module" | "board";
export type ResourceFilters = {
  readonly source: ResourceSource;
  /** `null` keeps every module. */
  readonly module: string | null;
};
export const defaultResourceFilters: ResourceFilters = { source: "all", module: null };
type Resource = {
  readonly module: string;
  readonly source?: "module" | "board";
};
const sources: readonly { value: ResourceSource; label: string }[] = [
  { value: "all", label: "전체" },
  { value: "module", label: "주차학습" },
  { value: "board", label: "게시판" },
];
const kinds = {
  recordings: {
    label: "녹화 강의",
    noun: "강의",
    question: "어떤 강의를 볼까요?",
    help: "강의 열기 안내",
    text: "주차학습 외부 도구와 LearningX 게시판의 KU 플레이어 영상을 보여줘요. 게시판 영상은 LMS에서 게시판을 연 뒤 약 4시간 동안 보여요. 열린 탭에서 직접 재생하세요. LMS 재생으로 시청·출석 기록이 반영될 수 있어요.",
  },
  materials: {
    label: "강의 자료",
    noun: "자료",
    question: "어떤 자료를 볼까요?",
    help: "자료 다운로드 안내",
    text: "주차학습 모듈과 게시판·공지에 첨부된 강의 자료를 보여줘요. LearningX 게시판(과목 메뉴의 Board) 자료는 LMS에서 게시판을 연 뒤 약 4시간 동안 함께 보여요. 선택한 자료는 브라우저 다운로드 폴더에 저장해요. 확장은 파일 내용을 읽거나 업로드하지 않아요.",
  },
} as const;
export type ResourceKind = keyof typeof kinds;

export function filterResources<T extends Resource>(
  items: readonly T[],
  filters: ResourceFilters,
): T[] {
  return items.filter(
    (item) =>
      (filters.source === "all" || item.source === filters.source) &&
      (filters.module === null || item.module === filters.module),
  );
}
export function resourceModules(
  items: readonly Resource[],
  source: ResourceSource,
): string[] {
  const modules: string[] = [];
  for (const item of filterResources(items, { source, module: null }))
    if (!modules.includes(item.module)) modules.push(item.module);
  return modules;
}
// A refreshed list may no longer contain the applied module; the view then
// falls back to every module instead of an unexplained empty list.
export function resolveResourceFilters(
  items: readonly Resource[],
  filters: ResourceFilters,
): ResourceFilters {
  return filters.module !== null &&
    !items.some((item) => item.module === filters.module)
    ? { ...filters, module: null }
    : filters;
}
function moduleLabel(module: string): string {
  return module || "모듈 이름 없음";
}

export function ResourceControls({
  kind, items, filters, onApply, freshness,
}: {
  readonly kind: ResourceKind;
  readonly items: readonly Resource[];
  readonly filters: ResourceFilters;
  readonly onApply: (filters: ResourceFilters) => void;
  readonly freshness?: AssignmentFreshnessState;
}) {
  const id = useId();
  const copy = kinds[kind];
  const summary = [
    ...(filters.source !== "all"
      ? [sources.find((option) => option.value === filters.source)?.label]
      : []),
    ...(filters.module !== null ? [moduleLabel(filters.module)] : []),
  ].join(" · ");
  return (
    <ViewControls
      heading={`${copy.label} ${filterResources(items, filters).length.toLocaleString()}개`}
      dialogLabel={`${copy.label} 보기 변경`}
      question={copy.question}
      noun={copy.noun}
      filters={filters}
      defaults={defaultResourceFilters}
      preview={(draft) => filterResources(items, draft).length}
      fields={(draft, setDraft) => {
        const modules = resourceModules(items, draft.source);
        const selected = draft.module === null ? -1 : modules.indexOf(draft.module);
        return (
          <>
            {kind === "recordings" && (
              <div className="subviews assignment-scope resource-scope" role="group" aria-label="강의 출처">
                {sources.map((option) => (
                  <button key={option.value} className="btn-ghost" aria-pressed={draft.source === option.value}
                    onClick={() => setDraft({ source: option.value, module: null })}>{option.label}</button>
                ))}
              </div>
            )}
            <div className="assignment-view-fields resource-view-fields">
              <div className="field">
                <label htmlFor={`${id}-module`}>모듈</label>
                <Select id={`${id}-module`} value={selected < 0 ? "" : String(selected)}
                  onChange={(event) => {
                    const module = event.target.value === "" ? null : modules[Number(event.target.value)];
                    setDraft({ ...draft, module: module ?? null });
                  }}>
                  <option value="">전체 모듈</option>
                  {modules.map((module, index) => (
                    <option key={index} value={String(index)}>{moduleLabel(module)}</option>
                  ))}
                </Select>
              </div>
            </div>
          </>
        );
      }}
      help={
        <details className="assignment-criteria">
          <summary>{copy.help}</summary>
          <p>{copy.text}</p>
        </details>
      }
      onApply={onApply}
      freshness={freshness}
      summary={summary || undefined}
    />
  );
}
