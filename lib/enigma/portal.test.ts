/* Kunci: alur portal Enigma (cookie sesudah 302 login, __ncforminfo ikut, menunggu status, baca Detail log) pada server tiruan. */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { unggahEnigma, uraiDetail } from "./portal.ts";

const DETAIL = `<div class="container"><div class="row"><div>Status</div><div>:</div><div>validation_error</div></div>
<div class="row"><div>Keterangan</div><div>:</div><div>Validasi gagal, silahkan diperbaiki sesuai keterangan di bawah.</div></div>
<p>Detail log:</p><ul><li>Terdapat isian kosong pada kolom PRODUK_ID_MI pada baris | 258</li>
<li>QTY_CRT tidak sesuai dengan VALUE_BRUTO (Rasio -5.44%) pada baris | 56</li></ul></div>`;

function portalTiruan(statusAkhir: string) {
    const diterima: { berkas?: string; nc?: boolean } = {};
    let unggahan = 0, panggilBeranda = 0;
    const baris = (id: number, st: string) => `<tr><td>26 October 2026 20:31</td><td><a href="/uploads/REPORT-1000718-${id}-template_enigma.xlsx">REPORT-1000718-${id}-template_enigma.xlsx</a></td><td>${st}</td><td><a href="/upload_detail/${id}">Detail</a></td></tr>`;
    const srv = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
            const masuk = (req.headers.cookie ?? "").includes("session=abc");
            if (req.url === "/login" && req.method === "GET") return res.end(`<form method="POST" action="/login"><input type="text" name="subdist_id"><input type="password" name="password"></form>`);
            if (req.url === "/login") {
                const ok = body.includes("subdist_id=1000718") && body.includes("password=rahasia");
                res.writeHead(302, ok ? { location: "/", "set-cookie": "session=abc; Path=/; HttpOnly" } : { location: "/login" });
                return res.end();
            }
            if (!masuk) { res.writeHead(302, { location: "/login" }); return res.end(); }
            if (req.url === "/" && req.method === "POST") {
                diterima.berkas = /filename="([^"]+)"/.exec(body)?.[1];
                diterima.nc = body.includes('name="__ncforminfo"') && body.includes("TOKENNC");
                unggahan = 266600;
                res.writeHead(302, { location: "/" });
                return res.end();
            }
            if (req.url === "/") {
                const st = unggahan && ++panggilBeranda > 2 ? statusAkhir : "processing";
                return res.end(`<form method="post" action="/" enctype="multipart/form-data"><input type="file" name="excel_file"><input type="hidden" name="__ncforminfo" value="TOKENNC"/></form>
<table><tbody>${unggahan ? baris(unggahan, st) : ""}${baris(266593, "success")}</tbody></table>`);
            }
            if (req.url?.startsWith("/upload_detail/")) return res.end(DETAIL);
            res.writeHead(404); res.end();
        });
    });
    return new Promise<{ dasar: string; diterima: typeof diterima; tutup: () => void }>((ok) =>
        srv.listen(0, "127.0.0.1", () => ok({ dasar: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, diterima, tutup: () => srv.close() })));
}

test("login → unggah (dengan __ncforminfo) → tunggu status final → baca Detail log", async () => {
    const p = await portalTiruan("validation_error");
    let diterima = 0;
    const h = await unggahEnigma({ id: "1000718", password: "rahasia" }, Buffer.from("xlsx"), "template_enigma.xlsx", { dasar: p.dasar, selaMs: 10, tungguMs: 5000, diterima: async () => { diterima++; } });
    p.tutup();
    assert.equal(diterima, 1); // status "diproses" ditulis sebelum menunggu → cron tidak mengunggah ulang
    assert.equal(h.id, 266600);
    assert.equal(h.status, "validation_error");
    assert.equal(p.diterima.berkas, "template_enigma.xlsx");
    assert.equal(p.diterima.nc, true);
    assert.match(h.keterangan, /Validasi gagal/);
    assert.deepEqual(h.log, ["Terdapat isian kosong pada kolom PRODUK_ID_MI pada baris | 258", "QTY_CRT tidak sesuai dengan VALUE_BRUTO (Rasio -5.44%) pada baris | 56"]);
});

test("password salah = galat jelas, tidak mengunggah", async () => {
    const p = await portalTiruan("success");
    await assert.rejects(unggahEnigma({ id: "1000718", password: "salah" }, Buffer.from("x"), "t.xlsx", { dasar: p.dasar, selaMs: 10, tungguMs: 500 }), /login ditolak/);
    assert.equal(p.diterima.berkas, undefined);
    p.tutup();
});

test("uraiDetail membaca status sukses tanpa log", () => {
    assert.deepEqual(uraiDetail(DETAIL.replace("validation_error", "success").replace(/<p>Detail log:[\s\S]*<\/ul>/, "")).log, []);
});
