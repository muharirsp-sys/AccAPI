# Pencatat Perubahan Rincian Faktur — Rencana Implementasi

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Setiap kali isi faktur INV berubah di Accurate, catat baris yang hilang/bertambah/berubah ke tabel `sales_invoice_line_change`, lengkap dengan manusia/aplikasi, jam simpan, dan status sesudah cetak.

**Architecture:** Pembanding murni (`lib/sales-invoice-change.ts`) menghitung selisih antara `raw_data` lama di cache dan jawaban `detail.do` baru. `upsertSalesInvoiceById` (`lib/sync.ts`) membaca isi lama, menimpa cache, dan menyimpan selisih dalam SATU transaksi berkunci per faktur; INSERT perubahan berada di SAVEPOINT supaya kegagalannya tidak pernah menahan cache. Webhook meneruskan `appKey` + `timestamp` amplop lewat `salesInvoiceEvents` (`lib/accurate-webhook.ts`).

**Tech Stack:** Next.js 16 route handler, TypeScript, Drizzle ORM 0.45 (node-postgres), Postgres 16, `tsx --test` (node:test).

**Spec:** [docs/superpowers/specs/2026-10-23-perubahan-rincian-faktur-design.md](../specs/2026-10-23-perubahan-rincian-faktur-design.md). Zona §3 AGENTS.md (skema + jalur sinkron): push, PR, dan merge HANYA atas persetujuan owner.

**Lokasi kerja:** worktree `D:\AccAPI\_github_clean\.claude\worktrees\perubahan-rincian-faktur`, cabang `feat/perubahan-rincian-faktur` (dari `origin/main` 081b0048). Semua perintah dijalankan dari folder itu dengan Git Bash.

---

## Peta berkas

| Berkas | Status | Tanggung jawab |
|---|---|---|
| `lib/accurate-webhook.ts` | ubah | + `salesInvoiceEvents` (id, action, appKey, savedAt per event); `flattenSalesInvoiceIds` jadi turunannya |
| `lib/accurate-webhook.test.ts` | ubah | + uji `salesInvoiceEvents` |
| `lib/sales-invoice-change.ts` | BARU | Pembanding murni: `diffInvoiceLines`, `deletedInvoiceLines`, `parseRaw`, `parsePrintedView`, tipe `ChangeContext`/`LineSnapshot`/`LineChangeRow` |
| `lib/sales-invoice-change.test.ts` | BARU | Uji pembanding murni |
| `db/schema.ts` | ubah | + tabel Drizzle `salesInvoiceLineChange` |
| `db/migrations/0037_sales_invoice_line_change.sql` | BARU | DDL tabel + indeks + hak `accapi_app` |
| `scripts/migrate-pg.mjs` | ubah | + entri `"sales_invoice_line_change"` (SQL sama dengan 0037) |
| `lib/sync.ts` | ubah | `upsertSalesInvoiceRows(rows, q)`; `upsertSalesInvoiceById(id, creds, ctx)` bertransaksi + kunci + SAVEPOINT; jalur hapus mencatat `invoice_deleted` |
| `lib/sales-invoice-change-pg.test.ts` | BARU | Uji Postgres evaluasi (titik masuk asli) |
| `app/api/webhook/accurate/route.ts` | ubah | Pakai `salesInvoiceEvents`, teruskan konteks |
| `app/api/invoice-outbox/send/route.ts` | ubah | Teruskan konteks `send` |
| `SYSTEM_MAP.md` | ubah | Baris lib baru + baris route webhook |

---

### Task 0: Siapkan worktree dan Postgres evaluasi

**Files:** tidak ada perubahan kode.

- [ ] **Step 1: Pasang dependensi di worktree** (junction ke checkout utama ditolak Turbopack; ±2 menit)

```bash
npm ci
```
Expected: selesai tanpa `ERR!`.

- [ ] **Step 2: Nyalakan Postgres evaluasi dan siapkan URL uji** (password TIDAK boleh dicetak atau di-commit)

```bash
docker start accapi-am040-pg
export AM040_DATABASE_URL="postgres://am040_test:$(grep '^AM040_PGPASSWORD=' ../modernization-am/scratch/am040.env | cut -d= -f2-)@127.0.0.1:55432/am040_push"
node -e "const {Pool}=require('pg');const p=new Pool({connectionString:process.env.AM040_DATABASE_URL});p.query('select to_regclass(\'public.sales_invoice\') si, to_regclass(\'public.invoice_outbox\') io, to_regclass(\'public.sales_profile\') sp').then(r=>{console.log(r.rows[0]);return p.end()})"
```
Expected: `{ si: 'sales_invoice', io: 'invoice_outbox', sp: 'sales_profile' }`.
Bila `docker start` gagal: Docker Desktop mati atau port 55432 dicadangkan Windows → minta owner menyalakan Docker / `net stop winnat` + `net start winnat` (Admin). JANGAN membuat ulang container. `export` hanya berlaku di shell itu: ulangi baris `export` di setiap shell baru yang menjalankan uji PG.

- [ ] **Step 3: Pastikan uji yang ada hijau sebelum mulai**

```bash
npx tsx --test lib/accurate-webhook.test.ts
```
Expected: `# pass 4`, `# fail 0`.

---

### Task 1: `salesInvoiceEvents` — amplop webhook ke event berkonteks

**Files:**
- Modify: `lib/accurate-webhook.ts` (fungsi `flattenSalesInvoiceIds`, ±baris 53-66)
- Test: `lib/accurate-webhook.test.ts`

- [ ] **Step 1: Tulis uji yang gagal**

Ubah baris import di `lib/accurate-webhook.test.ts`:

```ts
import { extractLoggedInvoiceIdsSince, flattenCustomerIds, flattenItemIds, flattenSalesInvoiceIds, salesInvoiceEvents } from "./accurate-webhook.ts";
```

Tambahkan di akhir berkas:

```ts
test("event faktur membawa appKey dan jam simpan amplopnya (timestamp = WIB)", () => {
    // Bentuk amplop nyata produksi: appKey hanya ada bila disimpan aplikasi; timestamp "dd/MM/yyyy HH:mm:ss" WIB
    // (receivedAt 05:58:34Z <-> timestamp 12:58:34, spec 2026-10-23 §2).
    const payload = [
        { type: "SALES_INVOICE", timestamp: "17/10/2026 12:58:34", data: [{ salesInvoiceId: 101, action: "WRITE" }] },
        { type: "SALES_INVOICE", timestamp: "22/10/2026 13:49:06", appKey: "APP-A",
          data: [{ salesInvoiceId: 102, action: "WRITE" }, { salesInvoiceId: 103, action: "DELETE" }] },
        { type: "CUSTOMER", data: [{ customerId: 5 }] },
    ];
    assert.deepEqual(salesInvoiceEvents(payload).map((e) => [e.id, e.action, e.appKey, e.savedAt?.toISOString()]), [
        [101, "WRITE", "", "2026-10-17T05:58:34.000Z"],
        [102, "WRITE", "APP-A", "2026-10-22T06:49:06.000Z"],
        [103, "DELETE", "APP-A", "2026-10-22T06:49:06.000Z"],
    ]);
    // Tanpa timestamp/action: savedAt null, action WRITE. Id tidak sah dilewati.
    assert.deepEqual(salesInvoiceEvents([{ type: "SALES_INVOICE", data: [{ salesInvoiceId: 7 }, { salesInvoiceId: "x" }] }])
        .map((e) => [e.id, e.action, e.savedAt]), [[7, "WRITE", null]]);
    assert.deepEqual(flattenSalesInvoiceIds(payload), [101, 102, 103]);
    assert.deepEqual(salesInvoiceEvents(null), []);
});
```

- [ ] **Step 2: Jalankan, pastikan gagal**

```bash
npx tsx --test lib/accurate-webhook.test.ts
```
Expected: FAIL — `salesInvoiceEvents` bukan fungsi (`SyntaxError`/`TypeError` ekspor tidak ada).

- [ ] **Step 3: Implementasi**

Di `lib/accurate-webhook.ts`, tambahkan import di bawah komentar kepala berkas (sebelum komentar "Bentuk payload dibuktikan live"):

```ts
import { parseAccurateDateTime } from "./accurate-invoice";
```

Ganti seluruh fungsi `flattenSalesInvoiceIds` yang lama dengan:

```ts
/** Satu event faktur dari amplop webhook. `appKey` '' = disimpan orang di layar Accurate (amplop tanpa appKey). */
export type SalesInvoiceEvent = { id: number; action: string; appKey: string; savedAt: Date | null };

/**
 * Amplop SALES_INVOICE -> satu event per baris `data`, membawa appKey dan `timestamp` amplopnya — dipakai pencatat
 * perubahan rincian (spec docs/superpowers/specs/2026-10-23-perubahan-rincian-faktur-design.md §7).
 * `timestamp` = WIB (UTC+7), sama dengan yang dibaca parseAccurateDateTime.
 */
export function salesInvoiceEvents(payload: unknown): SalesInvoiceEvent[] {
    const envelopes = (Array.isArray(payload) ? payload : [payload]) as Array<{
        type?: string; appKey?: unknown; timestamp?: unknown;
        data?: Array<{ salesInvoiceId?: unknown; action?: unknown }>;
    }>;
    const events: SalesInvoiceEvent[] = [];
    for (const envelope of envelopes) {
        if (envelope?.type !== "SALES_INVOICE") continue;
        const appKey = typeof envelope.appKey === "string" ? envelope.appKey : "";
        const savedAt = parseAccurateDateTime(envelope.timestamp);
        for (const record of envelope.data ?? []) {
            const id = Number(record?.salesInvoiceId);
            if (Number.isFinite(id) && id > 0) events.push({ id, action: String(record?.action ?? "WRITE"), appKey, savedAt });
        }
    }
    return events;
}

export function flattenSalesInvoiceIds(payload: unknown): number[] {
    return salesInvoiceEvents(payload).map((e) => e.id);
}
```

- [ ] **Step 4: Jalankan, pastikan lulus**

```bash
npx tsx --test lib/accurate-webhook.test.ts
```
Expected: `# pass 5`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add lib/accurate-webhook.ts lib/accurate-webhook.test.ts
git commit -m "feat(webhook): salesInvoiceEvents membawa appKey dan jam simpan amplop

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Pembanding murni `lib/sales-invoice-change.ts`

**Files:**
- Create: `lib/sales-invoice-change.ts`
- Test: `lib/sales-invoice-change.test.ts`

- [ ] **Step 1: Tulis uji yang gagal** — buat `lib/sales-invoice-change.test.ts`:

```ts
/* Pembanding rincian faktur (spec docs/superpowers/specs/2026-10-23-perubahan-rincian-faktur-design.md §6-7).
   Data contoh generik; bentuk mengikuti detail.do nyata (INV/2610/CS00399: baris 72 -> 6 PCS, id baris tetap). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BACKFILL, deletedInvoiceLines, diffInvoiceLines, parsePrintedView, parseRaw, type ChangeContext } from "./sales-invoice-change.ts";

const brs = (id: number | null, no: string, qty: number, o: Record<string, unknown> = {}) => ({
    id, item: { no, name: `NAMA ${no}` }, quantity: qty, itemUnit: { name: "PCS" }, unitRatio: 1, unitPrice: 4610,
    itemDiscPercent: "2", itemCashDiscount: 0, totalPrice: qty * 4610 * 0.98, warehouse: { name: "GUDANG A" },
    deliveredQuantity: 0, returnQuantity: 0, salesmanList: [{ id: 1 }], ...o,
});
const faktur = (rinci: unknown[], o: Record<string, unknown> = {}) => ({
    id: 900, number: "INV/2610/AA00001", transDate: "17/10/2026", customer: { customerNo: "C-A01-AA" }, totalAmount: 1000,
    printedTimeView: "17 Oct 2026 15:23:23", printUserName: "FAKTURIS A", detailItem: rinci, ...o,
});
// raw_data di cache = string JSON (kolom jsonb berisi string), jadi isi lama diberikan sebagai JSON.stringify(...).
const lama = (f: unknown) => JSON.stringify(f);
const WEBHOOK: ChangeContext = { source: "webhook", appKey: "", savedAt: new Date("2026-10-22T06:49:06Z") };
const KINI = new Date("2026-10-22T06:49:07Z");

test("qty berubah 72 -> 6 pada id baris yang sama: satu 'changed', delta dasar -66, sesudah cetak", () => {
    const r = diffInvoiceLines(lama(faktur([brs(11, "BARANG A", 72), brs(12, "BARANG B", 3)])),
        faktur([brs(11, "BARANG A", 6), brs(12, "BARANG B", 3)], { totalAmount: 900 }), WEBHOOK, KINI);
    assert.equal(r.length, 1);
    assert.deepEqual([r[0].kind, r[0].lineId, r[0].itemNo, r[0].itemName, r[0].oldLine?.qty, r[0].newLine?.qty, r[0].baseQtyDelta],
        ["changed", 11, "BARANG A", "NAMA BARANG A", 72, 6, -66]);
    assert.deepEqual([r[0].totalBefore, r[0].totalAfter, r[0].appKey, r[0].source, r[0].savedAt?.toISOString()],
        [1000, 900, "", "webhook", "2026-10-22T06:49:06.000Z"]);
    assert.equal(r[0].printedAt?.toISOString(), "2026-10-17T08:23:23.000Z");
    assert.deepEqual([r[0].printedBy, r[0].afterPrint, r[0].invoiceId, r[0].invoiceNumber, r[0].transDate, r[0].customerNo],
        ["FAKTURIS A", true, 900, "INV/2610/AA00001", "17/10/2026", "C-A01-AA"]);
    assert.equal(r[0].detectedAt, KINI);
});

test("baris hilang dan baris baru tercatat terpisah", () => {
    const r = diffInvoiceLines(lama(faktur([brs(11, "BARANG A", 6), brs(12, "BARANG B", 3)])),
        faktur([brs(11, "BARANG A", 6), brs(13, "BARANG C", 2)]), WEBHOOK, KINI);
    assert.deepEqual(r.map((x) => [x.kind, x.itemNo, x.baseQtyDelta]), [["removed", "BARANG B", -3], ["added", "BARANG C", 2]]);
    assert.equal(r[0].newLine, null);
    assert.equal(r[1].oldLine, null);
});

test("barang diganti pada id baris yang sama = removed barang lama + added barang baru", () => {
    const r = diffInvoiceLines(lama(faktur([brs(11, "BARANG A", 6)])), faktur([brs(11, "BARANG B", 6)]), WEBHOOK, KINI);
    assert.deepEqual(r.map((x) => [x.kind, x.itemNo, x.lineId]), [["removed", "BARANG A", 11], ["added", "BARANG B", 11]]);
});

test("satuan KRT -> PCS dengan qty dasar sama: 'changed', delta 0", () => {
    const r = diffInvoiceLines(lama(faktur([brs(11, "BARANG A", 2, { itemUnit: { name: "KRT" }, unitRatio: 36, unitPrice: 165960 })])),
        faktur([brs(11, "BARANG A", 72)]), WEBHOOK, KINI);
    assert.deepEqual(r.map((x) => [x.kind, x.oldLine?.unit, x.newLine?.unit, x.baseQtyDelta]), [["changed", "KRT", "PCS", 0]]);
});

test("hanya qty kirim/retur, salesman, atau totalPrice yang berubah: tidak ada baris", () => {
    const r = diffInvoiceLines(lama(faktur([brs(11, "BARANG A", 6)])),
        faktur([brs(11, "BARANG A", 6, { deliveredQuantity: 6, returnQuantity: 1, salesmanList: [{ id: 2 }], totalPrice: 1 })]), WEBHOOK, KINI);
    assert.deepEqual(r, []);
});

test("isi lama tanpa detailItem, cache kosong, JSON rusak, DFT, atau RJN: tidak ada baris", () => {
    const baru = faktur([brs(11, "BARANG A", 6)]);
    assert.deepEqual(diffInvoiceLines(lama({ ...faktur([]), detailItem: undefined }), baru, WEBHOOK, KINI), []);
    assert.deepEqual(diffInvoiceLines(null, baru, WEBHOOK, KINI), []);
    assert.deepEqual(diffInvoiceLines("bukan json", baru, WEBHOOK, KINI), []);
    for (const number of ["DFT.1001", "RJN/2610/AA00001"]) {
        assert.deepEqual(diffInvoiceLines(lama(faktur([brs(11, "BARANG A", 72)], { number })),
            faktur([brs(11, "BARANG A", 6)], { number }), WEBHOOK, KINI), [], number);
    }
});

test("sesudah cetak: belum dicetak -> false; dicetak sesudah simpan -> false; penambal memakai jam deteksi", () => {
    const isiLama = lama(faktur([brs(11, "BARANG A", 72)]));
    const [belum] = diffInvoiceLines(isiLama, faktur([brs(11, "BARANG A", 6)], { printedTimeView: null, printUserName: "Belum cetak/email" }), WEBHOOK, KINI);
    assert.deepEqual([belum.printedAt, belum.printedBy, belum.afterPrint], [null, "", false]);
    // Dicetak 22 Okt 14:00 WIB = 07:00Z, sesudah simpan 06:49Z.
    const [nanti] = diffInvoiceLines(isiLama, faktur([brs(11, "BARANG A", 6)], { printedTimeView: "22 Oct 2026 14:00:00" }), WEBHOOK, KINI);
    assert.equal(nanti.afterPrint, false);
    const [tambal] = diffInvoiceLines(isiLama, faktur([brs(11, "BARANG A", 6)]), BACKFILL, KINI);
    assert.deepEqual([tambal.source, tambal.appKey, tambal.savedAt, tambal.afterPrint], ["backfill", null, null, true]);
});

test("faktur dihapus: semua baris terakhir jadi invoice_deleted dengan delta negatif", () => {
    const r = deletedInvoiceLines(lama(faktur([brs(11, "BARANG A", 6), brs(12, "BARANG B", 2, { itemUnit: { name: "KRT" }, unitRatio: 12 })])),
        { source: "webhook", appKey: "", savedAt: KINI }, KINI);
    assert.deepEqual(r.map((x) => [x.kind, x.itemNo, x.baseQtyDelta, x.newLine, x.totalBefore, x.totalAfter]),
        [["invoice_deleted", "BARANG A", -6, null, 1000, null], ["invoice_deleted", "BARANG B", -24, null, 1000, null]]);
    assert.deepEqual(deletedInvoiceLines(lama(faktur([brs(11, "BARANG A", 6)], { number: "DFT.9" })), BACKFILL, KINI), []);
    assert.deepEqual(deletedInvoiceLines(null, BACKFILL, KINI), []);
});

test("rasio satuan tidak ada: delta dasar null, perubahan tetap tercatat", () => {
    const r = diffInvoiceLines(lama(faktur([brs(11, "BARANG A", 6, { unitRatio: null })])),
        faktur([brs(11, "BARANG A", 5, { unitRatio: null })]), WEBHOOK, KINI);
    assert.deepEqual(r.map((x) => [x.kind, x.baseQtyDelta]), [["changed", null]]);
});

test("baris tanpa id tidak berpasangan: removed + added walau isinya sama", () => {
    const r = diffInvoiceLines(lama(faktur([brs(null, "BARANG A", 6)])), faktur([brs(null, "BARANG A", 6)]), WEBHOOK, KINI);
    assert.deepEqual(r.map((x) => [x.kind, x.lineId]), [["removed", null], ["added", null]]);
});

test("parseRaw menerima string sekali/dua kali dienkode dan objek; parsePrintedView = WIB", () => {
    const f = { number: "INV/1" };
    assert.deepEqual(parseRaw(JSON.stringify(f)), f);
    assert.deepEqual(parseRaw(JSON.stringify(JSON.stringify(f))), f);
    assert.deepEqual(parseRaw(f), f);
    assert.equal(parseRaw("[1]"), null);
    assert.equal(parsePrintedView("17 Oct 2026 15:23:23")?.toISOString(), "2026-10-17T08:23:23.000Z");
    assert.equal(parsePrintedView("17 Okt 2026 15:23:23")?.toISOString(), "2026-10-17T08:23:23.000Z");
    assert.equal(parsePrintedView("Belum cetak/email"), null);
    assert.equal(parsePrintedView(undefined), null);
});
```

