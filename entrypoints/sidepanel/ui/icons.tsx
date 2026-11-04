export type IconName =
  | "courses"
  | "tasks"
  | "playback"
  | "captions"
  | "external"
  | "settings"
  | "status-open"
  | "status-done"
  | "status-overdue"
  | "status-locked";
const paths: Record<IconName, string> = {
  courses:
    "M4 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-2H4z M20 4h-4a3 3 0 0 0-3 3m0 14a4 4 0 0 1 4-2h3V4",
  tasks: "m3 6 2 2 4-4 M12 6h9 M3 13h3m6 0h9 M3 20h3m6 0h9",
  playback: "m9 6 10 6-10 6z M4 5v14",
  captions: "M4 4h16v14H9l-5 3z M7 8h10 M7 12h7",
  external: "M14 3h7v7m0-7L10 14 M10 4H4v16h16v-6",
  settings:
    "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M12 3v2.5 M12 18.5V21 M3 12h2.5 M18.5 12H21 M5.6 5.6l1.8 1.8 M16.6 16.6l1.8 1.8 M5.6 18.4l1.8-1.8 M16.6 7.4l1.8-1.8",
  "status-open": "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z M12 8v4.2l2.6 1.6",
  "status-done": "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z M8.5 12.3l2.4 2.4 4.6-5",
  "status-overdue":
    "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z M12 8v4.5 M12 15.8v.01",
  "status-locked": "M7 11h10v8H7z M9 11V8.5a3 3 0 0 1 6 0V11",
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
