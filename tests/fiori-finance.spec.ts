/*
 * Tujuan: Fiori S6b Finance (it02, ZONA TULIS ACCURATE/UANG) — worklist + detail per tanggal bayar WITA, database di header, status transfer
 *   ≠ status posting, tujuan dari master Accurate (GET list.do lewat proxy), dialog Transfer & posting: urutan 5 langkah (sesi → simpan
 *   tujuan → unggah bukti → command → catatan FastAPI), clientRef = recordKey lama, payload diperiksa; hasil per jawaban server: sukses,
 *   {claimed:false} (tidak dikirim, tidak dikunci), 409 in_flight (tanpa tulis catatan) / unknown / reopened, 502 HTML, putus, 200 unknown
 *   (hasilnya belum pasti + kunci + muat ulang); Selesaikan (hanya Finance): "Tidak ada" < 2 menit nonaktif, resolve + catatan, 404
 *   no_open_attempt & already_posted ditoleransi; galat ≠ kosong (tanpa "localhost"), attempt tak terbaca = posting terkunci, klik ganda =
 *   satu POST, dua tab, ponsel 390 px. Tanpa dialog native.
 * Caller: Playwright lokal (LOCAL_AUTH_BYPASS=true = izin admin):
 *   `npx playwright test tests/fiori-finance.spec.ts --config playwright.fiori-local.config.ts --workers=1`.
 * Dependensi: /api/finance/purchase-payment(+/attempts,/resolve), /api/auth/accurate-session, /api/proxy di-mock dengan route;
 *   FastAPI (dev: http://localhost:8000) di-mock dengan header CORS. Tidak ada panggilan Accurate; tidak menyentuh DB.
 * Side Effects: Tangkapan di test-results/.
 */
import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";

const NAV = { timeout: 90_000 } as const;
const HARI_INI = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Makassar" }).format(new Date());
const ORIGIN = "http://localhost:3013";
const CORS = { "access-control-allow-origin": ORIGIN, "access-control-allow-credentials": "true", "access-control-allow-headers": "content-type, x-csrf-token", "access-control-allow-methods": "GET, POST, OPTIONS" };
const PDF = { name: "bukti_0418.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 uji") };

type Jawab = { status: number; body?: unknown; html?: string } | "putus";
type Baris = Record<string, unknown> & { draft_id: string; principle: string; detail_invoices: Array<{ record_id: string; invoiceNo: string; paymentAmount: number }> };

const subjek = (inv: string[]) => [...new Set(inv.map((x) => x.trim().toUpperCase()))].sort().join(",");
const pengajuan = (id: string, principle: string, faktur: Array<[string, number]>, over: Record<string, unknown> = {}): Baris => {
    const total = faktur.reduce((t, [, n]) => t + n, 0);
    return {
        draft_label: id, draft_id: id, submission_id: "", principle, tipe_pengajuan: "LPB", total_invoice: total + 900_000, total_potongan: 900_000,
        invoice_concat: faktur.map(([f]) => f).join(", "), detail_invoices: faktur.map(([invoiceNo, paymentAmount], i) => ({ record_id: `${id}-${i}`, invoiceNo, paymentAmount })),
        total_nilai: total, keterangan: "", payment_method: "BANK_PANIN", submitted_date: HARI_INI, status_pembayaran: "Belum Transfer", sppd_no: "031/SPA/PDSB/X/2026",
        transfer_date: "", transfer_proof: {}, accurate_post_status: "", accurate_post_status_raw: "", accurate_post_error: "", accurate_purchase_payment_number: "",
        accurate_posted_by: "", accurate_posted_at: "", accurate_post_resolution: null,
        mapping: { principle, vendorNo: "V-0012", vendorName: "PRINCIPLE A", bankNo: "1102-03", bankName: "BANK A OPERASIONAL" }, ...over,
    };
};
const FAKTUR_A: Array<[string, number]> = [["LPB-A/0918", 14_200_000], ["LPB-A/0921", 12_900_000], ["LPB-A/0926", 11_600_000], ["LPB-A/0930", 9_500_000]];
const attempt = (over: Record<string, unknown>) => ({
    attemptId: "at-9", state: "unknown", status: "unknown", stale: false, accurateNumber: "", accurateId: "", actor: "u-1", actorName: "Finance A", targetDbId: "DB-1",
    generation: 0, ageSeconds: 30, createdAt: "", createdAtWita: `${HARI_INI} 08:21:00`, updatedAt: "", updatedAtWita: `${HARI_INI} 08:21:30`, message: "", resolution: null, ...over,
});