- [ ] **Step 2: Jalankan, pastikan gagal**

```bash
npx tsx --test lib/sales-invoice-change.test.ts
```
Expected: FAIL — `Cannot find module './sales-invoice-change.ts'`.

- [ ] **Step 3: Implementasi** — buat `lib/sales-invoice-change.ts`:

```ts
/*
 * Tujuan: Bandingkan dua jawaban detail.do faktur penjualan -> baris perubahan rincian (tabel sales_invoice_line_change).
 * Caller: lib/sync.ts (upsertSalesInvoiceById). Spec: docs/superpowers/specs/2026-10-23-perubahan-rincian-faktur-design.md §6-7.
 * Dependensi: tidak ada — murni, tanpa DB/jaringan.
 * Main Functions: diffInvoiceLines, deletedInvoiceLines, parseRaw, parsePrintedView.
 * Side Effects: tidak ada.
 */

export type ChangeSource = "webhook" | "backfill" | "send";
/** Asal simpan. appKey: '' = orang di layar Accurate, terisi = aplikasi, null = tidak diketahui (di luar webhook). */
export type ChangeContext = { source: ChangeSource; appKey: string | null; savedAt: Date | null };
export const BACKFILL: ChangeContext = { source: "backfill", appKey: null, savedAt: null };

export type LineSnapshot = {
    qty: number; unit: string; ratio: number | null; price: number;
    discPercent: string; discRp: number; total: number; warehouse: string;
};
export type ChangeKind = "removed" | "added" | "changed" | "invoice_deleted";
/** Satu baris tabel sales_invoice_line_change; nama kunci = nama kolom Drizzle (db/schema.ts salesInvoiceLineChange). */
export type LineChangeRow = {
    invoiceId: number; invoiceNumber: string; transDate: string; customerNo: string;
    kind: ChangeKind; lineId: number | null; itemNo: string; itemName: string;
    oldLine: LineSnapshot | null; newLine: LineSnapshot | null; baseQtyDelta: number | null;
    totalBefore: number | null; totalAfter: number | null;
    appKey: string | null; source: ChangeSource; savedAt: Date | null;
    printedAt: Date | null; printedBy: string; afterPrint: boolean; detectedAt: Date;
};

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? v as Obj : {});
const teks = (v: unknown) => String(v ?? "").trim();
const angka = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const angkaAtauNull = (v: unknown): number | null => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};

/** raw_data tersimpan sebagai STRING JSON di kolom jsonb (lib/sync.ts); terima string (sekali/dua kali dienkode), objek, atau null. */
export function parseRaw(raw: unknown): Obj | null {
    let v = raw;
    for (let i = 0; i < 2 && typeof v === "string"; i++) {
        try { v = JSON.parse(v); } catch { return null; }
    }
    return v && typeof v === "object" && !Array.isArray(v) ? v as Obj : null;
}

const BULAN: Record<string, string> = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Mei: "05", Jun: "06", Jul: "07",
    Aug: "08", Agu: "08", Sep: "09", Oct: "10", Okt: "10", Nov: "11", Dec: "12", Des: "12" };
/**
 * printedTimeView "17 Oct 2026 15:23:23" -> Date. Keluarga *View = WIB (createDateView sama dengan createDate yang cocok dengan
 * receivedAt webhook); printedTime "17/10/2026, 16:23" = WITA tanpa detik, jadi tidak dipakai. "Belum cetak/email"/kosong -> null.
 */
export function parsePrintedView(v: unknown): Date | null {
    const m = teks(v).match(/^(\d{1,2}) ([A-Za-z]{3}) (\d{4}) (\d{2}):(\d{2}):(\d{2})$/);
    const bulan = m ? BULAN[m[2][0].toUpperCase() + m[2].slice(1).toLowerCase()] : undefined;
    if (!m || !bulan) return null;
    const d = new Date(`${m[3]}-${bulan}-${m[1].padStart(2, "0")}T${m[4]}:${m[5]}:${m[6]}+07:00`);
    return Number.isNaN(d.getTime()) ? null : d;
}

function snapshot(d: Obj): LineSnapshot {
    const ratio = angkaAtauNull(d.unitRatio);
    return {
        qty: angka(d.quantity), unit: teks(obj(d.itemUnit).name), ratio: ratio !== null && ratio > 0 ? ratio : null,
        price: angka(d.unitPrice), discPercent: teks(d.itemDiscPercent), discRp: angka(d.itemCashDiscount),
        total: angka(d.totalPrice), warehouse: teks(obj(d.warehouse).name),
    };
}
const dekat = (a: number | null, b: number | null) => a === b || (a !== null && b !== null && Math.abs(a - b) <= 1e-6);
/** Kolom pembanding spec §6. totalPrice (turunan) dan qty kirim/retur/salesman sengaja tidak ikut. */
const samaBaris = (a: LineSnapshot, b: LineSnapshot) => dekat(a.qty, b.qty) && a.unit === b.unit && dekat(a.ratio, b.ratio)
    && dekat(a.price, b.price) && a.discPercent === b.discPercent && dekat(a.discRp, b.discRp) && a.warehouse === b.warehouse;
const dasar = (l: LineSnapshot | null): number | null => (l === null ? 0 : l.ratio === null ? null : l.qty * l.ratio);
function selisihDasar(lama: LineSnapshot | null, baru: LineSnapshot | null): number | null {
    const a = dasar(lama), b = dasar(baru);
    return a === null || b === null ? null : Math.round((b - a) * 1e6) / 1e6;
}

type Baris = { lineId: number | null; itemNo: string; itemName: string; snap: LineSnapshot };
/** Kunci pasangan = id baris + kode barang. Baris tanpa id diberi kunci unik per sisi supaya tidak pernah berpasangan. */
function petaBaris(rinci: unknown[], sisi: "lama" | "baru"): Map<string, Baris> {
    const peta = new Map<string, Baris>();
    rinci.forEach((v, i) => {
        const d = obj(v), barang = obj(d.item);
        const lineId = angkaAtauNull(d.id);
        const itemNo = teks(barang.no ?? d.itemNo);
        peta.set(lineId === null ? `${sisi}:tanpa-id:${i}` : `${lineId}|${itemNo}`,
            { lineId, itemNo, itemName: teks(barang.name ?? d.detailName), snap: snapshot(d) });
    });
    return peta;
}

type Kepala = Pick<LineChangeRow, "invoiceId" | "invoiceNumber" | "transDate" | "customerNo" | "printedAt" | "printedBy"> & { total: number | null };
function kepala(f: Obj): Kepala {
    const printedAt = parsePrintedView(f.printedTimeView);
    return {
        invoiceId: angka(f.id), invoiceNumber: teks(f.number), transDate: teks(f.transDate),
        customerNo: teks(obj(f.customer).customerNo ?? f.customerNo), total: angkaAtauNull(f.totalAmount),
        printedAt, printedBy: printedAt ? teks(f.printUserName) : "",
    };
}

function baris(k: Kepala, ctx: ChangeContext, now: Date, kind: ChangeKind, b: Baris, oldLine: LineSnapshot | null,
               newLine: LineSnapshot | null, totalBefore: number | null, totalAfter: number | null): LineChangeRow {
    return {
        invoiceId: k.invoiceId, invoiceNumber: k.invoiceNumber, transDate: k.transDate, customerNo: k.customerNo,
        kind, lineId: b.lineId, itemNo: b.itemNo, itemName: b.itemName, oldLine, newLine, baseQtyDelta: selisihDasar(oldLine, newLine),
        totalBefore, totalAfter, appKey: ctx.appKey, source: ctx.source, savedAt: ctx.savedAt,
        printedAt: k.printedAt, printedBy: k.printedBy, afterPrint: k.printedAt !== null && k.printedAt <= (ctx.savedAt ?? now),
        detectedAt: now,
    };
}

/** Isi lama (raw_data cache) vs jawaban detail.do baru -> baris perubahan. Kosong bila bukan INV atau salah satu tanpa detailItem. */
export function diffInvoiceLines(oldRaw: unknown, newRow: Obj, ctx: ChangeContext, now = new Date()): LineChangeRow[] {
    const lama = parseRaw(oldRaw);
    if (!lama || !Array.isArray(lama.detailItem) || !Array.isArray(newRow.detailItem)) return [];
    const k = kepala(newRow);
    if (!k.invoiceNumber.startsWith("INV/")) return [];
    const totalLama = angkaAtauNull(lama.totalAmount);
    const o = petaBaris(lama.detailItem, "lama"), n = petaBaris(newRow.detailItem, "baru");
    const hasil: LineChangeRow[] = [];
    for (const [kunci, a] of o) {
        const b = n.get(kunci);
        if (!b) hasil.push(baris(k, ctx, now, "removed", a, a.snap, null, totalLama, k.total));
        else if (!samaBaris(a.snap, b.snap)) hasil.push(baris(k, ctx, now, "changed", b, a.snap, b.snap, totalLama, k.total));
    }
    for (const [kunci, b] of n) if (!o.has(kunci)) hasil.push(baris(k, ctx, now, "added", b, null, b.snap, totalLama, k.total));
    return hasil;
}

/** Faktur dihapus di Accurate: semua baris terakhir yang diketahui -> invoice_deleted. Kosong bila bukan INV atau tanpa detailItem. */
export function deletedInvoiceLines(oldRaw: unknown, ctx: ChangeContext, now = new Date()): LineChangeRow[] {
    const lama = parseRaw(oldRaw);
    if (!lama || !Array.isArray(lama.detailItem)) return [];
    const k = kepala(lama);
    if (!k.invoiceNumber.startsWith("INV/")) return [];
    return [...petaBaris(lama.detailItem, "lama").values()]
        .map((a) => baris(k, ctx, now, "invoice_deleted", a, a.snap, null, k.total, null));
}
```

