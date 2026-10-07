import { describe, expect, it } from "vitest";
import { operationsPath, parseRoute, routeHref } from "./route.js";

const parse = (href: string) => {
  const url = new URL(href, "https://debug.example");
  return parseRoute(url.pathname, url.search);
};

describe("debug routes", () => {
  it("keeps capture links exact and makes the root an overview", () => {
    expect(parse("/")).toEqual({ view: "overview" });
    expect(parse("/issues")).toEqual({ view: "issues" });
    expect(parse("/issues/?view=captures")).toEqual({ view: "issues" });
    expect(parse("/s/e782a1c4-9d2f/conversation")).toEqual({
      view: "capture",
      id: "e782a1c4-9d2f",
      page: "conversation",
    });
    expect(parse("/s/%25bad")).toMatchObject({ id: "%bad", page: "evidence" });
    expect(parse("/s/%E0%A4%A")).toMatchObject({ id: "invalid-capture-id" });
    for (const href of [
      "/issues",
      "/s/e782a1c4-9d2f",
      "/s/e782a1c4-9d2f/conversation",
      "/?view=captures&q=delivery+receipt&offset=50",
    ])
      expect(routeHref(parse(href))).toBe(href);
  });

  it("restores scoped operation filters from direct links and preserves legacy selections", () => {
    expect(parse("/operations?id=recovery%3Aold")).toEqual({
      view: "operations",
      scope: "operations",
      id: "recovery:old",
      query: "",
      source: "",
      failureKey: "",
      offset: 0,
    });
    const errors = parse(
      "/operations?view=errors&q=health&source=recovery&signature=recovery%3Areadiness%3Ahealth_failed&offset=50&id=recovery%3Acurrent",
    );
    expect(errors).toMatchObject({
      scope: "errors",
      source: "recovery",
      failureKey: "recovery:readiness:health_failed",
      offset: 50,
      id: "recovery:current",
    });
    expect(routeHref(errors)).toBe(
      "/operations?view=errors&q=health&source=recovery&signature=recovery%3Areadiness%3Ahealth_failed&offset=50&id=recovery%3Acurrent",
    );
    // A source outside the workspace, or a malformed offset, is not trusted.
    expect(
      parse("/operations?view=amp&source=deployment&offset=-5"),
    ).toMatchObject({ scope: "amp", source: "", offset: 0 });
    expect(parse("/operations?view=unknown")).toMatchObject({
      scope: "operations",
    });
  });

  it("asks the server to filter workspaces before pagination", () => {
    const base = { query: "", source: "", failureKey: "", offset: 0 } as const;
    expect(operationsPath({ ...base, scope: "deployments" }, 8)).toBe(
      "/api/operations?q=&sources=deployment%2Crecovery&offset=0&limit=8",
    );
    expect(operationsPath({ ...base, scope: "errors", offset: 50 })).toBe(
      "/api/operations?q=&failuresOnly=true&offset=50&limit=50",
    );
    expect(
      operationsPath({ ...base, scope: "amp", source: "coding", query: "x" }),
    ).toBe("/api/operations?q=x&source=coding&offset=0&limit=50");
    expect(operationsPath({ ...base, scope: "operations" })).toBe(
      "/api/operations?q=&offset=0&limit=50",
    );
  });
});
