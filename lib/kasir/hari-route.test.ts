/* K2a route Kasir tanpa DB: GET /api/kasir, POST setoran/jelaskan/tutup/buka, GET bukti — sesi & izin dipalsukan (tanpa bypass lokal),
 * db.transaction tiruan (dilarang kecuali disuntik), direktori bukti = folder sementara. Diuji: 401, 403 per kunci, 400 INPUT_SALAH (desimal 3,
 * negatif, pemisah ribuan, angka bukan teks, Form Kasir kosong saat > 0, bukti absen saat transfer > 0, Giro tanpa nomor BG / jatuh tempo,
 * tanggal depan, magic bytes palsu, berkas > 5 MB), berkas bukti dihapus bila galat pasti & DIBIARKAN bila TIDAK_PASTI, unduh bukti (pola nama
 * ketat, nosniff, PDF attachment), bentuk GET: angka Incaso null bila status ≠ lengkap, galat internal tanpa pesan mentah. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { GET as getHari } from "../../app/api/kasir/route.ts";
import { POST as postSetoran } from "../../app/api/kasir/setoran/route.ts";
import { POST as postJelaskan } from "../../app/api/kasir/jelaskan/route.ts";
import { POST as postTutup } from "../../app/api/kasir/tutup/route.ts";
import { POST as postBuka } from "../../app/api/kasir/buka/route.ts";
import { GET as getBukti } from "../../app/api/kasir/bukti/route.ts";
import { BATAS_KOLOM_SEN, bawaanHari, bentukJawabanHari, jawabanGalat, uraiSetoran, type DepsHari, type Muatan } from "./hari.ts";
import sharp from "sharp";
import { hapusBukti, jenisBukti, namaBuktiSah, SISI_MAKS_PX, tempatBukti } from "./bukti.ts";
import { belumDibaca, type StatusBaca } from "./baca-pelunasan.ts";
import { rekonsiliasiHari, type PetaOrang } from "./rekonsiliasi.ts";
import { accurateEmployee, kasirSetoran } from "../../db/schema.ts";
import { auth } from "../auth.ts";
import { db } from "../db.ts";

const D = "2026-10-05";
const JAM = new Date("2026-10-05T10:00:00+08:00");
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
/** PNG sah (bisa didekode sharp) untuk unggahan yang harus lolos encode ulang. */
let pngAsliMemo: Promise<Uint8Array> | null = null;
const pngAsli = () => (pngAsliMemo ??= sharp({ create: { width: 40, height: 20, channels: 3, background: { r: 200, g: 10, b: 10 } } }).png().toBuffer()
    .then((b) => new Uint8Array(b)));

/** Rantai db.select tiruan: tiap select() memakai jawaban berikutnya dari antrean (izin dulu). */
function selectTiruan(antrean: unknown[][]) {
    return () => {
        const hasil = antrean.shift() ?? [];
        const rantai: Record<string, unknown> = {};
        for (const m of ["from", "leftJoin", "innerJoin", "where", "orderBy", "limit"]) rantai[m] = () => rantai;
        rantai.then = (ok: (v: unknown) => unknown, gagal: (e: unknown) => unknown) => Promise.resolve(hasil).then(ok, gagal);
        return rantai;
    };
}

/**
 * Transaksi tiruan untuk catatSetoran: SELECT apa pun = [] kecuali accurate_employee (satu pegawai S-A); INSERT kasir_setoran memantulkan
 * baris. `sesudah` = "commit" (berhasil) | "putus" (galat SESUDAH callback = commit tidak pasti).
 */
function transaksiTiruan(sesudah: "commit" | "putus", dicatat: unknown[][]) {
    const pilih = () => {
        let tabel: unknown;
        const r: Record<string, unknown> = {};
        r.from = (t: unknown) => { tabel = t; return r; };
        for (const m of ["leftJoin", "innerJoin", "where", "orderBy", "limit"]) r[m] = () => r;
        r.then = (ok: (v: unknown) => unknown) => Promise.resolve(tabel === accurateEmployee
            ? [{ id: 1, number: "S-A", name: "SALES A", salesman: true, suspended: false }] : []).then(ok);
        return r;
    };
    const tx = {
        execute: async () => ({ rows: [], rowCount: 0 }),
        select: pilih,
        insert: (t: unknown) => ({ values: (v: Record<string, unknown>[]) => ({ returning: async () => {
            assert.equal(t, kasirSetoran);
            dicatat.push(v);
            return v.map((x, i) => ({ id: 70 + i, kode: x.salesmanKode, revisi: x.revisi, bukti: x.buktiTransfer ?? null }));
        } }) }),
    };
    return async (cb: (t: unknown) => Promise<unknown>) => {
        const r = await cb(tx);
        if (sesudah === "putus") throw new Error("uji: koneksi putus saat COMMIT");
        return r;
    };
}

