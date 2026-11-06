/* Kunci: pengirim Puratos = sales_sync.exe 1.0.0 — field multipart, nama berkas tanpa .csv, aturan sukses, dan teks log per kasus. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { LogSalesSync, awalLog, mulaiKirimLog, ringkasLog, unggahBerkas, waktuWita } from "./salessync.ts";

test("unggahBerkas: field persis sales_sync.exe, sukses hanya bila 200 + 'was accepted'; log per kasus", async () => {
    const diterima: string[] = [];
    const server = createServer((req, res) => {
        let badan = "";
        req.on("data", (c) => (badan += c));
        req.on("end", () => {
            diterima.push(badan);
            if (req.url === "/terima") res.end("File delivery Was Accepted\n");
            else if (req.url === "/tolak") res.end("Login incorrect");
            else if (req.url === "/pindah") { res.writeHead(302, { location: "http://lain/login" }); res.end(); }
            else { res.writeHead(500); res.end("boom"); }
        });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const dasar = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const kirim = (jalur: string, log: LogSalesSync) =>
        unggahBerkas({ url: dasar + jalur, login: "LOGIN1", password: "rahasia", nama: "delivery.csv", isi: Buffer.from("﻿a;b\r\n"), log });
    try {
        const ok = new LogSalesSync(() => "2026-11-07 10:00:00.000");
        assert.equal(await kirim("/terima", ok), "File delivery Was Accepted");
        assert.match(diterima[0], /name="__login"\r\n\r\nLOGIN1\r\n/);
        assert.match(diterima[0], /name="__password"\r\n\r\nrahasia\r\n/);
        assert.match(diterima[0], /name="ufile"; filename="delivery"\r\nContent-Type: text\/plain\r\n\r\n﻿a;b\r\n/);
        assert.deepEqual(ok.baris, [
            "2026-11-07 10:00:00.000 | INFO     | uploader:upload_file:24 - Processing : delivery.csv",
            "2026-11-07 10:00:00.000 | INFO     | uploader:upload_file:81 - HTTP Status : 200",
            "2026-11-07 10:00:00.000 | INFO     | uploader:upload_file:115 - Server Response : File delivery Was Accepted",
            "2026-11-07 10:00:00.000 | SUCCESS  | uploader:upload_file:159 - Uploaded : delivery.csv",
            "2026-11-07 10:00:00.000 | SUCCESS  | uploader:upload_file:191 - Archived : delivery.csv",
        ]);

        const tolak = new LogSalesSync(() => "T");
        assert.equal(await kirim("/tolak", tolak), null);
        assert.deepEqual(tolak.baris.slice(-2), ["T | ERROR    | uploader:upload_file:143 - Server did not confirm file acceptance : delivery.csv",
            "T | ERROR    | uploader:move_to_failed:246 - Moved to failed : delivery.csv"]);

        const pindah = new LogSalesSync(() => "T");
        assert.equal(await kirim("/pindah", pindah), null);
        assert.ok(pindah.baris.includes("T | ERROR    | uploader:upload_file:97 - Server redirected to : http://lain/login"));

        const galat = new LogSalesSync(() => "T");
        assert.equal(await kirim("/lain", galat), null);
        assert.ok(galat.baris.includes("T | ERROR    | uploader:upload_file:126 - Upload failed : delivery.csv"));

        const putus = new LogSalesSync(() => "T");
        assert.equal(await unggahBerkas({ url: "http://127.0.0.1:1/x", login: "a", password: "b", nama: "sku.csv", isi: Buffer.from("x"), log: putus }), null);
        assert.ok(putus.baris.includes("T | ERROR    | uploader:upload_file:199 - Upload error : sku.csv"));
    } finally {
        server.close();
    }
});

test("kepala & ringkasan log main(); jam WITA", () => {
    const log = new LogSalesSync(() => "T");
    awalLog(log);
    mulaiKirimLog(log);
    ringkasLog(log, { uploaded: 5, failed: 0, skipped: 0 });
    assert.deepEqual(log.baris.slice(0, 5).map((b) => b.split(" - ")[1]), ["=".repeat(60), "START SALES SYNC", "=".repeat(60), "Loading configuration...", "Sales Sync Version: 1.0.0"]);
    assert.equal(log.baris.at(-1), "T | SUCCESS  | __main__:main:278 - PROCESS FINISHED");
    assert.ok(log.baris.includes("T | INFO     | __main__:main:266 - Failed   : 0"));
    const gagal = new LogSalesSync(() => "T");
    ringkasLog(gagal, { uploaded: 4, failed: 1, skipped: 0 });
    assert.equal(gagal.baris.at(-1), "T | WARNING  | __main__:main:284 - PROCESS FINISHED WITH ERRORS");
    assert.equal(waktuWita(Date.parse("2026-11-07T02:00:01.234Z")), "2026-11-07 10:00:01.234");
});
