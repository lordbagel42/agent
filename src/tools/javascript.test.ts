import { expect, it, vi } from "vitest";
import { runJavaScript } from "./javascript.js";

const run = (source: string, inputJson = "null") =>
  runJavaScript({ source, inputJson }, new AbortController().signal);

it("runs isolated async JavaScript with input, console output and a return value", async () => {
  expect(
    await run(
      'console.log("items", input.length); return await Promise.resolve(input.map(x => x * 3));',
      "[2,7]",
    ),
  ).toEqual({
    status: "ok",
    logs: ["items 2"],
    result: "[6,21]",
  });
  expect(
    await run(
      "return [typeof process, typeof require, typeof fetch, typeof workflow, typeof __call];",
    ),
  ).toMatchObject({
    result: '["undefined","undefined","undefined","undefined","undefined"]',
  });
  await run("globalThis.secret = 123; return 0;");
  expect(await run("return typeof secret;")).toMatchObject({
    result: '"undefined"',
  });
});

it("bounds runaway computation and output, reports errors and recovers", async () => {
  expect(await run("while (true) {};")).toMatchObject({ status: "error" });
  expect(await run('console.log("x".repeat(20000)); return 1;')).toMatchObject({
    status: "error",
    error: expect.stringContaining("output limit"),
  });
  expect(await run('throw new TypeError("bad input");')).toMatchObject({
    status: "error",
    error: expect.stringContaining("bad input"),
  });
  expect(await run("throw {message: {toString: 1}};")).toMatchObject({
    status: "error",
    error: expect.any(String),
  });
  expect(await run("return await new Promise(() => {});")).toMatchObject({
    status: "error",
    error: expect.stringContaining("unsettled"),
  });
  expect(await run("return 9 - 2;")).toMatchObject({
    status: "ok",
    result: "7",
  });
}, 10000);

it("does not intern guest symbols or traverse thrown promises in the host", async () => {
  const symbols = vi.spyOn(Symbol, "for");
  try {
    expect(
      await run('throw Symbol.for("guest-sandbox-symbol-probe");'),
    ).toMatchObject({ status: "error" });
    expect(symbols).not.toHaveBeenCalledWith("guest-sandbox-symbol-probe");
  } finally {
    symbols.mockRestore();
  }
  for (const source of [
    "throw Promise.resolve(1);",
    "let reject; const p = new Promise((_, r) => { reject = r; }); reject(p); throw p;",
    "throw {get message(){while(true){}}};",
  ]) {
    expect(await run(source)).toMatchObject({
      status: "error",
      error: expect.any(String),
    });
    expect(await run("return 5;")).toMatchObject({ status: "ok", result: "5" });
  }
}, 10000);
