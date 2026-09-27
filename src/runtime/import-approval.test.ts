import { expect, it } from "vitest";
import { proposeImportApproval } from "./import-approval.js";

it("never proposes an approval for a partial review, widened audience or stale coverage", () => {
  const coverage = {
    platform: "slack",
    account: "T1",
    conversations: ["C1/1234567890.123456", "C2"],
    from: 1000,
    to: 5000,
    audiences: ['["private","owner"]'],
  };
  const progress = {
    id: "slack",
    coverage,
    pages: 0,
    complete: false,
    notBefore: 0,
    cursor: null,
    gaps: [],
    sourceIds: [],
    trackedPages: 0,
  };
  const review = (scope = coverage, status = { running: false, progress }) =>
    proposeImportApproval("slack", scope, "a".repeat(64), status);
  expect(review()).toContain('"conversations":["C1/1234567890.123456","C2"]');
  for (const status of [
    { running: true, progress },
    { running: false, progress: { ...progress, complete: true } },
  ])
    expect(review(coverage, status)).not.toContain('"confirmation"');
  const continued = review(coverage, {
    running: false,
    progress: { ...progress, pages: 7 },
  });
  expect(JSON.parse(continued.split("\n")[1] ?? "")).toMatchObject({
    digest: "a".repeat(64),
    expectedPages: 7,
    maxPages: 1,
    confirmation: {
      body: { confirmed: true, digest: "a".repeat(64), expectedPages: 7 },
    },
  });
  expect(() => review({ ...coverage, to: 5001 })).toThrow(
    "Import coverage changed",
  );
  for (const scope of [
    { ...coverage, audiences: [...coverage.audiences, "public"] },
    {
      ...coverage,
      conversations: Array.from({ length: 100 }, (_, i) =>
        `C${i}/1234567890.123456`.padStart(40, "0"),
      ),
    },
  ])
    expect(
      proposeImportApproval("slack", scope, "a".repeat(64), {
        running: false,
        progress: undefined,
      }),
    ).not.toContain('"confirmation"');
});
