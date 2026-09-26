import { afterEach, expect, it, vi } from "vitest";
import {
  CHATGPT_URL,
  copyPromptAndOpen,
  questionPrompt,
} from "../src/pdf/handoff";
afterEach(() => vi.unstubAllGlobals());
it.each([true, false])(
  "opens only the fixed start page when clipboard success is %s",
  async (success) => {
    // Given
    const writeText = success
      ? vi.fn().mockResolvedValue(undefined)
      : vi.fn().mockRejectedValue(new Error("denied"));
    const create = vi.fn().mockResolvedValue({});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.stubGlobal("chrome", { tabs: { create } });
    // When
    const copied = await copyPromptAndOpen("Course");
    // Then: shipped clipboard payload equals its builder, with no URL query carrying data.
    expect(writeText).toHaveBeenCalledExactlyOnceWith(questionPrompt("Course"));
    expect(create).toHaveBeenCalledExactlyOnceWith({ url: CHATGPT_URL });
    expect(copied).toBe(success);
  },
);