type Opsi = {
    rows?: () => Baris[];
    dataGagal?: Jawab;
    attempts?: Record<string, unknown>;
    attemptsGagal?: Jawab;
    command?: Jawab[];
    tundaCommand?: number;
    resolve?: Jawab[];
    update?: Jawab[];
};

/** Semua jawaban dimock; keadaan berubah setelah tulis (catatan FastAPI dan attempt server) supaya muat ulang memperlihatkannya. */
async function siapkan(target: Page | BrowserContext, opsi: Opsi = {}) {
    const rows: Baris[] = opsi.rows ? opsi.rows() : [
        pengajuan("DRAFT-0418", "PRINCIPLE A", FAKTUR_A),
        pengajuan("DRAFT-0411", "PRINCIPLE B", [["LPB-B/0101", 31_750_000]], { mapping: { principle: "PRINCIPLE B", vendorNo: "V-0031", vendorName: "PRINCIPLE B" } }),
    ];
    const attempts: Record<string, unknown> = { ...(opsi.attempts ?? {}) };
    const antri = { command: [...(opsi.command ?? [])], resolve: [...(opsi.resolve ?? [])], update: [...(opsi.update ?? [])] };
    const m = { urutan: [] as string[], command: [] as Array<{ clientRef: string; payload: Array<Record<string, unknown>> }>, update: [] as Array<Record<string, unknown>>,
        resolve: [] as Array<Record<string, unknown>>, mapping: [] as Array<Record<string, unknown>>, proxy: [] as Array<Record<string, unknown>>, dataDates: [] as string[],
        dataGagal: opsi.dataGagal, attemptsGagal: opsi.attemptsGagal, attempts, rows };
    const jawab = (r: Route, j: Jawab, cors = false) => j === "putus" ? r.abort("connectionreset")
        : r.fulfill({ status: j.status, headers: { ...(cors ? CORS : {}), "content-type": j.html ? "text/html" : "application/json" }, body: j.html ?? JSON.stringify(j.body) });
    const terapkan = (it: Record<string, unknown>) => {
        const row = rows.find((x) => x.draft_id === it.draft_id && x.principle === it.principle);
        if (!row) return;
        row.status_pembayaran = it.status_pembayaran;
        if (it.status_pembayaran === "Sudah Transfer") {
            Object.assign(row, { transfer_date: it.transfer_date || row.transfer_date, accurate_post_status: it.accurate_post_status, accurate_post_status_raw: it.accurate_post_status,
                accurate_post_error: it.accurate_post_error ?? "", accurate_purchase_payment_number: it.accurate_purchase_payment_number ?? "" });
            if (it.proof_id) row.transfer_proof = { proof_id: it.proof_id, original_filename: "bukti_0418.pdf", stored_filename: "proof_x.pdf", url: "/payments/proofs/proof_x.pdf" };
            if (it.accurate_post_status === "posted") Object.assign(row, { accurate_posted_by: "betterauth|finance|finance.a@example.invalid", accurate_posted_at: `${HARI_INI} 08:47:00` });
            if (it.resolution_note) row.accurate_post_resolution = { from: "unknown", to: it.accurate_post_status, source: "manual_attestation", by: "betterauth|finance|finance.a@example.invalid", at: `${HARI_INI} 09:00:00`, note: it.resolution_note };
        }
    };

    await target.route((u) => u.host === "localhost:8000", async (r) => {
        const req = r.request();
        if (req.method() === "OPTIONS") return r.fulfill({ status: 204, headers: CORS });
        const u = new URL(req.url());
        if (u.pathname === "/api/me") return jawab(r, { status: 200, body: { ok: true, csrf_token: "tok-uji" } }, true);
        if (u.pathname === "/payments/finance/data") {
            m.dataDates.push(u.searchParams.get("date") ?? "");
            if (m.dataGagal) return jawab(r, m.dataGagal, true);
            return jawab(r, { status: 200, body: { ok: true, data: rows, total_all: rows.reduce((t, x) => t + Number(x.total_nilai), 0), date: u.searchParams.get("date") } }, true);
        }
        if (u.pathname === "/payments/finance/mapping") { m.urutan.push("mapping"); m.mapping.push(req.postDataJSON()); return jawab(r, { status: 200, body: { ok: true } }, true); }
        if (u.pathname === "/payments/finance/proof") {
            m.urutan.push("proof");
            return jawab(r, { status: 200, body: { ok: true, proof: { proof_id: "pf-1", original_filename: "bukti_0418.pdf", stored_filename: "proof_20261010_pf-1.pdf", sha256: "3f9a00112233445566778899c21e" } } }, true);
        }
        if (u.pathname === "/payments/finance/update") {
            const b = req.postDataJSON() as { items: Array<Record<string, unknown>> };
            m.urutan.push(`update:${String(b.items[0].accurate_post_status ?? b.items[0].status_pembayaran)}`);
            m.update.push(b.items[0]);
            const j = antri.update.shift();
            if (j) return jawab(r, j, true);
            terapkan(b.items[0]);
            return jawab(r, { status: 200, body: { ok: true, updated: 1 } }, true);
        }
        return jawab(r, { status: 404, body: { ok: false, error: "tidak dimock" } }, true);
    });
    await target.route((u) => u.pathname === "/api/auth/accurate-session", (r) => jawab(r, { status: 200, body: { ok: true, connected: true, databaseConnected: true, sessionHost: "x", databaseId: "DB-1", databaseAlias: "PT CONTOH A" } }));
    await target.route((u) => u.pathname === "/api/finance/purchase-payment/attempts", (r) => {
        if (m.attemptsGagal) return jawab(r, m.attemptsGagal);
        const groups = new URL(r.request().url()).searchParams.getAll("invoices").map((g) => g.split(","));
        return jawab(r, { status: 200, body: { ok: true, data: groups.map((inv) => ({ invoices: inv, subjectKey: subjek(inv), attempt: attempts[subjek(inv)] ?? null })) } });
    });
    await target.route((u) => u.pathname === "/api/finance/purchase-payment", async (r) => {
        const body = r.request().postDataJSON() as { clientRef: string; payload: Array<Record<string, unknown>> };
        m.urutan.push("command");
        m.command.push(body);
        const sub = subjek((body.payload[0].detailInvoice as Array<{ invoiceNo: string }>).map((d) => d.invoiceNo));
        attempts[sub] = attempt({ state: "sending", status: "sending", ageSeconds: 0 });
        if (opsi.tundaCommand) await new Promise((ok) => setTimeout(ok, opsi.tundaCommand));
        const j = antri.command.shift() ?? { status: 200, body: { attemptId: "at-1", state: "posted", accurateId: "9001", accurateNumber: "PP/2610/0031", message: "", response: { s: true }, persisted: true } };
        const isi = j === "putus" ? null : (j.body as { state?: string; claimed?: boolean; live?: { state: string; stale?: boolean } | null } | undefined);
        if (j !== "putus" && j.status === 200 && isi?.state === "posted") attempts[sub] = attempt({ state: "posted", status: "posted", accurateNumber: "PP/2610/0031", ageSeconds: 1 });
        else if (isi?.claimed === false) delete attempts[sub];
        else if (isi?.live) attempts[sub] = attempt({ state: isi.live.state, status: isi.live.state === "sending" ? (isi.live.stale ? "stale" : "sending") : isi.live.state, stale: Boolean(isi.live.stale) });
        else attempts[sub] = attempt({ ageSeconds: 1 });
        return jawab(r, j);
    });
    await target.route((u) => u.pathname === "/api/finance/purchase-payment/resolve", (r) => {
        m.urutan.push("resolve");
        m.resolve.push(r.request().postDataJSON());
        return jawab(r, antri.resolve.shift() ?? { status: 200, body: { ok: true, attemptId: "at-9", state: "posted" } });
    });
    await target.route((u) => u.pathname === "/api/proxy", (r) => {
        const b = r.request().postDataJSON() as Record<string, unknown>;
        m.proxy.push(b);
        if (b.method !== "GET") return jawab(r, { status: 403, body: { error: "uji: tulis lewat proxy dilarang" } });
        if (b.endpointPath === "/api/vendor/list.do") return jawab(r, { status: 200, body: { s: true, d: [{ id: 1, vendorNo: "V-0012", name: "PRINCIPLE A" }, { id: 2, vendorNo: "V-0031", name: "PRINCIPLE B" }], sp: { pageCount: 1 } } });
        if (b.endpointPath === "/api/glaccount/list.do") return jawab(r, { status: 200, body: { s: true, d: [
            { id: 1, no: "1102-03", name: "BANK A OPERASIONAL", accountType: "CASH_BANK" }, { id: 2, no: "1101-01", name: "KAS BESAR", accountType: "CASH_BANK" },
            { id: 3, no: "4100", name: "PENJUALAN", accountType: "REVENUE" }], sp: { pageCount: 1 } } });
        return jawab(r, { status: 404, body: { error: "tidak dimock" } });
    });
    return m;
}