async function dengan<T>(o: { sesi?: boolean; izin?: string[]; select?: unknown[][]; transaksi?: unknown; deps?: Partial<DepsHari> },
    fn: (dir: string) => Promise<T>): Promise<T> {
    const simpan = [
        [auth.api, "getSession", Object.getOwnPropertyDescriptor(auth.api, "getSession")],
        [db, "select", Object.getOwnPropertyDescriptor(db, "select")],
        [db, "transaction", Object.getOwnPropertyDescriptor(db, "transaction")],
        [globalThis, "fetch", Object.getOwnPropertyDescriptor(globalThis, "fetch")],
    ] as const;
    const depsLama = { ...bawaanHari };
    const dirLama = tempatBukti.dir;
    const bypassLama = process.env.LOCAL_AUTH_BYPASS;
    delete process.env.LOCAL_AUTH_BYPASS;
    const dir = await mkdtemp(path.join(tmpdir(), "kasir-bukti-"));
    tempatBukti.dir = dir;
    Object.defineProperty(auth.api, "getSession", { configurable: true, value: async () => (o.sesi === false ? null : { user: { id: "u-kasir", role: "staff" }, session: { id: "s1" } }) });
    Object.defineProperty(db, "select", { configurable: true, value: selectTiruan([(o.izin ?? []).map((key) => ({ groupId: "g1", key })), ...(o.select ?? [])]) });
    Object.defineProperty(db, "transaction", { configurable: true, value: o.transaksi ?? (async () => { throw new Error("uji: transaksi DB tidak disuntik"); }) });
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: () => { throw new Error("TIDAK BOLEH ke jaringan"); } });
    Object.assign(bawaanHari, { sekarang: () => JAM, databaseId: async () => "DB-UJI", nama: async () => new Map<string, string>(), jeda: async () => undefined }, o.deps ?? {});
    try {
        return await fn(dir);
    } finally {
        Object.assign(bawaanHari, depsLama);
        tempatBukti.dir = dirLama;
        await rm(dir, { recursive: true, force: true });
        for (const [obj, k, d] of simpan) {
            if (d) Object.defineProperty(obj, k, d);
            else delete (obj as unknown as Record<string, unknown>)[k];
        }
        if (bypassLama === undefined) delete process.env.LOCAL_AUTH_BYPASS; else process.env.LOCAL_AUTH_BYPASS = bypassLama;
    }
}

const json = (url: string, body: unknown) => new NextRequest(`http://app.test${url}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
function multipart(data: unknown, bukti?: { isi: Uint8Array; nama: string }) {
    const fd = new FormData();
    fd.set("data", JSON.stringify(data));
    if (bukti) fd.set("bukti", new File([bukti.isi], bukti.nama));
    return new NextRequest("http://app.test/api/kasir/setoran", { method: "POST", body: fd });
}
const baku = { tanggal: D, orang: "S-A", tunai: "1250000", transfer: "0", giro: "0", noFormKasir: "FK-0415", dasar: [] };
type Badan = { ok: boolean; kode?: string; field?: string; error?: string; buktiUrl?: string | null };

test("route Kasir: tanpa sesi 401; tanpa kunci yang tepat 403 (view/catat/tutup/buka dipisah)", async () => {
    const panggil = [
        () => getHari(new NextRequest(`http://app.test/api/kasir?tanggal=${D}`)),
        () => postSetoran(json("/api/kasir/setoran", baku)),
        () => postJelaskan(json("/api/kasir/jelaskan", {})),
        () => postTutup(json("/api/kasir/tutup", {})),
        () => postBuka(json("/api/kasir/buka", {})),
        () => getBukti(new NextRequest("http://app.test/api/kasir/bukti?id=1")),
    ];
    for (const p of panggil) assert.equal((await dengan({ sesi: false }, p)).status, 401);
    const tolak: [() => Promise<Response>, string[]][] = [
        [panggil[0], ["kasir.catat", "kasir.tutup", "kasir.buka"]],
        [panggil[1], ["kasir.view", "kasir.tutup", "kasir.buka"]],
        [panggil[2], ["kasir.view", "kasir.tutup", "kasir.buka"]],
        [panggil[3], ["kasir.view", "kasir.catat", "kasir.buka"]],
        [panggil[4], ["kasir.view", "kasir.catat", "kasir.tutup"]],
        [panggil[5], ["kasir.catat", "kasir.tutup", "kasir.buka"]],
    ];
    for (const [p, izin] of tolak) assert.equal((await dengan({ izin }, p)).status, 403, izin.join(","));
});

