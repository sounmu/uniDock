export const demoOrigin = "https://mylms.korea.ac.kr";
export const courses = [
  { id: 91001, name: "컴퓨터과학 입문" },
  { id: 91002, name: "데이터 분석 기초" },
  { id: 91003, name: "디지털 사회와 윤리" },
];
const date = (days) => new Date(Date.now() + days * 86400000).toISOString();
export const demoResponses = new Map([["/api/v1/courses", courses]]);
for (const course of courses) {
  const assignments = [
    "2주차 실습 보고서",
    "중간 프로젝트 계획서",
    "1주차 복습 퀴즈",
  ].map((name, index) => ({
    id: 92001 + index,
    name,
    due_at: date(index === 2 ? -2 : index + 2),
    points_possible: 20,
    published: true,
    locked_for_user: false,
    submission_types: ["online_upload"],
    submission: {
      workflow_state: index === 2 ? "submitted" : "unsubmitted",
      submitted_at: index === 2 ? date(-3) : null,
      missing: false,
      late: false,
    },
  }));
  demoResponses.set(`/api/v1/courses/${course.id}/assignments`, assignments);
  demoResponses.set(`/api/v1/courses/${course.id}/modules`, [
    {
      id: 93001,
      name: "2주차 · 개념과 실습",
      items_count: 2,
      items: [1, 2].map((lesson) => ({
        id: 94000 + lesson,
        title: `2주차 ${lesson}차시 · ${lesson === 1 ? "핵심 개념 알아보기" : "예제로 이해하기"}`,
        type: "ExternalTool",
        html_url: `${demoOrigin}/courses/${course.id}/modules/items/${94000 + lesson}`,
      })),
    },
  ]);
}
demoResponses.set(
  "/api/v1/users/self/todo",
  courses.map((course) => ({
    type: "submitting",
    context_name: course.name,
    assignment: { name: "2주차 실습 보고서", due_at: date(2) },
  })),
);
demoResponses.set(
  "/api/v1/planner/items",
  courses.map((course) => ({
    context_name: course.name,
    plannable_type: "assignment",
    plannable_date: date(2),
    plannable: { title: "2주차 실습 보고서" },
    submissions: { submitted: false },
  })),
);
