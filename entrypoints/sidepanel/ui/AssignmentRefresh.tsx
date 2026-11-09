import { useEffect, useState } from "react";
import type { PanelModel } from "../screens/QueryResults";
import { Icon } from "./icons";
import { softDisabled } from "./a11y";

export type AssignmentFreshnessState = {
  readonly updatedAt?: number;
  readonly pending: boolean;
};

// Shared by every course tab (과제, 녹화 강의, 강의 자료): the `assignment-*`
// classes name the presentation the assignment list introduced first.
export function AssignmentRefresh({
  model,
  label = "과제",
}: {
  readonly model: PanelModel;
  readonly label?: string;
}) {
  const pending = model.state.status === "loading";
  return (
    <button
      className={`btn-secondary assignment-refresh${pending ? " is-loading" : ""}${model.state.status === "error" ? " is-error" : ""}`}
      aria-label={`${label} 새로고침`}
      title={`${label} 새로고침`}
      aria-busy={pending}
      {...softDisabled(pending || !model.isQueryValid ||
        (model.view === "DOCUMENTS_LIST" && model.downloads.progress.running), () => {
        void model.load(model.query, { refresh: true });
      })}
    >
      <Icon name="refresh" />
    </button>
  );
}

export function AssignmentFreshness({
  updatedAt,
  pending,
}: AssignmentFreshnessState) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (updatedAt === undefined) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, [updatedAt]);
  if (pending) return <p className="assignment-freshness" role="status">업데이트 중</p>;
  if (updatedAt === undefined) return null;
  const minutes = Math.max(0, Math.floor((now - updatedAt) / 60000));
  const label = minutes < 1
    ? "방금 업데이트"
    : minutes < 60
      ? `${minutes}분 전 업데이트`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}시간 전 업데이트`
        : `${Math.floor(minutes / 1440)}일 전 업데이트`;
  return (
    <p className="assignment-freshness" role="status">
      <time dateTime={new Date(updatedAt).toISOString()}
        title={new Date(updatedAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}>
        {label}
      </time>
    </p>
  );
}