test("POST setoran: 400 INPUT_SALAH + field sebelum DB / berkas (desimal 3, negatif, ribuan, angka, Form Kasir, bukti, Giro, tanggal, dasar)", async () => {
    const kasus: [Record<string, unknown>, string][] = [
        [{ tunai: "100.123" }, "tunai"],
        [{ tunai: "90000000000000", giro: "90000000000000", giroNomor: "BG-1", giroJatuhTempo: D }, "tunai"], // satu orang dua kolom raksasa
        [{ tunai: "100000000000.01" }, "tunai"], // > Rp 100 miliar per kolom
        [{ giro: "100000000001", giroNomor: "BG-1", giroJatuhTempo: D }, "giro"],
        [{ tunai: "-5" }, "tunai"],
        [{ tunai: "1.250.000" }, "tunai"],
        [{ tunai: 1250000 }, "tunai"],
        [{ transfer: "1e5" }, "transfer"],
        [{ giro: "" }, "giro"],
        [{ noFormKasir: "  " }, "noFormKasir"],
        [{ noFormKasir: undefined }, "noFormKasir"],
        [{ transfer: "500" }, "buktiTransfer"],
        [{ giro: "500" }, "giroNomor"],
        [{ giro: "500", giroNomor: "BG-1" }, "giroJatuhTempo"],
        [{ giro: "500", giroNomor: "BG-1", giroJatuhTempo: "2026-02-30" }, "giroJatuhTempo"],
        [{ giroNomor: "BG-1" }, "giroNomor"],
        [{ giro: "500", giroNomor: "BG-1", giroJatuhTempo: "1900-01-01" }, "giroJatuhTempo"],
        [{ giro: "500", giroNomor: "BG-1", giroJatuhTempo: "2026-09-27" }, "giroJatuhTempo"], // tanggal − 8 hari
        [{ giro: "500", giroNomor: "BG-1", giroJatuhTempo: "2027-10-06" }, "giroJatuhTempo"], // > 1 tahun
        [{ buktiLama: true }, "buktiTransfer"],
        [{ tanggal: "2026-10-06" }, "tanggal"],
        [{ tanggal: "05/10/2026" }, "tanggal"],
        [{ orang: "" }, "orang"],
        [{ dasar: "x" }, "dasar"],
        [{ dasar: [{ kode: "S-A", revisi: 0 }] }, "dasar"],
        [{ dasar: [{ kode: "S-A", revisi: 1 }, { kode: "S-A", revisi: 2 }] }, "dasar"],
    ];
    for (const [ubah, field] of kasus) {
        const r = await dengan({ izin: ["kasir.catat"] }, async (dir) => {
            const res = await postSetoran(json("/api/kasir/setoran", { ...baku, ...ubah }));
            assert.deepEqual(await readdir(dir), [], "tak ada berkas tertinggal");
            return res;
        });
        assert.equal(r.status, 400, JSON.stringify(ubah));
        const b = await r.json() as Badan;
        assert.deepEqual([b.ok, b.kode, b.field], [false, "INPUT_SALAH", field], JSON.stringify(ubah));
    }
    // Setoran 0 tanpa nomor Form Kasir = sah (lolos urai, lalu sampai DB — di sini transaksi tiruan menolak -> 500 pasti).
    const nol = await dengan({ izin: ["kasir.catat"] }, () => postSetoran(json("/api/kasir/setoran", { ...baku, tunai: "0", noFormKasir: undefined })));
    assert.deepEqual([nol.status, (await nol.json() as Badan).kode], [500, "GALAT_INTERNAL"]);
});

