import { expect, it } from "vitest";
import { readJsonBounded } from "../src/api/body";

it("rejects declared and streamed oversized API responses", async () => {
  await expect(
    readJsonBounded(
      new Response("[]", { headers: { "content-length": "500" } }),
      10,
    ),
  ).rejects.toThrow("LIMIT");
  await expect(
    readJsonBounded(new Response(" ".repeat(100)), 10),
  ).rejects.toThrow("LIMIT");
  expect(await readJsonBounded(new Response('[{"name":"과목"}]'))).toEqual([
    { name: "과목" },
  ]);
});
