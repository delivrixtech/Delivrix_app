import assert from "node:assert/strict";
import test from "node:test";
import { stableStringify } from "./stable-stringify.ts";

test("stableStringify preserves canonical episodic scratch bytes", () => {
  const cases: Array<{ value: unknown; expected: string }> = [
    { value: undefined, expected: "undefined" },
    { value: null, expected: "null" },
    {
      value: { b: 2, a: { d: 4, c: 3 } },
      expected: "{\"a\":{\"c\":3,\"d\":4},\"b\":2}"
    },
    {
      value: [1, undefined, { b: 2, a: "x" }],
      expected: "[1,undefined,{\"a\":\"x\",\"b\":2}]"
    },
    {
      value: new Date("2026-06-03T12:00:00.000Z"),
      expected: "{}"
    },
    {
      value: { "quote\"key": "value \"x\"", plain: "\u00f1and\u00fa" },
      expected: "{\"plain\":\"\u00f1and\u00fa\",\"quote\\\"key\":\"value \\\"x\\\"\"}"
    },
    {
      value: { "\u00e9": 1, a: 2, "\u00f1": 3 },
      expected: "{\"a\":2,\"\u00e9\":1,\"\u00f1\":3}"
    },
    {
      value: { nan: NaN, inf: Infinity, neg: -Infinity },
      expected: "{\"inf\":null,\"nan\":null,\"neg\":null}"
    },
    {
      value: { z: undefined, a: null },
      expected: "{\"a\":null,\"z\":undefined}"
    }
  ];

  for (const item of cases) {
    assert.equal(stableStringify(item.value), item.expected);
  }
});