- [ ] **Step 4: Jalankan, pastikan lulus**

```bash
npx tsx --test lib/sales-invoice-change.test.ts
```
Expected: `# pass 11`, `# fail 0`.

- [ ] **Step 5: Buktikan uji menangkap kerusakan** (gerbang hijau ≠ uji berjalan)

Ubah sementara `dekat(a.qty, b.qty) &&` di `samaBaris` menjadi `true &&`, jalankan Step 4 lagi: Expected FAIL pada uji "qty berubah 72 -> 6" (dan "rasio satuan tidak ada"). Kembalikan ke `dekat(a.qty, b.qty) &&`, jalankan lagi: `# pass 11`.

- [ ] **Step 6: Commit**

```bash
git add lib/sales-invoice-change.ts lib/sales-invoice-change.test.ts
git commit -m "feat(perubahan-faktur): pembanding murni rincian faktur

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Skema — Drizzle, migrasi 0037, entri migrate-pg

**Files:**
- Modify: `db/schema.ts` (import di baris 8-9; tabel baru tepat SESUDAH blok `salesInvoiceCache` yang berakhir `index("idx_sales_invoice_synced_at")...]);`)
- Create: `db/migrations/0037_sales_invoice_line_change.sql`
- Modify: `scripts/migrate-pg.mjs` (entri baru sebelum `];` penutup array `migrations`, sesudah entri `"supervisor review (SR-1)"`)

- [ ] **Step 1: Tabel Drizzle**

Di `db/schema.ts`, tambahkan di bawah baris `import { pgTable, ... } from "drizzle-orm/pg-core";`:

```ts
import type { ChangeKind, ChangeSource, LineSnapshot } from "../lib/sales-invoice-change";
```

Tambahkan sesudah blok `salesInvoiceCache`:

```ts
// Perubahan rincian faktur INV yang terlihat saat cache faktur diperbarui (owner 23 Okt 2026; spec
// docs/superpowers/specs/2026-10-23-perubahan-rincian-faktur-design.md §4). Satu baris per baris faktur yang hilang/bertambah/
// berubah/ikut faktur yang dihapus; diisi lib/sync.ts upsertSalesInvoiceById. Tanpa FK ke sales_invoice: faktur yang dihapus tetap
// tercatat. DDL: db/migrations/0037_sales_invoice_line_change.sql (= entri migrate-pg "sales_invoice_line_change").
export const salesInvoiceLineChange = pgTable("sales_invoice_line_change", {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    invoiceId: bigint("invoice_id", { mode: "number" }).notNull(),
    invoiceNumber: text("invoice_number").notNull(),
    transDate: text("trans_date").notNull(),
    customerNo: text("customer_no").notNull().default(""),
    kind: text("kind").$type<ChangeKind>().notNull(),
    lineId: bigint("line_id", { mode: "number" }),
    itemNo: text("item_no").notNull(),
    itemName: text("item_name").notNull().default(""),
    oldLine: jsonb("old_line").$type<LineSnapshot>(),
    newLine: jsonb("new_line").$type<LineSnapshot>(),
    // qty×rasio baru − lama; negatif = stok Accurate naik. NULL bila rasio satuan tidak ada.
    baseQtyDelta: numeric("base_qty_delta", { mode: "number" }),
    totalBefore: numeric("total_before", { precision: 18, scale: 2, mode: "number" }),
    totalAfter: numeric("total_after", { precision: 18, scale: 2, mode: "number" }),
    // '' = orang di layar Accurate; terisi = aplikasi (70a5d9f9… = AccAPI); NULL = tidak diketahui (penambal, kirim faktur).
    appKey: text("app_key"),
    source: text("source").$type<ChangeSource>().notNull(),
    savedAt: timestamp("saved_at", { withTimezone: true }),
    printedAt: timestamp("printed_at", { withTimezone: true }),
    printedBy: text("printed_by").notNull().default(""),
    afterPrint: boolean("after_print").notNull(),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
    index("idx_silc_item_no").on(t.itemNo, t.detectedAt),
    index("idx_silc_invoice_id").on(t.invoiceId),
    check("sales_invoice_line_change_kind", sql`${t.kind} IN ('removed', 'added', 'changed', 'invoice_deleted')`),
    check("sales_invoice_line_change_source", sql`${t.source} IN ('webhook', 'backfill', 'send')`),
]);
```

- [ ] **Step 2: Berkas migrasi** — buat `db/migrations/0037_sales_invoice_line_change.sql`:

```sql
-- =====================================================================
-- Perubahan rincian faktur INV (owner 23 Okt 2026; spec docs/superpowers/specs/2026-10-23-perubahan-rincian-faktur-design.md §4).
--
-- Satu baris per baris faktur yang hilang / bertambah / berubah / ikut faktur yang dihapus, dicatat lib/sync.ts
-- (upsertSalesInvoiceById) saat cache faktur diperbarui lewat webhook, penambal, atau kirim faktur. Tanpa FK ke
-- sales_invoice: faktur yang dihapus di Accurate tetap tercatat.
--
-- EXPAND saja: tabel baru tanpa pembaca lama, tidak menyentuh tabel lain. Idempoten.
-- Apply otomatis lewat scripts/migrate-pg.mjs (entri "sales_invoice_line_change") saat container start bila
-- DATABASE_MIGRATION_URL terpasang (produksi: terpasang). Manual:
--   docker exec -i accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 --single-transaction \
--     < db/migrations/0037_sales_invoice_line_change.sql
-- =====================================================================