async function bukaPengajuan(page: Page, label = "DRAFT-0418") {
    const main = page.locator("main");
    await page.goto("/finance", NAV);
    await main.getByRole("list", { name: "Daftar pengajuan" }).getByRole("button", { name: new RegExp(label) }).click(NAV);
    return { main, detail: main.getByRole("region", { name: "Detail pengajuan" }) };
}

/** Isi bukti lalu buka dialog Transfer & posting. */
async function bukaDialogPosting(page: Page) {
    const { main, detail } = await bukaPengajuan(page);
    await expect(detail.getByLabel("Pemasok")).toHaveValue("V-0012", NAV);
    await detail.getByLabel("Bukti transfer").setInputFiles(PDF);
    await detail.getByRole("button", { name: "Transfer & posting…" }).click();
    return { main, detail, dlg: page.getByRole("dialog", { name: "Posting Purchase Payment ke Accurate?" }) };
}

test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
    page.on("dialog", (d) => { throw new Error(`window.${d.type()} masih dipakai: ${d.message()}`); });
});

test("Default → Transfer & posting: dialog menyebut isi kiriman, urutan 5 langkah, clientRef lama, sukses = nomor PP + siapa; BL-05 setelahnya", async ({ page }) => {
    const m = await siapkan(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    const { main, detail, dlg } = await bukaDialogPosting(page);
    expect(m.dataDates[0]).toBe(HARI_INI); // tanggal bawaan WITA, bukan UTC
    await expect(main.getByText("Database Accurate: PT CONTOH A")).toBeVisible();
    await expect(main.getByRole("button", { name: /Belum transfer\s*2/ })).toBeVisible();
    // Master Accurate: hanya GET list.do; rekening hanya Kas/Bank.
    expect(m.proxy.every((p) => p.method === "GET")).toBe(true);
    await expect(detail.getByLabel("Rekening bank").locator("option")).toHaveText(["Pilih dari Accurate…", "1102-03 · BANK A OPERASIONAL", "1101-01 · KAS BESAR"]);
    await expect(dlg.getByText("PT CONTOH A")).toBeVisible();
    await expect(dlg).toContainText("V-0012 · PRINCIPLE A");
    await expect(dlg).toContainText("1102-03 · BANK A OPERASIONAL");
    await expect(dlg).toContainText("4 · LPB-A/0918, LPB-A/0921, LPB-A/0926, LPB-A/0930");
    await expect(dlg).toContainText("bukti_0418.pdf");
    await expect(dlg).toContainText("tidak bisa ditarik");
    await page.screenshot({ path: "test-results/fiori-finance-dialog-pp.png" });
    await dlg.getByRole("button", { name: "Posting Rp 48.200.000" }).click();
    await expect(main.getByRole("status").filter({ hasText: "Terposting PP/2610/0031 · Rp 48.200.000 · PT CONTOH A" })).toBeVisible(NAV);
    expect(m.urutan).toEqual(["mapping", "proof", "command", "update:posted"]);
    expect(m.command).toHaveLength(1);
    expect(m.command[0].clientRef).toBe("DRAFT-0418|-|PRINCIPLE A|LPB");
    expect(m.command[0].payload[0]).toMatchObject({ bankNo: "1102-03", vendorNo: "V-0012", chequeAmount: 48_200_000, paymentMethod: "BANK_TRANSFER",
        transDate: HARI_INI.split("-").reverse().join("/"), detailInvoice: FAKTUR_A.map(([invoiceNo, paymentAmount]) => ({ invoiceNo, paymentAmount })) });
    expect(String(m.command[0].payload[0].description)).toContain("Bukti: proof_20261010_pf-1.pdf");
    expect(m.update[0]).toMatchObject({ status_pembayaran: "Sudah Transfer", accurate_post_status: "posted", accurate_purchase_payment_number: "PP/2610/0031", proof_id: "pf-1", date: HARI_INI });
    // Sukses: nomor PP + siapa (WITA); status transfer terpisah; Belum/Kembalikan nonaktif dengan alasan (BL-05).
    await expect(detail.getByText("Terposting PP/2610/0031").first()).toBeVisible(NAV);
    await expect(detail).toContainText("finance.a@example.invalid");
    await expect(detail.getByText(/Ditransfer \d{2}\/\d{2}\/\d{4}/).first()).toBeVisible();
    await expect(detail.getByRole("button", { name: "Kembalikan ke Pembayaran" })).toBeDisabled();
    await expect(detail.getByRole("list", { name: "Alasan aksi nonaktif" })).toContainText("BL-05");
    await expect(detail.getByRole("button", { name: "Transfer & posting…" })).toBeDisabled();
    await expect(detail.getByText("Sudah terposting di Accurate. Pembatalan lewat dokumen pembalik di Accurate.")).toBeVisible();
    await page.screenshot({ path: "test-results/fiori-finance-sukses.png", fullPage: true });
});

const TIDAK_PASTI: Array<[string, Jawab]> = [
    ["502 HTML gateway", { status: 502, html: "<html><body><h1>502 Bad Gateway</h1>nginx</body></html>" }],
    ["koneksi putus", "putus"],
    ["200 state unknown (timeout)", { status: 200, body: { attemptId: "at-1", state: "unknown", accurateId: "", accurateNumber: "", message: "tanpa jawaban (TimeoutError). Coba lagi.", persisted: true } }],
    ["409 unknown", { status: 409, body: { error: "Ada attempt posting yang belum pasti untuk faktur ini — periksa Accurate lalu selesaikan manual.", live: { attemptId: "at-0", state: "unknown", accurateId: "", accurateNumber: "", targetDbId: "DB-1", sameRecord: true, sameTarget: true, stale: true }, generation: 0, currentGeneration: 0 } }],
    ["409 reopened_use_repost", { status: 409, body: { code: "reopened_use_repost", error: "Pembayaran untuk faktur ini sudah dibuka ulang untuk posting ulang (repost).", live: null, generation: 0, currentGeneration: 1 } }],
];
for (const [nama, j] of TIDAK_PASTI) {
    test(`Tidak pasti (${nama}) → "hasilnya belum pasti", catatan unknown, baris dikunci + Selesaikan; tanpa HTML mentah`, async ({ page }) => {
        const m = await siapkan(page, { command: [j] });
        const { main, detail, dlg } = await bukaDialogPosting(page);
        await dlg.getByRole("button", { name: "Posting Rp 48.200.000" }).click();
        await expect(main.getByRole("status").filter({ hasText: "Hasilnya belum pasti — DRAFT-0418 dikunci." })).toBeVisible(NAV);
        await expect(dlg).toBeHidden();
        expect(m.update.at(-1)).toMatchObject({ accurate_post_status: "unknown", status_pembayaran: "Sudah Transfer" });
        await expect(detail.getByRole("button", { name: "Transfer & posting…" })).toBeDisabled(NAV);
        await expect(detail.getByRole("button", { name: "Selesaikan…" })).toBeEnabled(NAV);
        await expect(main).not.toContainText("Bad Gateway");
        await expect(main).not.toContainText("localhost");
        await expect(main.getByText(/Coba lagi\./)).toHaveCount(0);
        expect(m.command).toHaveLength(1);
    });
}

test("{claimed:false} = tidak terkirim & tidak dikunci; 409 in_flight = tanpa tulis catatan (tab lain yang mencatat)", async ({ page }) => {
    const m = await siapkan(page, { command: [
        { status: 400, body: { error: "Sesi Accurate belum lengkap. Login dan open database Accurate dulu.", claimed: false } },
        { status: 409, body: { error: "Ada attempt posting yang belum pasti", live: { attemptId: "at-2", state: "sending", accurateId: "", accurateNumber: "", targetDbId: "DB-1", sameRecord: true, sameTarget: true, stale: false }, generation: 0, currentGeneration: 0 } },
    ] });
    const { main, detail, dlg } = await bukaDialogPosting(page);
    await dlg.getByRole("button", { name: "Posting Rp 48.200.000" }).click();
    await expect(main.getByRole("alert").filter({ hasText: "Tidak ada yang dikirim ke Accurate untuk DRAFT-0418." })).toBeVisible(NAV);
    expect(m.update.at(-1)).toMatchObject({ accurate_post_status: "failed" });
    // Gagal jelas tidak mengunci: bukti tersimpan dipakai, posting boleh lagi.
    await expect(detail.getByText("Bukti tersimpan")).toBeVisible(NAV);
    const tombol = detail.getByRole("button", { name: "Transfer & posting…" });
    await expect(tombol).toBeEnabled(NAV);
    const nUpdate = m.update.length;
    await tombol.click();
    await page.getByRole("dialog", { name: "Posting Purchase Payment ke Accurate?" }).getByRole("button", { name: "Posting Rp 48.200.000" }).click();
    await expect(main.getByRole("status").filter({ hasText: "sedang diposting dari sesi atau tab lain" })).toBeVisible(NAV);
    expect(m.update.length).toBe(nUpdate); // in_flight: tidak ada catatan "unknown" yang mendahului hasil tab lain
    expect(m.command).toHaveLength(2);
    expect(m.command[1].clientRef).toBe("DRAFT-0418|-|PRINCIPLE A|LPB");
});

test("Selesaikan: 'Tidak ada' nonaktif < 2 menit; 'Ada' + nomor → resolve + catatan posted; 404 no_open_attempt ditoleransi", async ({ page }) => {
    const sub = subjek(FAKTUR_A.map(([f]) => f));
    const m = await siapkan(page, {
        rows: () => [pengajuan("DRAFT-0418", "PRINCIPLE A", FAKTUR_A, { status_pembayaran: "Sudah Transfer", transfer_date: HARI_INI, accurate_post_status: "unknown", accurate_post_status_raw: "failed",
            accurate_post_error: "Accurate tidak merespons dalam 30 detik (timeout). Coba lagi.", transfer_proof: { proof_id: "pf-0", original_filename: "bukti_lama.pdf", url: "/payments/proofs/x.pdf" } })],
        attempts: { [sub]: attempt({ ageSeconds: 30 }) },
        resolve: [{ status: 404, body: { ok: false, code: "no_open_attempt", error: "tidak ada attempt terbuka untuk subjek ini" } }],
    });
    const { main, detail } = await bukaPengajuan(page);
    await expect(detail.getByText("Posting tidak pasti — pengajuan dikunci.")).toBeVisible(NAV);
    await expect(detail).not.toContainText("Coba lagi.");
    await expect(detail.getByRole("button", { name: "Tandai belum transfer" })).toBeDisabled();
    await detail.getByRole("button", { name: "Selesaikan…" }).click();
    const dlg = page.getByRole("dialog", { name: "Selesaikan posting tidak pasti" });
    await expect(dlg.getByRole("radio", { name: "Tidak ada di Accurate" })).toBeDisabled();
    await expect(dlg.getByText(/Tersedia 2 menit setelah percobaan/)).toBeVisible();
    await expect(dlg.getByText("Sesi Accurate Anda (PT CONTOH A) sama dengan database percobaan.")).toBeVisible();
    const simpan = dlg.getByRole("button", { name: "Simpan penyelesaian" });
    await dlg.getByRole("radio", { name: "Ada di Accurate" }).check();
    await dlg.getByLabel("Nomor Purchase Payment").fill("PP/2610/0030");
    await dlg.getByLabel("Diperiksa di").fill("Accurate › Pembayaran Pembelian, pemasok V-0012");
    await dlg.getByLabel("Alasan").fill("pendek");
    await expect(simpan).toBeDisabled();
    await dlg.getByLabel("Alasan").fill("Pembayaran ada dengan nilai dan faktur yang sama.");
    await simpan.click();
    await expect(main.getByRole("status").filter({ hasText: "ditandai terposting PP/2610/0030 (diperiksa manual)" })).toBeVisible(NAV);
    expect(m.resolve[0]).toEqual({ invoiceNos: FAKTUR_A.map(([f]) => f), decision: "posted", accurateNumber: "PP/2610/0030", reason: "Pembayaran ada dengan nilai dan faktur yang sama.", checkedSource: "Accurate › Pembayaran Pembelian, pemasok V-0012" });
    expect(m.update.at(-1)).toMatchObject({ status_pembayaran: "Sudah Transfer", accurate_post_status: "posted", accurate_purchase_payment_number: "PP/2610/0030", proof_id: "pf-0" });
    expect(String(m.update.at(-1)!.resolution_note)).toContain("Pembayaran ada dengan nilai dan faktur yang sama.");
    expect(m.command).toHaveLength(0);
});

test("Selesaikan 'Tidak ada' setelah basi; already_posted untuk 'Tidak ada' ditolak di dialog (catatan tidak berubah)", async ({ page }) => {
    const sub = subjek(FAKTUR_A.map(([f]) => f));
    const m = await siapkan(page, {
        rows: () => [pengajuan("DRAFT-0418", "PRINCIPLE A", FAKTUR_A, { status_pembayaran: "Sudah Transfer", transfer_date: HARI_INI, accurate_post_status: "unknown", transfer_proof: { proof_id: "pf-0", original_filename: "b.pdf" } })],
        attempts: { [sub]: attempt({ state: "sending", status: "stale", stale: true, ageSeconds: 600 }) },
        resolve: [{ status: 409, body: { ok: false, code: "already_posted", error: "sudah posted PP/2610/0031" } }, { status: 200, body: { ok: true, attemptId: "at-9", state: "resolved_absent" } }],
    });
    const { main, detail } = await bukaPengajuan(page);
    await detail.getByRole("button", { name: "Selesaikan…" }).click();
    const dlg = page.getByRole("dialog", { name: "Selesaikan posting tidak pasti" });
    await dlg.getByRole("radio", { name: "Tidak ada di Accurate" }).check();
    await dlg.getByLabel("Diperiksa di").fill("Accurate › Pembayaran Pembelian");
    await dlg.getByLabel("Alasan").fill("Tidak ada pembayaran dengan faktur ini di Accurate.");
    await dlg.getByRole("button", { name: "Simpan penyelesaian" }).click();
    await expect(dlg.getByRole("alert")).toContainText("Server sudah mencatat percobaan ini TERPOSTING");
    expect(m.update).toHaveLength(0);
    await dlg.getByRole("button", { name: "Simpan penyelesaian" }).click();
    await expect(main.getByRole("status").filter({ hasText: "ditandai tidak ada di Accurate" })).toBeVisible(NAV);
    expect(m.resolve[1]).toMatchObject({ decision: "absent", accurateNumber: "" });
    expect(m.update.at(-1)).toMatchObject({ accurate_post_status: "failed", accurate_post_error: "dicek manual: tidak ada di Accurate" });
});

test("Galat ≠ kosong (tanpa localhost/HTML), Kosong, status posting tak terbaca = posting terkunci", async ({ page }) => {
    const m = await siapkan(page, { dataGagal: { status: 500, html: "<html>Internal Server Error</html>" } });
    const main = page.locator("main");
    await page.goto("/finance", NAV);
    await expect(main.getByRole("alert").filter({ hasText: "Server Pembayaran tidak menjawab" })).toBeVisible(NAV);
    await expect(main.getByText(/Tidak ada pengajuan untuk/)).toHaveCount(0);
    await expect(main).not.toContainText("localhost");
    await expect(main).not.toContainText("Internal Server Error");
    m.dataGagal = undefined;
    m.rows.splice(0, m.rows.length);
    await main.getByRole("button", { name: "Coba lagi" }).click();
    await expect(main.getByText(/^Tidak ada pengajuan untuk /)).toBeVisible(NAV);
    m.rows.push(pengajuan("DRAFT-0418", "PRINCIPLE A", FAKTUR_A));
    m.attemptsGagal = { status: 503, body: { ok: false, error: "Status posting tidak bisa dibaca dari database. Coba lagi." } };
    await main.getByRole("button", { name: "Muat ulang" }).click();
    await expect(main.getByRole("status").filter({ hasText: "Status posting dari server tidak terbaca." })).toBeVisible(NAV);
    await main.getByRole("list", { name: "Daftar pengajuan" }).getByRole("button", { name: /DRAFT-0418/ }).click();
    const detail = main.getByRole("region", { name: "Detail pengajuan" });
    await detail.getByLabel("Bukti transfer").setInputFiles(PDF);
    await expect(detail.getByRole("button", { name: "Transfer & posting…" })).toBeDisabled();
    await expect(detail.getByText("Status posting dari server tidak terbaca; muat ulang dulu.")).toBeVisible();
});

test("Klik ganda konfirmasi = satu POST; dua tab: tab kedua melihat 'Sedang diposting' dan tidak bisa memposting", async ({ context }) => {
    const m = await siapkan(context, { tundaCommand: 2500 });
    const a = await context.newPage();
    const { main, dlg } = await bukaDialogPosting(a);
    await dlg.getByRole("button", { name: "Posting Rp 48.200.000" }).dblclick();
    await expect.poll(() => m.command.length, NAV).toBe(1); // klaim server sudah ada (attempt 'sending') sebelum tab kedua dibuka
    const b = await context.newPage();
    const { detail: detailB } = await bukaPengajuan(b);
    await expect(detailB.getByText("Sedang diposting dari sesi atau tab lain.")).toBeVisible(NAV);
    await expect(detailB.getByRole("button", { name: "Transfer & posting…" })).toBeDisabled();
    await expect(main.getByRole("status").filter({ hasText: "Terposting PP/2610/0031" })).toBeVisible(NAV);
    expect(m.command).toHaveLength(1);
    await b.locator("main").getByRole("button", { name: "Muat ulang" }).click();
    await expect(detailB.getByText("Terposting PP/2610/0031").first()).toBeVisible(NAV);
});

test("Ponsel 390 px: daftar ↔ detail tanpa gulir menyamping; draf tujuan ditandai", async ({ page }) => {
    await siapkan(page);
    await page.setViewportSize({ width: 390, height: 844 });
    const { main, detail } = await bukaPengajuan(page, "DRAFT-0411");
    await expect(detail.getByLabel("Rekening bank")).toBeVisible(NAV);
    await expect(detail.getByText("Rekening wajib sebelum posting.")).toBeVisible();
    await detail.getByLabel("Rekening bank").selectOption("1101-01");
    await expect(detail.getByText("Draf belum disimpan")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: "test-results/fiori-finance-ponsel.png", fullPage: true });
    await main.getByRole("button", { name: "Kembali ke daftar" }).click();
    await expect(main.getByRole("list", { name: "Daftar pengajuan" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
