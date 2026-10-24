import { expect, it } from "vitest";
import {
  canTransition,
  isTerminal,
  serverPhase,
} from "../src/captions/job-state";

it("allows only forward transitions", () => {
  expect(canTransition("idle", "identifying")).toBe(true);
  expect(canTransition("queued", "running")).toBe(true);
  expect(canTransition("queued", "succeeded")).toBe(true);
  expect(canTransition("running", "idle")).toBe(false);
  expect(canTransition("succeeded", "running")).toBe(false);
});

it("marks only end states terminal", () => {
  expect(isTerminal("succeeded")).toBe(true);
  expect(isTerminal("failed")).toBe(true);
  expect(isTerminal("cancelled")).toBe(true);
  expect(isTerminal("running")).toBe(false);
  expect(isTerminal("idle")).toBe(false);
});

it("maps server states and rejects unknown ones", () => {
  expect(serverPhase("awaiting_upload")).toBe("uploading");
  expect(serverPhase("queued")).toBe("queued");
  expect(serverPhase("succeeded")).toBe("succeeded");
  expect(serverPhase("bogus")).toBeNull();
});