test("POST setoran multipart: magic bytes palsu / > 5 MB / transfer 0 + berkas -> 400 tanpa berkas tertinggal; galat pasti -> berkas DIHAPUS; TIDAK_PASTI -> berkas DIBIARKAN", async () => {
    const transfer = { ...baku, transfer: "500000" };
    for (const [data, bukti] of [
        [transfer, { isi: new TextEncoder().encode("bukan gambar"), nama: "bukti.jpg" }],
        [transfer, { isi: Uint8Array.from([0x25, 0x50, 0x44, 0x46]), nama: "bukti.pdf" }], // "%PDF" tanpa "-"
        [baku, { isi: PNG, nama: "bukti.png" }],
    ] as const) {
        const r = await dengan({ izin: ["kasir.catat"] }, async (dir) => {
            const res = await postSetoran(multipart(data, bukti));
            assert.deepEqual(await readdir(dir), []);
            return res;
        });
        const b = await r.json() as Badan;
        assert.deepEqual([r.status, b.kode, b.field], [400, "INPUT_SALAH", "buktiTransfer"], bukti.nama);
    }
    const besar = await dengan({ izin: ["kasir.catat"] }, () => postSetoran(new NextRequest("http://app.test/api/kasir/setoran", {
        method: "POST", body: "x", headers: { "content-type": "multipart/form-data; boundary=x", "content-length": String(7 * 1024 * 1024) } })));
    assert.deepEqual([besar.status, (await besar.json() as Badan).kode], [413, "BADAN_TERLALU_BESAR"]);
    // 5 MiB + 1 byte berheader JPEG SAH -> ditolak karena UKURAN (bukan magic bytes): pesan menyebut 5 MB.
    const jpeg5 = new Uint8Array(5 * 1024 * 1024 + 1);
    jpeg5.set([0xff, 0xd8, 0xff, 0xe0]);
    const lewat5 = await dengan({ izin: ["kasir.catat"] }, () => postSetoran(multipart(transfer, { isi: jpeg5, nama: "b.jpg" })));
    const l5 = await lewat5.json() as Badan;
    assert.deepEqual([lewat5.status, l5.field], [400, "buktiTransfer"]);
    assert.match(l5.error ?? "", /maksimal 5 MB/);

    // DB gagal SEBELUM commit -> 500 GALAT_INTERNAL (pasti) dan berkas yang sudah ditulis DIHAPUS.
    const g = await dengan({ izin: ["kasir.catat"] }, async (dir) => {
        const res = await postSetoran(multipart(transfer, { isi: await pngAsli(), nama: "x.txt" }));
        assert.deepEqual(await readdir(dir), [], "berkas yatim dihapus");
        return res;
    });
    const gb = await g.json() as Badan;
    assert.deepEqual([g.status, gb.kode], [500, "GALAT_INTERNAL"]);
    assert.doesNotMatch(gb.error ?? "", /uji: transaksi/, "tanpa pesan galat mentah");

    // Commit berhasil -> 200 + buktiUrl; berkas tersimpan bernama UUID (bukan nama dari klien).
    const dicatat: unknown[][] = [];
    const ok = await dengan({ izin: ["kasir.catat"], transaksi: transaksiTiruan("commit", dicatat) }, async (dir) => {
        const res = await postSetoran(multipart(transfer, { isi: await pngAsli(), nama: "../../etc/passwd" }));
        const isi = await readdir(dir);
        assert.equal(isi.length, 1);
        assert.ok(namaBuktiSah(isi[0]) && isi[0].endsWith(".jpg"), `${isi[0]} (PNG di-encode ulang menjadi JPEG)`);
        assert.equal((dicatat[0][0] as { buktiTransfer: string }).buktiTransfer, isi[0]);
        return res;
    });
    const okb = await ok.json() as Badan & { revisi: unknown };
    assert.deepEqual([ok.status, okb.ok, okb.buktiUrl, okb.revisi], [200, true, "/api/kasir/bukti?id=70", [{ kode: "S-A", revisi: 1 }]]);
    assert.deepEqual((dicatat[0][0] as Record<string, unknown>).tunai, "1250000.00", "\"Rp 1.250.000\" dikirim \"1250000\" -> numeric 2 desimal");

    // Galat SESUDAH callback (COMMIT putus) -> 502 TIDAK_PASTI; berkas DIBIARKAN (baris mungkin tersimpan).
    const tp = await dengan({ izin: ["kasir.catat"], transaksi: transaksiTiruan("putus", []) }, async (dir) => {
        const res = await postSetoran(multipart(transfer, { isi: await pngAsli(), nama: "b.png" }));
        assert.equal((await readdir(dir)).length, 1, "berkas tetap ada");
        return res;
    });
    assert.deepEqual([tp.status, (await tp.json() as Badan).kode], [502, "TIDAK_PASTI"]);
});

test("POST setoran: gambar bukti DI-ENCODE ULANG (EXIF/GPS & polyglot terbuang, ≤ 2000 px, JPEG); gambar rusak 400; PDF apa adanya", async () => {
    const transfer = { ...baku, transfer: "500000" };
    // PNG 3000×1500 ber-EXIF (penanda "GPS-RAHASIA") + muatan polyglot sesudah IEND.
    const asli = await sharp({ create: { width: 3000, height: 1500, channels: 3, background: { r: 10, g: 120, b: 200 } } })
        .withExif({ IFD0: { Copyright: "GPS-RAHASIA" } }).png().toBuffer();
    assert.match(Buffer.from(asli).toString("latin1"), /GPS-RAHASIA/, "masukan memang membawa EXIF");
    const poliglot = new Uint8Array(Buffer.concat([asli, Buffer.from("<script>alert(1)</script>")]));
    const tersimpan = async (isi: Uint8Array, nama: string) => {
        let hasil: { nama: string; isi: Buffer } | null = null;
        const res = await dengan({ izin: ["kasir.catat"], transaksi: transaksiTiruan("commit", []) }, async (dir) => {
            const r = await postSetoran(multipart(transfer, { isi, nama }));
            const [f] = await readdir(dir);
            if (f) hasil = { nama: f, isi: await readFile(path.join(dir, f)) };
            return r;
        });
        return { status: res.status, berkas: hasil as { nama: string; isi: Buffer } | null };
    };
    const g = await tersimpan(poliglot, "bukti.png");
    assert.equal(g.status, 200);
    assert.ok(g.berkas?.nama.endsWith(".jpg"));
    const meta = await sharp(g.berkas!.isi).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height, meta.exif], ["jpeg", SISI_MAKS_PX, 1000, undefined]);
    const teks = g.berkas!.isi.toString("latin1");
    assert.doesNotMatch(teks, /GPS-RAHASIA/, "EXIF dibuang");
    assert.doesNotMatch(teks, /<script>/, "muatan polyglot dibuang");
    // Gambar kecil tidak diperbesar.
    const kecil = await tersimpan(await pngAsli(), "k.png");
    assert.deepEqual([(await sharp(kecil.berkas!.isi).metadata()).width], [40]);
    // Berheader PNG tetapi rusak -> 400, tanpa berkas tertinggal.
    const rusak = await dengan({ izin: ["kasir.catat"] }, async (dir) => {
        const r = await postSetoran(multipart(transfer, { isi: PNG, nama: "r.png" }));
        assert.deepEqual(await readdir(dir), []);
        return r;
    });
    const rb = await rusak.json() as Badan;
    assert.deepEqual([rusak.status, rb.field], [400, "buktiTransfer"]);
    assert.match(rb.error ?? "", /rusak/);
    // PDF disimpan byte demi byte.
    const pdfIsi = new TextEncoder().encode("%PDF-1.4\n% bukti transfer\n%%EOF");
    const pdf = await tersimpan(pdfIsi, "b.pdf");
    assert.ok(pdf.berkas?.nama.endsWith(".pdf"));
    assert.deepEqual(new Uint8Array(pdf.berkas!.isi), pdfIsi);
});

