import assert from "node:assert/strict";
import test from "node:test";
import { jsonOrThrow } from "./json-fetch";

const res = (body: string, status = 200, type = "application/json") =>
    new Response(body, { status, headers: { "Content-Type": type } });

test("ok + JSON valid dikembalikan", async () => {
    assert.deepEqual(await jsonOrThrow(res('{"groups":[]}')), { groups: [] });
});

test("500 body kosong -> Error HTTP, bukan SyntaxError", async () => {
    await assert.rejects(jsonOrThrow(res("", 500)), /HTTP 500/);
});

test("500 body HTML -> Error HTTP, bukan SyntaxError", async () => {
    await assert.rejects(jsonOrThrow(res("<!DOCTYPE html><h1>500</h1>", 500, "text/html")), /HTTP 500/);
});

test("error JSON dari server dipakai sebagai pesan", async () => {
    await assert.rejects(jsonOrThrow(res('{"error":"Unauthorized"}', 401)), /Unauthorized/);
});

test("200 tapi body kosong tetap dianggap gagal", async () => {
    await assert.rejects(jsonOrThrow(res("", 200)), /HTTP 200/);
});
