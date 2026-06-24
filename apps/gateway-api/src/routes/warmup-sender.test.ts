import assert from "node:assert/strict";
import test from "node:test";
import { PROHIBITED_DOMAIN_WORDS } from "../services/naming-validator.ts";
import { SPAM_FLAG_WORDS } from "./send-email.ts";
import {
  WARMUP_FROM_LOCALPART,
  warmupFromAddress
} from "./warmup-sender.ts";

test("warmup sender local-part is allowed by naming and spam flag lists", () => {
  const spamFlagWords: readonly string[] = SPAM_FLAG_WORDS;
  assert.equal(WARMUP_FROM_LOCALPART, "hello");
  assert.equal(PROHIBITED_DOMAIN_WORDS.includes(WARMUP_FROM_LOCALPART), false);
  assert.equal(spamFlagWords.includes(WARMUP_FROM_LOCALPART), false);
  assert.equal(spamFlagWords.includes(warmupFromAddress("delivrix-mail.com")), false);
});
