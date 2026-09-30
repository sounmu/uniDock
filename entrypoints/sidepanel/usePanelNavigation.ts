import { useState } from "react";
import type { Course } from "../../src/domain";
import type { Section } from "./ui/Rail";
export type SidepanelView =
  | "COURSES_LIST"
  | "ASSIGNMENTS_LIST"
  | "UPCOMING_LIST"
  | "TODO_LIST"
  | "RECORDINGS_LIST"
  | "DOCUMENTS_LIST"
  | "CAPTIONS"
  | "PLAYBACK";
export function usePanelNavigation() {
  const [section, setSection] = useState<Section>("courses");
  const [tasksMode, setTasksMode] = useState<"todo" | "upcoming">("todo");
  const [courseTab, setCourseTab] = useState<
    "assignments" | "recordings" | "materials"
  >("assignments");
  const [selectedCourse, setCourse] = useState<Course | null>(null);
  const course = selectedCourse?.name ?? "";
  const view: SidepanelView =
    section === "playback"
      ? "PLAYBACK"
      : section === "captions"
        ? "CAPTIONS"
        : section === "tasks"
          ? tasksMode === "todo"
            ? "TODO_LIST"
            : "UPCOMING_LIST"
          : !selectedCourse
            ? "COURSES_LIST"
            : courseTab === "assignments"
              ? "ASSIGNMENTS_LIST"
              : courseTab === "recordings"
                ? "RECORDINGS_LIST"
                : "DOCUMENTS_LIST";
  function setView(next: SidepanelView) {
    switch (next) {
      case "COURSES_LIST":
        setSection("courses");
        setCourse(null);
        break;
      case "ASSIGNMENTS_LIST":
        setSection("courses");
        setCourseTab("assignments");
        break;
      case "RECORDINGS_LIST":
        setSection("courses");
        setCourseTab("recordings");
        break;
      case "DOCUMENTS_LIST":
        setSection("courses");
        setCourseTab("materials");
        break;
      case "TODO_LIST":
        setSection("tasks");
        setTasksMode("todo");
        break;
      case "UPCOMING_LIST":
        setSection("tasks");
        setTasksMode("upcoming");
        break;
      case "PLAYBACK":
        setSection("playback");
        break;
      case "CAPTIONS":
        setSection("captions");
        break;
      default: {
        const exhaustive: never = next;
        return exhaustive;
      }
    }
  }
  return {
    section,
    tasksMode,
    courseTab,
    course,
    selectedCourse,
    setCourse,
    view,
    setView,
  };
}
