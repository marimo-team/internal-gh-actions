import assert from "node:assert/strict";
import { test } from "node:test";
import { nextVersion } from "../lib/prepare.mjs";

test("stable versions increase, with numeric rather than lexical ordering", () => {
  for (
    const [before, request, after] of [
      ["1.2.9", "patch", "1.2.10"],
      ["1.2.9", "minor", "1.3.0"],
      ["1.2.9", "major", "2.0.0"],
      ["1.9.0", "1.10.0", "1.10.0"],
      ["999999999999999999.0.0", "major", "1000000000000000000.0.0"],
    ]
  ) assert.equal(nextVersion(before, request), after);
});
test("rejects equal, lower, prerelease and malformed versions", () => {
  for (
    const request of [
      "1.2.3",
      "1.2.2",
      "0.9.9",
      "1.2.4-rc.1",
      "1.2.4+build",
      "01.2.4",
      "1.2.4\n",
      "v1.2.4",
      "$(echo unsafe)",
      undefined,
    ]
  ) {
    assert.throws(() => nextVersion("1.2.3", request));
  }
  assert.throws(() => nextVersion("1.2.3-rc.1", "patch"));
});
