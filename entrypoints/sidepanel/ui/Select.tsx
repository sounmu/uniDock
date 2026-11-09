import type { ComponentProps } from "react";

export function Select(props: ComponentProps<"select">) {
  return (
    <span className="select-field">
      <select {...props} />
    </span>
  );
}
