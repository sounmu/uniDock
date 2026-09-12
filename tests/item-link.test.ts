import { expect, it } from "vitest";
import { projectUpcoming, projectTodo } from "../src/domain-items";
import { parseResult } from "../src/protocol";
import { itemUrl } from "../src/security/item-link";

it("preserves planner and todo post links through response validation", () => {
  const path = "/courses/12/assignments/34";
  const upcoming = projectUpcoming(
    [{ html_url: path, plannable: { title: "일정" } }],
    "https://canvas.korea.ac.kr",
  );
  const todo = projectTodo([
    {
      assignment: {
        name: "할 일",
        html_url: `https://mylms.korea.ac.kr${path}`,
      },
    },
  ]);
  expect(upcoming[0]?.html_url).toBe(`https://canvas.korea.ac.kr${path}`);
  expect(todo[0]?.html_url).toBe(`https://mylms.korea.ac.kr${path}`);
  for (const result of [
    { status: "success", upcoming },
    { status: "success", todo },
  ])
    expect(parseResult(result)).toEqual(result);
});

it("omits missing or non-LMS post links", () => {
  for (const value of [
    undefined,
    "javascript:alert(1)",
    "https://evil.example/courses/1/assignments/2",
    "https://mylms.korea.ac.kr/api/v1/users/self",
    "https://user:pass@mylms.korea.ac.kr/courses/1/assignments/2",
  ])
    expect(itemUrl(value)).toBeUndefined();
  expect(projectTodo([{}])[0]).not.toHaveProperty("html_url");
});
