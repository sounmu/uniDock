export function StatusChip({
  children,
  urgent = false,
}: {
  readonly children: string;
  readonly urgent?: boolean;
}) {
  return (
    <span className={`status-chip${urgent ? " urgent" : ""}`}>{children}</span>
  );
}