test("POST setoran: PNG TRANSPARAN berteks hitam -> JPEG berlatar PUTIH (bukan seluruhnya hitam = bukti hilang); RGBA, palet tRNS, abu+alfa", async () => {
    // 60×20 transparan (RGB 0 di bawah alfa 0) + coretan hitam pekat 40×4 = "teks". Tanpa flatten, JPEG membuang alfa -> semua 0/0/0.
    const [w, h] = [60, 20];
    const rgba = Buffer.alloc(w * h * 4);
    for (let y = 8; y < 12; y++) for (let x = 10; x < 50; x++) rgba[(y * w + x) * 4 + 3] = 255;
    const mentah = () => sharp(rgba, { raw: { width: w, height: h, channels: 4 } });
    const varian: [string, Buffer][] = [
        ["rgba", await mentah().png().toBuffer()],
        ["palet tRNS", await mentah().png({ palette: true }).toBuffer()],
        ["abu+alfa", await mentah().toColourspace("b-w").png().toBuffer()],
    ];
    for (const [nama, isi] of varian) {
        assert.ok((await sharp(isi).metadata()).hasAlpha, `${nama}: masukan memang beralfa`);
        const r = await dengan({ izin: ["kasir.catat"], transaksi: transaksiTiruan("commit", []) }, async (dir) => {
            const res = await postSetoran(multipart({ ...baku, transfer: "500000" }, { isi: new Uint8Array(isi), nama: "t.png" }));
            const [f] = await readdir(dir);
            return { status: res.status, st: f ? await sharp(await readFile(path.join(dir, f))).stats() : null };
        });
        assert.equal(r.status, 200, nama);
        const rata = r.st!.channels.slice(0, 3).map((c) => c.mean);
        assert.ok(rata.every((m) => m > 200), `${nama}: latar putih, rata-rata kanal ${rata.map(Math.round).join("/")}`);
        assert.ok(r.st!.channels[0].min < 60, `${nama}: coretan hitam tetap terbaca (min ${r.st!.channels[0].min})`);
    }
});

test("GET hari: batas `orang` = 100 CODE POINT (100 emoji = 200 unit UTF-16 lolos; 101 -> 400 field orang)", async () => {
    let dicapai = 0;
    const get = (n: number) => dengan({ izin: ["kasir.view"], deps: { databaseId: async () => { dicapai++; throw new Error("uji: berhenti sesudah gerbang orang"); } } },
        () => getHari(new NextRequest(`http://app.test/api/kasir?tanggal=${D}&orang=${encodeURIComponent("😀".repeat(n))}`)));
    const salahLog = console.error;
    console.error = () => undefined;
    try {
        const lolos = await get(100);
        assert.deepEqual([lolos.status, (await lolos.json() as Badan).kode, dicapai], [500, "GALAT_INTERNAL", 1], "100 code point melewati gerbang");
        const tolak = await get(101);
        assert.deepEqual([tolak.status, (await tolak.json() as Badan).field, dicapai], [400, "orang", 1]);
    } finally {
        console.error = salahLog;
    }
});

