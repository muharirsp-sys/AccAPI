// 11 Okt 2026: badan 401 webhook-renew.do menggemakan access token ke log container.
import { test } from "node:test";
import assert from "node:assert/strict";
import { redactAccurateSecrets } from "./accurate-redact.ts";
import { classifySaveResponse } from "./accurate-invoice-write.ts";

const token = "3f2b9c1e-8a4d-4f6b-9e21-7c5d0a1b2c3d";
const body401 = JSON.stringify({ error: "invalid_token", error_description: `Invalid access token: ${token}` });

test("token di badan galat Accurate disensor, kode galat tetap terbaca, JSON tetap sah", () => {
    const out = redactAccurateSecrets(body401);
    assert.ok(!out.includes(token), out);
    assert.equal(JSON.parse(out).error, "invalid_token");
    assert.equal(redactAccurateSecrets(`sesi ${token.toUpperCase()} kedaluwarsa`), "sesi [REDACTED] kedaluwarsa");
    assert.equal(redactAccurateSecrets("refresh token: abc123XYZ"), "refresh token: [REDACTED]");
});

test("pesan outbox dari 401 save.do tidak menyimpan token (ikut jawaban cron post-invoices)", () => {
    const outcome = classifySaveResponse(401, body401);
    assert.equal(outcome.kind, "no_answer");
    assert.ok(!("message" in outcome && outcome.message.includes(token)), JSON.stringify(outcome));
});
