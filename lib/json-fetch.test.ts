import assert from "node:assert/strict";
import test from "node:test";
import { jsonOrThrow, getJson } from "./json-fetch";

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

test("getJson: gagal jadi result, tidak throw", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async () => res("", 500);
    try {
        const r = await getJson("/x");
        assert.equal(r.ok, false);
        assert.match(r.ok === false ? r.error : "", /HTTP 500/);
    } finally { globalThis.fetch = orig; }
});

test("getJson: fetch reject pun jadi result", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("ECONNREFUSED"); };
    try {
        const r = await getJson("/x");
        assert.equal(r.ok, false);
        assert.match(r.ok === false ? r.error : "", /ECONNREFUSED/);
    } finally { globalThis.fetch = orig; }
});