CREATE TABLE IF NOT EXISTS sales_invoice_line_change (
    id              bigserial     PRIMARY KEY,
    invoice_id      bigint        NOT NULL,
    invoice_number  text          NOT NULL,
    trans_date      text          NOT NULL,
    customer_no     text          NOT NULL DEFAULT '',
    kind            text          NOT NULL,
    line_id         bigint,
    item_no         text          NOT NULL,
    item_name       text          NOT NULL DEFAULT '',
    old_line        jsonb,
    new_line        jsonb,
    base_qty_delta  numeric,
    total_before    numeric(18,2),
    total_after     numeric(18,2),
    app_key         text,
    source          text          NOT NULL,
    saved_at        timestamptz,
    printed_at      timestamptz,
    printed_by      text          NOT NULL DEFAULT '',
    after_print     boolean       NOT NULL,
    detected_at     timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT sales_invoice_line_change_kind CHECK (kind IN ('removed', 'added', 'changed', 'invoice_deleted')),
    CONSTRAINT sales_invoice_line_change_source CHECK (source IN ('webhook', 'backfill', 'send'))
);
CREATE INDEX IF NOT EXISTS idx_silc_item_no ON sales_invoice_line_change (item_no, detected_at);
CREATE INDEX IF NOT EXISTS idx_silc_invoice_id ON sales_invoice_line_change (invoice_id);
DO $silc$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app') THEN
    GRANT SELECT, INSERT ON sales_invoice_line_change TO accapi_app;
    GRANT USAGE ON SEQUENCE sales_invoice_line_change_id_seq TO accapi_app;
  END IF;
END $silc$;
```

- [ ] **Step 3: Entri migrate-pg** — di `scripts/migrate-pg.mjs`, tambahkan objek ini sebagai elemen TERAKHIR array `migrations` (sesudah `}` penutup entri `"supervisor review (SR-1)"`, sebelum `];`):

```js
  {
    // 2026-10-23 (pencatat perubahan rincian faktur; zona §3 skema + jalur sinkron — butuh review manusia). Tabel BARU saja (EXPAND,
    // tanpa pembaca lama). SQL = db/migrations/0037_sales_invoice_line_change.sql (lib/sales-invoice-change-pg.test.ts membandingkan
    // katalog entri ini dengan berkas itu dan Drizzle). sudahAda lewat katalog (pg_indexes), bukan information_schema. Hak accapi_app
    // (SELECT/INSERT + sequence) ikut di sini bila role ada. Produksi PUNYA DATABASE_MIGRATION_URL: entri ini yang menerapkan.
    nama: "sales_invoice_line_change",
    sudahAda: `SELECT 1 FROM pg_indexes WHERE schemaname = current_schema()
               AND indexname IN ('idx_silc_item_no', 'idx_silc_invoice_id') HAVING count(*) = 2`,
    sql: `
      CREATE TABLE IF NOT EXISTS sales_invoice_line_change (
          id              bigserial     PRIMARY KEY,
          invoice_id      bigint        NOT NULL,
          invoice_number  text          NOT NULL,
          trans_date      text          NOT NULL,
          customer_no     text          NOT NULL DEFAULT '',
          kind            text          NOT NULL,
          line_id         bigint,
          item_no         text          NOT NULL,
          item_name       text          NOT NULL DEFAULT '',
          old_line        jsonb,
          new_line        jsonb,
          base_qty_delta  numeric,
          total_before    numeric(18,2),
          total_after     numeric(18,2),
          app_key         text,
          source          text          NOT NULL,
          saved_at        timestamptz,
          printed_at      timestamptz,
          printed_by      text          NOT NULL DEFAULT '',
          after_print     boolean       NOT NULL,
          detected_at     timestamptz   NOT NULL DEFAULT now(),
          CONSTRAINT sales_invoice_line_change_kind CHECK (kind IN ('removed', 'added', 'changed', 'invoice_deleted')),
          CONSTRAINT sales_invoice_line_change_source CHECK (source IN ('webhook', 'backfill', 'send'))
      );
      CREATE INDEX IF NOT EXISTS idx_silc_item_no ON sales_invoice_line_change (item_no, detected_at);
      CREATE INDEX IF NOT EXISTS idx_silc_invoice_id ON sales_invoice_line_change (invoice_id);
      DO $silc$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app') THEN
          GRANT SELECT, INSERT ON sales_invoice_line_change TO accapi_app;
          GRANT USAGE ON SEQUENCE sales_invoice_line_change_id_seq TO accapi_app;
        END IF;
      END $silc$;
    `,
  },
```

- [ ] **Step 4: Periksa tipe**

```bash
npx tsc --noEmit
```
Expected: keluar 0 tanpa pesan. (Tabel belum dipakai; kesetaraan DDL dibuktikan di Task 4 Step 1.)

- [ ] **Step 5: Commit**

```bash
git add db/schema.ts db/migrations/0037_sales_invoice_line_change.sql scripts/migrate-pg.mjs
git commit -m "feat(perubahan-faktur): tabel sales_invoice_line_change (0037 + migrate-pg + Drizzle)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `upsertSalesInvoiceById` mencatat perubahan (transaksi + kunci + SAVEPOINT)

**Files:**
- Test: `lib/sales-invoice-change-pg.test.ts` (BARU)
- Modify: `lib/sync.ts` (import baris 9-17; blok `sales_invoice.upsertPage` ±baris 427-490; `upsertSalesInvoiceById` ±baris 589-630)

- [ ] **Step 1: Tulis uji PG yang gagal** — buat `lib/sales-invoice-change-pg.test.ts`:

```ts
/* Pencatat perubahan rincian faktur (spec docs/superpowers/specs/2026-10-23-perubahan-rincian-faktur-design.md §8, §10) di Postgres
 * EVALUASI (AM040_DATABASE_URL, bukan produksi): SKEMA SEKALI-PAKAI (sales_invoice/invoice_outbox/sales_profile disalin `LIKE public.*`
 * + db/migrations/0036 + 0037, search_path hanya skema itu, DROP di akhir). Accurate dipalsukan lewat globalThis.fetch; titik masuk ASLI
 * lib/sync.ts upsertSalesInvoiceById. Dibuktikan: koreksi tercatat sekali (pengiriman ulang tidak menambah), tabel perubahan hilang ->
 * cache tetap diperbarui, faktur tiada -> invoice_deleted + cache dibuang, dua panggilan serentak tidak ganda, 0037 = migrate-pg =
 * Drizzle dan idempoten. Data contoh generik. Tanpa env dilewati. */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { getTableConfig } from "drizzle-orm/pg-core";
import { salesInvoiceLineChange } from "../db/schema.ts";

const PG_URL = process.env.AM040_DATABASE_URL ?? "";
const pgSkip = PG_URL ? false : "AM040_DATABASE_URL tidak di-set (Postgres evaluasi lokal AM-040)";
const TABEL = ["sales_invoice", "invoice_outbox", "sales_profile"];
const skema = `uji_silc_${randomUUID().slice(0, 8)}`;
const skemaLain: string[] = [];
const DB_FAKTUR = "db-uji-silc";
const CREDS = { databaseId: DB_FAKTUR, sessionHost: "http://accurate.uji", sessionId: "s", apiKey: "k" };
let admin: Pool;
let pool: Pool;
const urlSkema = (s = skema) => { const u = new URL(PG_URL); u.searchParams.set("options", `-c search_path=${s}`); return u.toString(); };
const berkas = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");

async function muat() {
    return { dbMod: await import("./db.ts"), sync: await import("./sync.ts") };
}
let m: Awaited<ReturnType<typeof muat>>;

const fetchAsli = globalThis.fetch;
/** Accurate palsu: setiap detail.do dijawab `jawaban`. */
function palsukan(jawaban: unknown) {
    globalThis.fetch = (async () => new Response(JSON.stringify(jawaban),
        { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
}
const brs = (id: number, no: string, qty: number) => ({ id, item: { no, name: `NAMA ${no}` }, quantity: qty, itemUnit: { name: "PCS" },
    unitRatio: 1, unitPrice: 4610, itemDiscPercent: "", itemCashDiscount: 0, totalPrice: qty * 4610, warehouse: { name: "GUDANG A" } });
const FAKTUR = (id: number, qtyA: number) => ({ id, number: `INV/2610/AA${id}`, transDate: "17/10/2026",
    customer: { customerNo: "C-A01-AA", name: "TOKO A" }, totalAmount: qtyA * 4610 + 13830, primeOwing: 0, statusName: "Belum Lunas",
    printedTimeView: "17 Oct 2026 15:23:23", printUserName: "FAKTURIS A", createDate: "17/10/2026 12:58:32",
    detailItem: [brs(id * 10 + 1, "BARANG A", qtyA), brs(id * 10 + 2, "BARANG B", 3)] });
const WEBHOOK = { source: "webhook" as const, appKey: "", savedAt: new Date("2026-10-22T06:49:06Z") };
async function simpan(f: ReturnType<typeof FAKTUR>) {
    palsukan({ s: true, d: f });
    try { await m.sync.upsertSalesInvoiceById(f.id, CREDS, WEBHOOK); } finally { globalThis.fetch = fetchAsli; }
}
const perubahan = async (id: number) => (await pool.query(`SELECT kind, item_no, (old_line->>'qty')::float AS lama,
    (new_line->>'qty')::float AS baru, base_qty_delta::float AS delta, app_key, source, after_print
    FROM sales_invoice_line_change WHERE invoice_id = $1 ORDER BY id`, [id])).rows;
const totalCache = async (id: number) => (await pool.query(`SELECT total_amount::float AS t FROM sales_invoice WHERE id = $1`, [id])).rows[0]?.t;

before(async () => {
    if (!PG_URL) return;
    admin = new Pool({ connectionString: PG_URL, max: 1 });
    await admin.query(`CREATE SCHEMA ${skema}`);
    for (const t of TABEL) await admin.query(`CREATE TABLE ${skema}."${t}" (LIKE public."${t}" INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)`);
    pool = new Pool({ connectionString: urlSkema(), max: 3 });
    // 0036 = kolom ringkas Supervisor Review yang ditulis upsert faktur (idempoten bila public sudah punya).
    await pool.query(await berkas("../db/migrations/0036_supervisor_review.sql"));
    await pool.query(await berkas("../db/migrations/0037_sales_invoice_line_change.sql"));
    process.env.DATABASE_URL = urlSkema();
    process.env.ACCURATE_INVOICE_DB_ID = DB_FAKTUR;
    m = await muat();
});

after(async () => {
    if (!PG_URL) return;
    globalThis.fetch = fetchAsli;
    await pool?.end();
    await m?.dbMod.pool.end();
    for (const s of [skema, ...skemaLain]) await admin.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
    await admin.end();
});

test("PG koreksi qty tercatat sekali; pengiriman ulang dengan isi sama tidak menambah baris", { skip: pgSkip }, async () => {
    await simpan(FAKTUR(101, 72)); // pertama kali terbaca: belum ada isi lama -> tidak ada baris
    assert.deepEqual(await perubahan(101), []);
    await simpan(FAKTUR(101, 6));
    await simpan(FAKTUR(101, 6));
    assert.deepEqual(await perubahan(101), [
        { kind: "changed", item_no: "BARANG A", lama: 72, baru: 6, delta: -66, app_key: "", source: "webhook", after_print: true },
    ]);
    assert.equal(await totalCache(101), 6 * 4610 + 13830);
});

test("PG tabel perubahan tidak ada -> cache tetap diperbarui dan tidak melempar", { skip: pgSkip }, async () => {
    await simpan(FAKTUR(102, 10));
    await pool.query(`ALTER TABLE sales_invoice_line_change RENAME TO silc_sementara`);
    try {
        await simpan(FAKTUR(102, 4));
        assert.equal(await totalCache(102), 4 * 4610 + 13830);
    } finally {
        await pool.query(`ALTER TABLE silc_sementara RENAME TO sales_invoice_line_change`);
    }
    assert.deepEqual(await perubahan(102), []);
});

test("PG faktur tiada di Accurate -> invoice_deleted dicatat dan cache dibuang", { skip: pgSkip }, async () => {
    await simpan(FAKTUR(103, 5));
    palsukan({ s: true }); // detail.do s:true tanpa d = faktur sudah dihapus (lib/sync.ts fakturSudahTiada)
    try {
        await assert.rejects(m.sync.upsertSalesInvoiceById(103, CREDS, WEBHOOK), { name: "AccurateInvoiceGoneError" });
    } finally { globalThis.fetch = fetchAsli; }
    assert.deepEqual((await perubahan(103)).map((r) => [r.kind, r.item_no, r.delta]),
        [["invoice_deleted", "BARANG A", -5], ["invoice_deleted", "BARANG B", -3]]);
    assert.equal(await totalCache(103), undefined);
});

test("PG dua webhook serentak untuk faktur yang sama tidak mencatat ganda", { skip: pgSkip }, async () => {
    await simpan(FAKTUR(104, 72));
    palsukan({ s: true, d: FAKTUR(104, 6) });
    try {
        await Promise.all([m.sync.upsertSalesInvoiceById(104, CREDS, WEBHOOK), m.sync.upsertSalesInvoiceById(104, CREDS, WEBHOOK)]);
    } finally { globalThis.fetch = fetchAsli; }
    assert.equal((await perubahan(104)).length, 1);
});

test("PG 0037 = entri migrate-pg = Drizzle; idempoten; migrate-pg jalan lalu SKIP", { skip: pgSkip }, async () => {
    const { migrations } = await import(new URL("../scripts/migrate-pg.mjs", import.meta.url).href) as
        { migrations: { nama: string; sudahAda: string; sql: string }[] };
    const entri = migrations.find((x) => x.nama === "sales_invoice_line_change");
    assert.ok(entri, "entri migrate-pg");
    const kolom = async (p: Pool) => (await p.query(`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'sales_invoice_line_change'`)).rows
        .map((r) => `${r.column_name}|${r.data_type}|${r.is_nullable}|${String(r.column_default).replace(/uji_silc_m?_?[0-9a-f]{8}\./g, "")}`).sort();
    const indeks = async (p: Pool) => (await p.query(`SELECT indexname, regexp_replace(indexdef, ' ON \\S+ ', ' ON t ') AS def FROM pg_indexes
        WHERE schemaname = current_schema() AND tablename = 'sales_invoice_line_change'`)).rows.map((r) => r.def).sort();
    const s2 = `uji_silc_m_${randomUUID().slice(0, 8)}`;
    skemaLain.push(s2);
    await admin.query(`CREATE SCHEMA ${s2}`);
    const p2 = new Pool({ connectionString: urlSkema(s2), max: 1 });
    try {
        assert.equal((await p2.query(entri.sudahAda)).rowCount, 0, "skema kosong -> migrate-pg menjalankan entri");
        await p2.query(entri.sql);
        assert.equal((await p2.query(entri.sudahAda)).rowCount, 1, "sesudahnya SKIP");
        await pool.query(await berkas("../db/migrations/0037_sales_invoice_line_change.sql")); // kali kedua di skema uji: idempoten
        assert.deepEqual(await kolom(p2), await kolom(pool), "kolom migrate-pg = berkas 0037");
        assert.deepEqual(await indeks(p2), await indeks(pool), "indeks migrate-pg = berkas 0037");
        const cfg = getTableConfig(salesInvoiceLineChange);
        assert.deepEqual(cfg.columns.map((c) => c.name).sort(), (await kolom(pool)).map((k) => k.split("|")[0]).sort(), "Drizzle = 0037 (kolom)");
        assert.deepEqual(cfg.indexes.map((i) => i.config.name).sort(), ["idx_silc_invoice_id", "idx_silc_item_no"]);
        assert.deepEqual(cfg.checks.map((c) => c.name).sort(), (await pool.query(`SELECT conname FROM pg_constraint
            WHERE conrelid = 'sales_invoice_line_change'::regclass AND contype = 'c'`)).rows.map((r) => r.conname).sort(), "Drizzle = 0037 (CHECK)");
    } finally {
        await p2.end();
    }
});
```

- [ ] **Step 2: Jalankan, pastikan gagal**

```bash
npx tsx --test lib/sales-invoice-change-pg.test.ts
```
Expected: uji "migrate-pg" LULUS (Task 3 sudah ada); uji 1, 3, 4 GAGAL (tidak ada baris perubahan: `[]` vs 1 baris); uji 2 lulus. Bila SEMUA dilaporkan `# skipped`: `AM040_DATABASE_URL` belum di-`export` di shell ini (Task 0 Step 2) — jangan lanjut sebelum uji benar-benar jalan.

- [ ] **Step 3: Implementasi di `lib/sync.ts`**

3a. Import — ubah baris import skema dan tambah import pembanding:

```ts
import { syncState, branch, accurateAutoNumber, accurateUnit, accurateEmployee, item, customer, salesInvoiceCache, salesReturnCache, salesInvoiceLineChange } from "../db/schema";
```
```ts
import { BACKFILL, deletedInvoiceLines, diffInvoiceLines, type ChangeContext, type LineChangeRow } from "./sales-invoice-change";
```

Tambahkan di bawah `const delay = ...`:

```ts
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
```

3b. Badan `sales_invoice.upsertPage` dipindah ke fungsi bernama yang bisa memakai transaksi pemanggil. Tepat SEBELUM baris `const SYNC_MODULES: Record<SyncModuleName, {`, tambahkan fungsi ini (isinya = badan lama apa adanya; satu-satunya perubahan `db.insert` → `q.insert`):

