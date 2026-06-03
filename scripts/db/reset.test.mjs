import assert from "node:assert/strict";
import test from "node:test";
import { assertResetAllowed } from "./reset.mjs";

test("assertResetAllowed refuses production even with explicit confirmation", async () => {
  await assert.rejects(
    () => assertResetAllowed({
      env: {
        NODE_ENV: "production",
        DELIVRIX_CONFIRM_RESET: "1"
      },
      stdin: { isTTY: false }
    }),
    /NODE_ENV=production/
  );
});

test("assertResetAllowed accepts explicit non-production confirmation", async () => {
  await assert.doesNotReject(() => assertResetAllowed({
    env: {
      NODE_ENV: "development",
      DELIVRIX_CONFIRM_RESET: "1"
    },
    stdin: { isTTY: false }
  }));
});

test("assertResetAllowed refuses non-interactive resets without env confirmation", async () => {
  await assert.rejects(
    () => assertResetAllowed({
      env: {
        NODE_ENV: "development"
      },
      stdin: { isTTY: false }
    }),
    /DELIVRIX_CONFIRM_RESET=1/
  );
});
