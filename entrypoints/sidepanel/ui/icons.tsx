export type IconName =
  "courses" | "tasks" | "playback" | "captions" | "external";
const paths: Record<IconName, string> = {
  courses:
    "M4 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-2H4z M20 4h-4a3 3 0 0 0-3 3m0 14a4 4 0 0 1 4-2h3V4",
  tasks: "m3 6 2 2 4-4 M12 6h9 M3 13h3m6 0h9 M3 20h3m6 0h9",
  playback: "m9 6 10 6-10 6z M4 5v14",
  captions: "M4 4h16v14H9l-5 3z M7 8h10 M7 12h7",
  external: "M14 3h7v7m0-7L10 14 M10 4H4v16h16v-6",
};
export function Icon({ name }: { readonly name: IconName }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