```ts
/**
 * Upsert baris faktur (list.do cron atau detail.do webhook) ke cache sales_invoice. `q` = transaksi pemanggil bila ada: jalur
 * webhook membaca isi lama, menimpa, dan mencatat perubahan rincian dalam satu transaksi (spec 2026-10-23 §5).
 */
async function upsertSalesInvoiceRows(rows: Array<Record<string, unknown>>, q: Pick<typeof db, "insert"> = db) {
    const payloads = rows.map((row) => ({
        // Supervisor Review (spec 2026-10-16 §3.2): salesman header, Σ qty satuan terkecil, jumlah baris, Σ DPP. list.do tanpa
        // detailItem -> semuanya null -> penjaga di set{} mempertahankan ringkasan dari detail.do.
        ...ringkasFaktur(row),
        id: Number(row.id),
        number: str(row.number ?? row.no),
        transDate: str(row.transDate),
        customerNo: str(nested(row, "customer").customerNo ?? row.customerNo),
        customerName: str(nested(row, "customer").name),
        totalAmount: num(row.totalAmount),
        outstanding: num(row.primeOwing),
        status: str(row.statusName),
        dueDate: str(row.dueDate),
        age: num(row.age),
        rawData: JSON.stringify(row),
        lastUpdate: str(row.lastUpdate) ?? new Date().toISOString(),
        lastUpdateAt: parseAccurateDateTime(row.lastUpdate),
        // createDate hanya dikirim detail.do (jalur webhook). Dari list.do nilainya null —
        // COALESCE di set{} menjaga agar cron tidak menghapus yang sudah benar.
        createdAt: parseAccurateDateTime(row.createDate),
    }));
    await q.insert(salesInvoiceCache).values(payloads).onConflictDoUpdate({
        target: salesInvoiceCache.id,
        set: {
            number: sql`excluded."number"`,
            transDate: sql`excluded."trans_date"`,
            customerNo: sql`excluded."customer_no"`,
            customerName: sql`excluded."customer_name"`,
            totalAmount: sql`excluded."total_amount"`,
            outstanding: sql`excluded."outstanding"`,
            status: sql`excluded."status"`,
            dueDate: sql`excluded."due_date"`,
            age: sql`excluded."age"`,
            // JANGAN menimpa rincian baris dengan jawaban yang tidak punya rincian.
            // `list.do` (cron) tidak mengirim `detailItem`; `detail.do` (webhook) iya.
            // Tanpa penjagaan ini, sync terjadwal menghapus satu-satunya salinan baris
            // faktur yang dipakai Rekap Promo DAN verifikasi balik (butir 4.30) — dan
            // keduanya lalu melaporkan "tidak ada apa-apa" dengan nada meyakinkan.
            // ponytail: cocokkan teksnya, karena raw_data tersimpan sebagai STRING JSON
            // di kolom jsonb sehingga operator `?` tidak bisa dipakai. Kalau suatu saat
            // penyimpanannya diperbaiki jadi objek, ganti dengan `raw_data ? 'detailItem'`.
            rawData: sql`case when excluded."raw_data"::text like '%detailItem%'
                               or sales_invoice.raw_data::text not like '%detailItem%'
                          then excluded."raw_data" else sales_invoice.raw_data end`,
            lastUpdate: sql`excluded."last_update"`,
            // COALESCE: kalau Accurate tidak mengirim lastUpdate di satu panggilan,
            // jangan hapus nilai yang sudah benar (pelajaran dari raw_data yang tertimpa).
            lastUpdateAt: sql`coalesce(excluded."last_update_at", sales_invoice.last_update_at)`,
            createdAt: sql`coalesce(excluded."created_at", sales_invoice.created_at)`,
            // Ringkasan Supervisor Review mengikuti aturan raw_data di atas: jawaban TANPA rincian (list.do -> null) tidak
            // mengosongkan; jawaban BER-rincian (qty_total terisi) menang utuh — termasuk salesman yang dikosongkan di Accurate,
            // yang dengan coalesce polos akan tertinggal salesman lama.
            salesmanId: sql`case when excluded."qty_total" is not null then excluded."salesman_id" else sales_invoice.salesman_id end`,
            qtyTotal: sql`coalesce(excluded."qty_total", sales_invoice.qty_total)`,
            jumlahItem: sql`coalesce(excluded."jumlah_item", sales_invoice.jumlah_item)`,
            dpp: sql`coalesce(excluded."dpp", sales_invoice.dpp)`,
            syncedAt: bumpSyncedAt("sales_invoice"),
        },
    });
}
```

Lalu di entri `sales_invoice` dalam `SYNC_MODULES`, ganti SELURUH `upsertPage: async (rows) => { ... },` (badan lama yang barusan disalin) dengan satu baris:

```ts
        upsertPage: (rows) => upsertSalesInvoiceRows(rows),
```

Komentar panjang di atas `fields:` (verifikasi live 2026-07-28/08-19) tetap di tempatnya. Pastikan dengan `git diff lib/sync.ts` bahwa badan yang dipindah sama persis dengan aslinya kecuali `db.insert` → `q.insert` (indentasi boleh berubah).

3c. Tambahkan dua helper tepat SEBELUM `export async function upsertSalesInvoiceById`:

```ts
/** Kunci per faktur di dalam transaksi: dua event untuk faktur yang sama tidak membaca isi lama yang sama (spec 2026-10-23 §8). */
const kunciFaktur = (tx: Tx, id: number) =>
    tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`sales_invoice:${id}`}, 0))`);

/**
 * Simpan baris perubahan rincian di SAVEPOINT (drizzle tx.transaction bersarang). Gagal (tabel belum ada karena migrasi belum jalan,
 * data aneh) TIDAK membatalkan upsert cache di transaksi yang sama: pencatatan tidak boleh menahan faktur (spec 2026-10-23 §8).
 */