test("bukti: galat baca selain ENOENT -> 500 GALAT_INTERNAL tercatat (bukan 404 diam); hapusBukti mencatat galat selain ENOENT", async () => {
    const nama = "0a1b2c3d-0000-4000-8000-000000000002";
    const log: unknown[][] = [];
    const asli = console.error;
    console.error = (...a: unknown[]) => { log.push(a); };
    try {
        const r = await dengan({ izin: ["kasir.view"], select: [[{ bukti: `${nama}.jpg`, tanggal: D, kode: "S-A", revisi: 1 }]] }, async (dir) => {
            await mkdir(path.join(dir, `${nama}.jpg`)); // EISDIR saat dibaca
            return getBukti(new NextRequest("http://app.test/api/kasir/bukti?id=9"));
        });
        assert.deepEqual([r.status, (await r.json() as Badan).kode], [500, "GALAT_INTERNAL"]);
        assert.ok(log.some((a) => a[0] === "[KASIR BUKTI]"), "galat dicatat");
        log.length = 0;
        await dengan({}, async (dir) => {
            await mkdir(path.join(dir, `${nama}.jpg`));
            await hapusBukti(`${nama}.jpg`); // unlink direktori -> EPERM/EISDIR
            await hapusBukti(`${nama.replace(/2$/, "3")}.jpg`); // ENOENT -> diam
        });
        assert.equal(log.length, 1, "satu catatan: hanya galat selain ENOENT");
        assert.match(String(log[0][0]), /gagal menghapus berkas yatim/);
    } finally {
        console.error = asli;
    }
});

test("POST setoran: badan CHUNKED tanpa content-length ditolak 413 tanpa membaca badan penuh (stream diputus sesudah 6 MB)", async () => {
    const POTONG = 64 * 1024;
    let ditarik = 0;
    let dibatalkan = false;
    const aliran = new ReadableStream<Uint8Array>({
        pull(c) {
            if (ditarik >= 50 * 1024 * 1024) return c.close();
            ditarik += POTONG;
            c.enqueue(new Uint8Array(POTONG));
        },
        cancel() { dibatalkan = true; },
    });
    const req = new NextRequest("http://app.test/api/kasir/setoran", { method: "POST", body: aliran, duplex: "half",
        headers: { "content-type": "multipart/form-data; boundary=x" } } as ConstructorParameters<typeof NextRequest>[1]);
    assert.equal(req.headers.get("content-length"), null, "memang tanpa content-length");
    const r = await dengan({ izin: ["kasir.catat"] }, () => postSetoran(req));
    assert.deepEqual([r.status, (await r.json() as Badan).kode], [413, "BADAN_TERLALU_BESAR"]);
    assert.ok(ditarik <= 6 * 1024 * 1024 + 4 * POTONG, `ditarik ${ditarik} byte (bukan 50 MB)`);
    assert.equal(dibatalkan, true, "stream dibatalkan");
    // Badan chunked KECIL tetap diterima (urai normal -> validasi isian).
    const kecil = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(JSON.stringify({ ...baku, tunai: "-1" }))); c.close(); } });
    const rk = await dengan({ izin: ["kasir.catat"] }, () => postSetoran(new NextRequest("http://app.test/api/kasir/setoran", { method: "POST", body: kecil,
        duplex: "half", headers: { "content-type": "application/json" } } as ConstructorParameters<typeof NextRequest>[1])));
    assert.deepEqual([rk.status, (await rk.json() as Badan).field], [400, "tunai"]);
});

test("POST jelaskan/tutup/buka + GET hari: 400 INPUT_SALAH + field", async () => {
    const jl = { tanggal: D, jenis: "selisih", orang: "S-A", angka: { pelunasan: "100", setoran: "0" }, penjelasan: "Setor susulan besok pagi", tindakLanjut: "setor_susulan" };
    for (const [ubah, field] of [
        [{ penjelasan: "terlalu pendek" }, "penjelasan"],
        [{ penjelasan: "😀".repeat(8) }, "penjelasan"], // 8 code point (16 unit UTF-16) < 15 = char_length DB
        [{ penjelasan: "😀".repeat(1001) }, "penjelasan"],
        [{ tindakLanjut: undefined }, "tindakLanjut"],
        [{ jenis: "lain" }, "jenis"],
        [{ angka: { pelunasan: "100.001", setoran: "0" } }, "angka.pelunasan"],
        [{ jenis: "tak_teralokasi", pelunasanId: 5, angka: { sisa: "0" } }, "angka.sisa"],
        [{ jenis: "tak_teralokasi", pelunasanId: "5", angka: { sisa: "-10" } }, "pelunasanId"],
        [{ tanggal: "2026-10-06" }, "tanggal"],
    ] as [Record<string, unknown>, string][]) {
        const r = await dengan({ izin: ["kasir.catat"] }, () => postJelaskan(json("/api/kasir/jelaskan", { ...jl, ...ubah })));
        assert.deepEqual([r.status, (await r.json() as Badan).field], [400, field], JSON.stringify(ubah));
    }
    const t = await dengan({ izin: ["kasir.tutup"] }, () => postTutup(json("/api/kasir/tutup", { tanggal: D, sidik: "x" })));
    assert.deepEqual([t.status, (await t.json() as Badan).field], [400, "sidik"]);
    for (const alasan of ["  dibuka   ", "🔓".repeat(8)]) {
        const b = await dengan({ izin: ["kasir.buka"] }, () => postBuka(json("/api/kasir/buka", { tanggal: D, alasan })));
        assert.deepEqual([b.status, (await b.json() as Badan).field], [400, "alasan"], alasan);
    }
    for (const q of ["", "?tanggal=2026-10-06", "?tanggal=2026-13-01"]) {
        const g = await dengan({ izin: ["kasir.view"] }, () => getHari(new NextRequest(`http://app.test/api/kasir${q}`)));
        assert.deepEqual([g.status, (await g.json() as Badan).field], [400, "tanggal"], q);
    }
});

