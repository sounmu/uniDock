export function StatusChip({
  children,
  urgent = false,
  done = false,
}: {
  readonly children: string;
  readonly urgent?: boolean;
  readonly done?: boolean;
}) {
  const tone = urgent ? " urgent" : done ? " done" : "";
  return <span className={`status-chip${tone}`}>{children}</span>;
}
