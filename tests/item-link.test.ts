import { expect, it } from "vitest";
import { projectCourseTodo, projectUpcoming } from "../src/domain-items";
import { parseResult } from "../src/protocol";
import { itemUrl } from "../src/security/item-link";

it("preserves planner and todo post links through response validation", () => {
  const path = "/courses/12/assignments/34";
  const upcoming = projectUpcoming(
    [{ html_url: path, plannable: { title: "일정" } }],
    "https://canvas.korea.ac.kr",
  );
  const todo = projectCourseTodo(
    [{ name: "할 일", html_url: `https://mylms.korea.ac.kr${path}` }],
    "과목",
    "https://mylms.korea.ac.kr",
  );
  expect(upcoming[0]?.html_url).toBe(`https://canvas.korea.ac.kr${path}`);
  expect(todo[0]?.html_url).toBe(`https://mylms.korea.ac.kr${path}`);
  for (const result of [
    { status: "success", upcoming },
    { status: "success", todo },
  ])
    expect(parseResult(result)).toEqual(result);
});

it("omits the other LMS origin when a projection binds its source origin", () => {
  const path = "/courses/12/assignments/34";
  const mylms = "https://mylms.korea.ac.kr";
  const canvas = "https://canvas.korea.ac.kr";
  const upcoming = projectUpcoming(
    [{ html_url: `${mylms}${path}`, plannable: { title: "일정" } }],
    canvas,
  );
  const todo = projectCourseTodo(
    [{ name: "할 일", html_url: `${canvas}${path}` }],
    "과목",
    mylms,
  );
  expect(upcoming[0]).not.toHaveProperty("html_url");
  expect(todo[0]).not.toHaveProperty("html_url");
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
  expect(projectCourseTodo([{}], "과목")[0]).not.toHaveProperty("html_url");
});
