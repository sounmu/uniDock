import { expect, it } from "vitest";
import { allowedCaptionMediaUrl } from "../src/security/policy";

const good =
  "https://korea-cms-object.cdn.gov-ntruss.com/contents7/kruniv1001/0123456789abc/contents/media_files/screen.mp4";

it("accepts the one KU media shape", () => {
  expect(allowedCaptionMediaUrl(good)).toBe(true);
});

it("rejects other hosts, schemes, queries and paths", () => {
  for (const value of [
    good.replace("https", "http"),
    good.replace("korea-cms-object.cdn.gov-ntruss.com", "evil.example.com"),
    good.replace("gov-ntruss.com", "gov-ntruss.com:8443"),
    good.replace("gov-ntruss.com", "gov-ntruss.com.evil.example"),
    good.replace("korea-cms-object", "xkorea-cms-object"),
    good.replace("https://", "https://user@"),
    good + "?token=x",
    good.replace("/media_files/screen.mp4", "/media_files/screen.mkv"),
    good.replace("0123456789abc", "0123"),
    "https://korea-cms-object.cdn.gov-ntruss.com/other/path.mp4",
    "not a url",
    123,
    null,
  ])
    expect(allowedCaptionMediaUrl(value as unknown)).toBe(false);
});