test("GET bukti: id salah 400; baris/berkas tak ada atau nama tak berpola (traversal) 404; gambar inline + nosniff; PDF attachment", async () => {
    assert.equal((await dengan({ izin: ["kasir.view"] }, () => getBukti(new NextRequest("http://app.test/api/kasir/bukti?id=../1")))).status, 400);
    assert.equal((await dengan({ izin: ["kasir.view"], select: [[]] }, () => getBukti(new NextRequest("http://app.test/api/kasir/bukti?id=9")))).status, 404);
    const jalur = await dengan({ izin: ["kasir.view"], select: [[{ bukti: "../../../etc/passwd", tanggal: D, kode: "S-A", revisi: 1 }]] },
        () => getBukti(new NextRequest("http://app.test/api/kasir/bukti?id=9")));
    assert.equal(jalur.status, 404);
    const nama = "0a1b2c3d-0000-4000-8000-000000000001";
    const png = await dengan({ izin: ["kasir.view"], select: [[{ bukti: `${nama}.png`, tanggal: D, kode: "S/A", revisi: 2 }]] }, async (dir) => {
        await writeFile(path.join(dir, `${nama}.png`), PNG);
        return getBukti(new NextRequest("http://app.test/api/kasir/bukti?id=9"));
    });
    assert.equal(png.status, 200);
    assert.deepEqual([png.headers.get("content-type"), png.headers.get("x-content-type-options"), png.headers.get("cache-control"), png.headers.get("content-disposition"),
        png.headers.get("content-security-policy")],
        ["image/png", "nosniff", "private, no-store", `inline; filename="bukti-${D}-S_A-r2.png"`, "sandbox"]);
    assert.deepEqual(new Uint8Array(await png.arrayBuffer()), PNG);
    const pdf = await dengan({ izin: ["kasir.view"], select: [[{ bukti: `${nama}.pdf`, tanggal: D, kode: "S-A", revisi: 1 }]] }, async (dir) => {
        await writeFile(path.join(dir, `${nama}.pdf`), new TextEncoder().encode("%PDF-1.4"));
        return getBukti(new NextRequest("http://app.test/api/kasir/bukti?id=9"));
    });
    assert.match(pdf.headers.get("content-disposition") ?? "", /^attachment;/);
});

test("uraiSetoran: tepat Rp 100 miliar per kolom sah (batas inklusif)", () => {
    const r = uraiSetoran({ ...baku, tunai: "100000000000", giro: "100000000000.00", giroNomor: "BG-1", giroJatuhTempo: D }, JAM, false);
    assert.deepEqual([r.tunai, r.giro], [BATAS_KOLOM_SEN, BATAS_KOLOM_SEN]);
    // Jatuh tempo Giro: tanggal − 7 hari dan tanggal yang sama tahun depan = batas inklusif.
    for (const jt of ["2026-09-28", "2027-10-05"]) {
        assert.equal(uraiSetoran({ ...baku, giro: "1", giroNomor: "BG-1", giroJatuhTempo: jt }, JAM, false).giroJatuhTempo, jt);
    }
    // Panjang = code point: 60 emoji (120 unit UTF-16) ≤ 100 huruf Form Kasir.
    assert.equal(uraiSetoran({ ...baku, noFormKasir: "🧾".repeat(60) }, JAM, false).noFormKasir, "🧾".repeat(60));
});

test("bukti: jenis dari MAGIC BYTES (bukan nama) + pola nama ketat", () => {
    assert.equal(jenisBukti(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])), "jpg");
    assert.equal(jenisBukti(PNG), "png");
    assert.equal(jenisBukti(new TextEncoder().encode("%PDF-1.7")), "pdf");
    for (const x of ["GIF89a", "<svg", "%PDF", "<html>"]) assert.equal(jenisBukti(new TextEncoder().encode(x)), null, x);
    assert.equal(namaBuktiSah("0a1b2c3d-0000-4000-8000-000000000001.jpg"), true);
    for (const x of ["../x.jpg", "0a1b2c3d-0000-4000-8000-000000000001.svg", "0A1B2C3D-0000-4000-8000-000000000001.jpg", "a/0a1b2c3d-0000-4000-8000-000000000001.jpg"]) {
        assert.equal(namaBuktiSah(x), false, x);
    }
});

