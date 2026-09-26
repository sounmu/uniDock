import type { ReactNode } from "react";
export function Notice({
  children,
  error = false,
}: {
  readonly children: ReactNode;
  readonly error?: boolean;
}) {
  return (
    <div
      className={`notice${error ? " error" : ""}`}
      role={error ? "alert" : "status"}
    >
      {children}
    </div>
  );
}