async function catatPerubahan(tx: Tx, id: number, hitung: () => LineChangeRow[]) {
    let baris: LineChangeRow[];
    try {
        baris = hitung();
    } catch (e) {
        console.error(`[perubahan-faktur] ${id}: pembanding gagal, tidak dicatat: ${e instanceof Error ? e.message : e}`);
        return;
    }
    if (!baris.length) return;
    try {
        await tx.transaction(async (sp) => { await sp.insert(salesInvoiceLineChange).values(baris); });
        console.log(`[perubahan-faktur] ${baris[0].invoiceNumber}: ${baris.length} baris (${[...new Set(baris.map((b) => b.kind))].join(", ")})`);
    } catch (e) {
        console.error(`[perubahan-faktur] ${id}: gagal dicatat, cache tetap diperbarui: ${e instanceof Error ? e.message : e}`);
    }
}
```

3d. Ubah `upsertSalesInvoiceById`:

Tanda tangan:

```ts
export async function upsertSalesInvoiceById(id: number, creds: AccurateCredentials, ctx: ChangeContext = BACKFILL) {
```

Di cabang hapus, ganti dua baris

```ts
            const dibuang = await db.delete(salesInvoiceCache).where(eq(salesInvoiceCache.id, id))
                .returning({ number: salesInvoiceCache.number, outstanding: salesInvoiceCache.outstanding });
```

dengan:

```ts
            // Isi terakhir faktur dicatat (invoice_deleted) di transaksi yang sama sebelum barisnya dibuang (spec 2026-10-23 §5).
            const dibuang = await db.transaction(async (tx) => {
                await kunciFaktur(tx, id);
                const hapus = await tx.delete(salesInvoiceCache).where(eq(salesInvoiceCache.id, id))
                    .returning({ number: salesInvoiceCache.number, outstanding: salesInvoiceCache.outstanding, raw: salesInvoiceCache.rawData });
                if (hapus.length) await catatPerubahan(tx, id, () => deletedInvoiceLines(hapus[0].raw, ctx));
                return hapus;
            });
```

(baris `if (dibuang.length) console.log(...)` sesudahnya tidak berubah.)

Di jalur normal, ganti

```ts
    const row = body.d as Record<string, unknown>;
    await SYNC_MODULES.sales_invoice.upsertPage([row]);
```

dengan:

```ts
    const row = body.d as Record<string, unknown>;
    // Isi lama dibaca, cache ditimpa, dan selisih baris dicatat dalam SATU transaksi berkunci per faktur (spec 2026-10-23 §5, §8).
    await db.transaction(async (tx) => {
        await kunciFaktur(tx, id);
        const [lama] = await tx.select({ raw: salesInvoiceCache.rawData }).from(salesInvoiceCache)
            .where(eq(salesInvoiceCache.id, id)).limit(1);
        await upsertSalesInvoiceRows([row], tx);
        if (lama) await catatPerubahan(tx, id, () => diffInvoiceLines(lama.raw, row, ctx));
    });
```

- [ ] **Step 4: Periksa tipe**

```bash
npx tsc --noEmit
```
Expected: keluar 0. Bila `Pick<typeof db, "insert">` ditolak untuk `tx` (pesan "not assignable"), ganti tipe parameter `q` menjadi `typeof db | Tx` dan jalankan lagi.

- [ ] **Step 5: Jalankan uji PG, pastikan lulus**

```bash
npx tsx --test lib/sales-invoice-change-pg.test.ts
```
Expected: `# pass 5`, `# fail 0`, `# skipped 0`. Di log terlihat `[perubahan-faktur] INV/2610/AA101: 1 baris (changed)` dan, untuk uji tabel hilang, `[perubahan-faktur] 102: gagal dicatat, cache tetap diperbarui: ...`.

- [ ] **Step 6: Buktikan uji serentak menangkap tanpa kunci**

Ubah sementara badan `kunciFaktur` menjadi `tx.execute(sql\`SELECT 1\`)`, jalankan Step 5: Expected uji "dua webhook serentak" GAGAL (`2 !== 1`). Kembalikan, jalankan lagi: `# pass 5`. Bila uji itu TETAP lulus tanpa kunci (balapan tidak terpicu), catat di laporan tugas — uji itu belum membuktikan kunci — dan lanjutkan; JANGAN melemahkan kode.

- [ ] **Step 7: Jalankan uji Supervisor Review (pemakai lama `upsertSalesInvoiceById` 2-argumen)**

```bash
npx tsx --test lib/supervisor-review/supervisor-review-pg.test.ts
```
Expected: `# fail 0`, `# skipped 0`.

- [ ] **Step 8: Commit**

```bash
git add lib/sync.ts lib/sales-invoice-change-pg.test.ts
git commit -m "feat(perubahan-faktur): catat selisih rincian saat cache faktur diperbarui

Transaksi berkunci per faktur: baca raw_data lama, upsert, INSERT perubahan di
SAVEPOINT (gagal tidak menahan cache). Faktur tiada -> invoice_deleted.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Teruskan konteks dari webhook dan kirim faktur

**Files:**
- Modify: `app/api/webhook/accurate/route.ts` (baris 15, 66-71, 89-91)
- Modify: `app/api/invoice-outbox/send/route.ts` (panggilan `upsertSalesInvoiceById` ±baris 95)

- [ ] **Step 1: Route webhook**

Baris 15 menjadi:

```ts
import { flattenCustomerIds, flattenItemIds, salesInvoiceEvents } from '@/lib/accurate-webhook';
```

Ganti

```ts
        const invoiceIds = flattenSalesInvoiceIds(payload);
```

dengan

```ts
        const invoiceEvents = salesInvoiceEvents(payload);
```

dan pada dua baris sesudahnya ganti `invoiceIds.length` menjadi `invoiceEvents.length` (log `>> ... faktur` dan kondisi `=== 0`).

Ganti kepala perulangan dan panggilan:

```ts
        for (const id of invoiceIds) {
            try {
                const summary = await upsertSalesInvoiceById(id, accurate.creds);
```

dengan

```ts
        for (const { id, appKey, savedAt } of invoiceEvents) {
            try {
                // appKey/timestamp amplop = siapa dan kapan faktur disimpan, untuk pencatat perubahan rincian (spec 2026-10-23 §7).
                const summary = await upsertSalesInvoiceById(id, accurate.creds, { source: "webhook", appKey, savedAt });
```

- [ ] **Step 2: Route kirim faktur** — ganti

```ts
            await upsertSalesInvoiceById(Number(row.accurateId), {
                databaseId: targetDb, sessionHost: session.sessionHost,
                sessionId: session.sessionId, apiKey: session.accessToken,
            });
```

dengan

```ts
            await upsertSalesInvoiceById(Number(row.accurateId), {
                databaseId: targetDb, sessionHost: session.sessionHost,
                sessionId: session.sessionId, apiKey: session.accessToken,
            }, { source: "send", appKey: null, savedAt: null });
```

- [ ] **Step 3: Periksa tipe dan lint berkas yang disentuh**

```bash
npx tsc --noEmit
npx eslint app/api/webhook/accurate/route.ts app/api/invoice-outbox/send/route.ts lib/sync.ts lib/accurate-webhook.ts lib/sales-invoice-change.ts lib/sales-invoice-change.test.ts lib/sales-invoice-change-pg.test.ts db/schema.ts scripts/migrate-pg.mjs
```
Expected: keduanya keluar 0 (warning lama boleh, error 0).

- [ ] **Step 4: Commit**

```bash
git add app/api/webhook/accurate/route.ts app/api/invoice-outbox/send/route.ts
git commit -m "feat(perubahan-faktur): webhook dan kirim faktur meneruskan asal simpan

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: SYSTEM_MAP.md

**Files:** Modify: `SYSTEM_MAP.md` (tabel lib, sesudah baris `lib/supervisor-review/...`; tabel route baris `app/api/webhook/accurate/route.ts`)

- [ ] **Step 1: Baris lib baru** — sisipkan tepat sesudah baris tabel yang diawali `` | `lib/supervisor-review/{kontrak,ringkas-faktur,ringkasan,db}.ts` ``:

```markdown
| `lib/sales-invoice-change.ts` + tabel `sales_invoice_line_change` (0037) (pencatat perubahan rincian faktur, owner 23 Okt 2026; spec `docs/superpowers/specs/2026-10-23-perubahan-rincian-faktur-design.md`; zona §3 skema + sinkron) | `diffInvoiceLines`, `deletedInvoiceLines` (murni), `parsePrintedView` | `lib/sync.ts upsertSalesInvoiceById(id, creds, ctx)` (webhook / webhook-backfill / invoice-outbox/send) dalam SATU transaksi `pg_advisory_xact_lock(hashtextextended('sales_invoice:'||id,0))`: baca `raw_data` lama -> upsert -> INSERT selisih baris INV (kunci id baris + kode barang; `removed`/`added`/`changed`, faktur tiada -> `invoice_deleted`) di SAVEPOINT (gagal = log `[perubahan-faktur]`, cache tetap). `app_key` dari amplop webhook (`''` = orang di layar Accurate, NULL = penambal/kirim), `saved_at` = `timestamp` amplop (WIB), `printed_at` = `printedTimeView` (WIB), `base_qty_delta` = qty×rasio baru − lama (negatif = stok Accurate naik). Kolom pembanding: qty, satuan, rasio, harga, diskon %, diskon Rp, gudang. Uji: `lib/sales-invoice-change{,-pg}.test.ts` |
```

- [ ] **Step 2: Baris route webhook** — pada baris `` | `app/api/webhook/accurate/route.ts` | `POST` | ``, ganti deskripsinya menjadi:

```markdown
| `app/api/webhook/accurate/route.ts` | `POST` | Terima event webhook Faktur Penjualan dari Accurate (IP whitelist fail-closed + log rotasi + upsert `sales_invoice` + catat perubahan rincian INV ke `sales_invoice_line_change` dengan appKey/timestamp amplop) |
```

- [ ] **Step 3: Commit**

```bash
git add SYSTEM_MAP.md
git commit -m "docs(system-map): pencatat perubahan rincian faktur

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Gerbang penuh

**Files:** tidak ada perubahan kode (kecuali perbaikan bila gerbang merah).

- [ ] **Step 1: Lint, tipe, dan seluruh uji** (sama dengan CI `deploy.yml`, ditambah uji PG)

```bash
npm run lint
npx tsc --noEmit
npm test
```
Expected: lint 0 error; tsc keluar 0; `npm test` `# fail 0`. Di shell yang sudah `export AM040_DATABASE_URL` (Task 0 Step 2), uji `lib/sales-invoice-change-pg.test.ts` dan `lib/supervisor-review/supervisor-review-pg.test.ts` harus TIDAK `skipped`.

- [ ] **Step 2: Build** (image produksi dibangun dari `next build`)

```bash
npm run build
```
Expected: `✓ Compiled successfully`, keluar 0.

- [ ] **Step 3: Pastikan pohon kerja bersih**

```bash
git status --short
git log --oneline origin/main..HEAD
```
Expected: `git status` kosong; log memuat commit spec, rencana, dan Task 1–6.

---

### Task 8: Serahkan ke owner

- [ ] **Step 1: Laporkan dan minta izin** — JANGAN push, buka PR, atau merge tanpa izin eksplisit owner (zona §3; merge ke `main` = deploy produksi).

Laporan berisi: daftar commit, hasil gerbang (angka pass/fail/skipped), hasil uji sabotase Task 2 Step 5 dan Task 4 Step 6, serta urutan rilis:
1. Merge PR → image baru; `scripts/migrate-pg.mjs` membuat tabel saat container start (log `[migrate-pg] OK sales_invoice_line_change`).
2. Verifikasi pasca-deploy (baca-saja): `SELECT count(*), max(detected_at) FROM sales_invoice_line_change;` beberapa jam sesudahnya, dan cocokkan satu baris dengan Log Aktifitas faktur itu di Accurate.
3. Rollback aman: tabel aditif; revert commit kode tanpa perlu menghapus tabel.