// --- bentuk GET (murni) ---
const PETA: PetaOrang = { kodeSalesman: new Map([[1, "S-A"]]), gabunganPerBulan: new Map() };
function muatan(baca: StatusBaca | null): Muatan {
    const pelunasan = baca ? [{ id: 11, nomor: "SR/11", tanggal: D, metode: "CASH_OTHER", chequeAmount: 10_000_000, faktur: [{ fakturId: 1, masterSalesmanId: 1, invoicePayment: 10_000_000 }] },
        { id: 12, nomor: "SR/12", tanggal: D, metode: "CREDIT_CARD", chequeAmount: 500_000, faktur: [] }] : [];
    const setoran = [{ id: 7, salesmanKode: "S-A", revisi: 1, tunai: 9_000_000, transfer: 0, giro: 0, giroNomor: null, giroJatuhTempo: null, noFormKasir: "FK-1",
        buktiTransfer: null, catatan: null, dicatatOleh: "u-kasir", dicatatPada: JAM }];
    return {
        tanggal: D, databaseId: baca ? "DB-UJI" : "", events: [], setoran, catatan: [], catatanTak: [], baca, pelunasan, peta: PETA,
        namaKode: new Map([["S-A", "SALES A"]]), pegawai: [{ kode: "S-A", orang: "S-A", nama: "SALES A" }], kodeDikenal: new Set(["S-A"]),
        hasil: rekonsiliasiHari({ tanggal: D, pelunasan, setoran, peta: PETA }),
    };
}
const bentuk = (m: Muatan, orang: string | null = "S-A") => bentukJawabanHari(m, { sekarang: JAM, orang, namaUser: new Map([["u-kasir", "KASIR A"]]), baca: null });

test("bentuk GET: status ≠ lengkap -> SEMUA angka Incaso null + sebab (setoran tetap); lengkap -> angka; tanpa database -> SESI_SINKRON", () => {
    const st = (s: Partial<StatusBaca>): StatusBaca => ({ ...belumDibaca("DB-UJI", D), ...s });
    for (const b of [st({}), st({ status: "berjalan", aktif: true }), st({ status: "sebagian", jumlahDaftar: 3, sisaDetail: 1 }), st({ status: "gagal", sebab: "bentuk", pesan: "x" })]) {
        const j = bentuk(muatan(b));
        assert.deepEqual([j.incaso.lengkap, j.incaso.sebab], [false, "BACA_BELUM_LENGKAP"], b.status);
        assert.match(j.incaso.pesan!, /bukan nol/);
        const o = j.orang[0];
        assert.deepEqual([o.pelunasan, o.pelunasanPerMetode, o.jumlahFaktur, o.selisih, o.status, o.dijelaskan, o.salesmanIdTakDikenal], [null, null, null, null, null, null, null]);
        assert.deepEqual([j.total.pelunasan, j.total.selisih, j.total.takTeralokasi, j.total.takTeralokasiBelumDijelaskan, j.total.nonKas, j.total.klop],
            [null, null, null, null, null, null]);
        assert.deepEqual([j.takTeralokasi, j.nonKas, j.penghalangTutup, j.sidik, j.hari.berubahSejakDitutup, j.rincian], [null, null, null, null, null, null]);
        assert.deepEqual([o.setoran?.total, j.total.setoran, o.setoranTerakhir?.noFormKasir, j.riwayat.setoran[0].oleh], ["90000.00", "90000.00", "FK-1", "KASIR A"]);
        assert.equal(j.segarUntukTutup, false);
    }
    const lengkap = bentuk(muatan(st({ status: "lengkap", jumlahDaftar: 2, sisaDetail: 0, lengkapPada: new Date(JAM.getTime() - 60_000).toISOString() })));
    assert.deepEqual([lengkap.incaso, lengkap.orang[0].pelunasan, lengkap.orang[0].status, lengkap.orang[0].selisih, lengkap.segarUntukTutup],
        [{ lengkap: true, sebab: null, pesan: null }, "100000.00", "selisih", "-10000.00", true]);
    assert.deepEqual(lengkap.takTeralokasi?.map((t) => [t.nomor, t.sisa, t.alasan]), [["SR/12", "5000.00", "metode_tak_dikenal"]]);
    assert.equal(lengkap.penghalangTutup?.alasan.length, 2);
    assert.match(lengkap.sidik!, /^[0-9a-f]{16}$/);
    assert.equal(lengkap.rincian?.pelunasan.length, 1);
    const sesi = bentuk(muatan(null), null);
    assert.deepEqual([sesi.incaso.sebab, sesi.orang.length, sesi.orang[0].setoran?.total, "rincian" in sesi], ["SESI_SINKRON", 1, "90000.00", false]);
});

test("jawabanGalat: galat tak dikenal -> 500 GALAT_INTERNAL tanpa pesan mentah", () => {
    const asli = console.error;
    console.error = () => undefined;
    try {
        const j = jawabanGalat(new Error("duplicate key value violates unique constraint \"x\" password=rahasia"), "[UJI]");
        assert.equal(j.http, 500);
        assert.equal(j.body.kode, "GALAT_INTERNAL");
        assert.doesNotMatch(String(j.body.error), /duplicate|rahasia/);
    } finally {
        console.error = asli;
    }
});
