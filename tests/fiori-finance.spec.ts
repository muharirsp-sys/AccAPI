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
    attemptId: "at-9", state: "unknown", status: "unknown", stale: false, accurateNumber: "", accurateId: "", actor: "u-1", actorName: "Finance A", clientRef: "DRAFT-0418|-|PRINCIPLE A|LPB", targetDbId: "DB-1",
    generation: 0, ageSeconds: 30, createdAt: "", createdAtWita: `${HARI_INI} 08:21:00`, updatedAt: "", updatedAtWita: `${HARI_INI} 08:21:30`, message: "", resolution: null, ...over,
});

type Opsi = {
    rows?: () => Baris[];
    dataGagal?: Jawab;
    attempts?: Record<string, unknown>;
    attemptsGagal?: Jawab;
    command?: Jawab[];
    /** Jawaban command ditahan sampai janji ini selesai (klaim server sudah tercatat 'sending'). */
    tahanCommand?: Promise<void>;
    resolve?: Jawab[];
    update?: Jawab[];
    /** Kiriman command hilang SEBELUM sampai server (tidak ada klaim attempt); jawabannya tetap "putus" bagi peramban. */
    commandTakSampai?: boolean;
};

/** Semua jawaban dimock; keadaan berubah setelah tulis (catatan FastAPI dan attempt server) supaya muat ulang memperlihatkannya. */
async function siapkan(target: Page | BrowserContext, opsi: Opsi = {}) {
    const rows: Baris[] = opsi.rows ? opsi.rows() : [
        pengajuan("DRAFT-0418", "PRINCIPLE A", FAKTUR_A),
        pengajuan("DRAFT-0411", "PRINCIPLE B", [["LPB-B/0101", 31_750_000]], { mapping: { principle: "PRINCIPLE B", vendorNo: "V-0031", vendorName: "PRINCIPLE B" } }),
    ];
    const attempts: Record<string, unknown> = { ...(opsi.attempts ?? {}) };
    const antri = { command: [...(opsi.command ?? [])], resolve: [...(opsi.resolve ?? [])], update: [...(opsi.update ?? [])] };
    const m = { urutan: [] as string[], command: [] as Array<{ clientRef: string; expectedDatabaseId: string; payload: Array<Record<string, unknown>> }>, update: [] as Array<Record<string, unknown>>,
        resolve: [] as Array<Record<string, unknown>>, mapping: [] as Array<Record<string, unknown>>, proxy: [] as Array<Record<string, unknown>>, dataDates: [] as string[],
        dataGagal: opsi.dataGagal, attemptsGagal: opsi.attemptsGagal, attempts, rows,
        /** Database sesi Accurate SEKARANG (bisa diganti di tengah tes = tab lain membuka database lain). */
        sesiDb: { id: "DB-1", alias: "PT CONTOH A" } };
    const jawab = (r: Route, j: Jawab, cors = false) => j === "putus" ? r.abort("connectionreset")
        : r.fulfill({ status: j.status, headers: { ...(cors ? CORS : {}), "content-type": j.html ? "text/html" : "application/json" }, body: j.html ?? JSON.stringify(j.body) });
    /**
     * Meniru penjaga server /payments/finance/update (finance.py post_status_conflict, BL-49): posted tidak berubah; unknown hanya keluar
     * ke posted/failed dengan catatan >= 15; Belum Transfer/Ajukan Ulang ditolak bila posted/unknown. Ditolak = 409 (tidak diubah).
     */
    const tolakServer = (it: Record<string, unknown>): string | undefined => {
        const row = rows.find((x) => x.draft_id === it.draft_id && x.principle === it.principle);
        const kini = String(row?.accurate_post_status || "");
        const baru = String(it.accurate_post_status || "");
        if (it.status_pembayaran !== "Sudah Transfer") return kini === "posted" || kini === "unknown" ? `LPB ${kini}: status tidak bisa dikembalikan.` : undefined;
        if (kini === "posted") return "LPB sudah posted ke Accurate; status tidak bisa diubah dari sini.";
        if (kini === "unknown" && baru !== "unknown" && (!["posted", "failed"].includes(baru) || String(it.resolution_note || "").length < 15)) return "Status posting TIDAK PASTI: selesaikan dengan catatan.";
        return undefined;
    };
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
        if (u.pathname === "/payments/finance/mapping") {
            const b = req.postDataJSON() as Record<string, unknown>;
            m.urutan.push("mapping");
            m.mapping.push(b);
            for (const row of rows) if (row.principle === b.principle) row.mapping = { ...b };
            return jawab(r, { status: 200, body: { ok: true } }, true);
        }
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
            const tolak = tolakServer(b.items[0]);
            if (tolak) return jawab(r, { status: 409, body: { ok: false, error: tolak } }, true);
            terapkan(b.items[0]);
            return jawab(r, { status: 200, body: { ok: true, updated: 1 } }, true);
        }
        return jawab(r, { status: 404, body: { ok: false, error: "tidak dimock" } }, true);
    });
    await target.route((u) => u.pathname === "/api/auth/accurate-session", (r) => jawab(r, { status: 200, body: { ok: true, connected: true, databaseConnected: true, sessionHost: "x", databaseId: m.sesiDb.id, databaseAlias: m.sesiDb.alias } }));
    await target.route((u) => u.pathname === "/api/finance/purchase-payment/attempts", (r) => {
        if (m.attemptsGagal) return jawab(r, m.attemptsGagal);
        const groups = new URL(r.request().url()).searchParams.getAll("invoices").map((g) => g.split(","));
        return jawab(r, { status: 200, body: { ok: true, data: groups.map((inv) => ({ invoices: inv, subjectKey: subjek(inv), attempt: attempts[subjek(inv)] ?? null })) } });
    });
    await target.route((u) => u.pathname === "/api/finance/purchase-payment", async (r) => {
        const body = r.request().postDataJSON() as { clientRef: string; expectedDatabaseId: string; payload: Array<Record<string, unknown>> };
        m.urutan.push("command");
        m.command.push(body);
        const sub = subjek((body.payload[0].detailInvoice as Array<{ invoiceNo: string }>).map((d) => d.invoiceNo));
        const milik = { clientRef: body.clientRef, targetDbId: m.sesiDb.id };
        if (opsi.commandTakSampai) return r.abort("connectionreset");
        const sebelum = attempts[sub];
        attempts[sub] = attempt({ state: "sending", status: "sending", ageSeconds: 0, ...milik });
        if (opsi.tahanCommand) await opsi.tahanCommand;
        const j = antri.command.shift() ?? { status: 200, body: { attemptId: "at-1", state: "posted", accurateId: "9001", accurateNumber: "PP/2610/0031", message: "", response: { s: true }, persisted: true } };
        const isi = j === "putus" ? null : (j.body as { state?: string; claimed?: boolean; code?: string; live?: { state: string; stale?: boolean; accurateNumber?: string } | null } | undefined);
        if (j !== "putus" && j.status === 200 && isi?.state === "posted") attempts[sub] = attempt({ state: "posted", status: "posted", accurateNumber: "PP/2610/0031", ageSeconds: 1, ...milik });
        // Tanpa klaim (claimed:false, subjek dibuka ulang): server tidak membuat attempt — yang terakhir tetap yang tampil.
        else if (isi?.claimed === false || isi?.code === "reopened_use_repost") { if (sebelum) attempts[sub] = sebelum; else delete attempts[sub]; }
        else if (isi?.live) attempts[sub] = attempt({ state: isi.live.state, status: isi.live.state === "sending" ? (isi.live.stale ? "stale" : "sending") : isi.live.state, stale: Boolean(isi.live.stale), accurateNumber: isi.live.accurateNumber ?? "", ...milik });
        else if (isi?.state === "not_sent") attempts[sub] = attempt({ state: "not_sent", status: "failed", ageSeconds: 1, ...milik });
        else attempts[sub] = attempt({ ageSeconds: 1, ...milik });
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

/** Akun tanpa kunci `kunci` (admin LOCAL_AUTH_BYPASS memegang semua): array permKeys di payload RSC halaman diganti — pola fiori-antrean-faktur. */
async function tanpaIzin(page: Page, kunci: string[]) {
    await page.route((u) => u.pathname === "/finance", async (route) => {
        const res = await route.fetch();
        const headers = { ...res.headers() };
        delete headers["content-length"];
        delete headers["content-encoding"];
        const body = (await res.text()).replace(/permKeys(\\?)":\[([^\]]*)\]/g, (_, e: string, isi: string) =>
            `permKeys${e}":[${isi.split(",").filter((k) => !kunci.some((x) => k.includes(`"${x}`))).join(",")}]`);
        return route.fulfill({ status: res.status(), headers, body });
    });
}

test.use({
    // Dokumen dari route.fulfill (tanpaIzin) dianggap bukan jaringan lokal oleh Edge → skrip localhost diblokir. Hanya di peramban tes ini.
    launchOptions: { args: ["--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights"] },
});

test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
    page.on("dialog", (d) => { throw new Error(`window.${d.type()} masih dipakai: ${d.message()}`); });
});

test("Default → Transfer & posting: dialog menyebut isi kiriman, urutan 5 langkah, clientRef lama, sukses = nomor PP + siapa; BL-05 setelahnya (alasan terlihat, tanpa kode BL)", async ({ page }) => {
    const m = await siapkan(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    const { main, detail } = await bukaPengajuan(page);
    // Alasan nonaktif TERLIHAT (bukan hanya title): Simpan tujuan tanpa perubahan, Tandai belum transfer yang sudah belum.
    await expect(detail.getByText("Simpan tujuan: belum ada perubahan tujuan.")).toBeVisible(NAV);
    await expect(detail.getByRole("list", { name: "Alasan aksi nonaktif" })).toContainText("Tandai belum transfer: status sudah Belum transfer.");
    const { dlg } = await bukaDialogPosting(page);
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
    expect(m.command[0].expectedDatabaseId).toBe("DB-1"); // database yang tampil di dialog (A-1)
    expect(m.command[0].payload[0]).toMatchObject({ bankNo: "1102-03", vendorNo: "V-0012", chequeAmount: 48_200_000, paymentMethod: "BANK_TRANSFER",
        transDate: HARI_INI.split("-").reverse().join("/"), detailInvoice: FAKTUR_A.map(([invoiceNo, paymentAmount]) => ({ invoiceNo, paymentAmount })) });
    expect(String(m.command[0].payload[0].description)).toContain("Bukti: proof_20261010_pf-1.pdf");
    expect(m.update[0]).toMatchObject({ status_pembayaran: "Sudah Transfer", accurate_post_status: "posted", accurate_purchase_payment_number: "PP/2610/0031", proof_id: "pf-1", date: HARI_INI });
    // Sukses: nomor PP + siapa (WITA); status transfer terpisah; Belum/Kembalikan nonaktif dengan alasan (BL-05).
    await expect(detail.getByText("Terposting PP/2610/0031").first()).toBeVisible(NAV);
    await expect(detail).toContainText("finance.a@example.invalid");
    await expect(detail.getByText(/Ditransfer \d{2}\/\d{2}\/\d{4}/).first()).toBeVisible();
    await expect(detail.getByRole("button", { name: "Kembalikan ke Pembayaran" })).toBeDisabled();
    await expect(detail.getByRole("list", { name: "Alasan aksi nonaktif" })).toContainText("status transfer tidak bisa dikembalikan");
    await expect(main).not.toContainText(/BL-\d/);
    await expect(detail.getByRole("button", { name: "Transfer & posting…" })).toBeDisabled();
    await expect(detail.getByText("Sudah terposting di Accurate. Pembatalan lewat dokumen pembalik di Accurate.")).toBeVisible();
    await page.screenshot({ path: "test-results/fiori-finance-sukses.png", fullPage: true });
});

const TIDAK_PASTI: Array<[string, Jawab]> = [
    ["502 HTML gateway", { status: 502, html: "<html><body><h1>502 Bad Gateway</h1>nginx</body></html>" }],
    ["koneksi putus", "putus"],
    ["200 state unknown (timeout)", { status: 200, body: { attemptId: "at-1", state: "unknown", accurateId: "", accurateNumber: "", message: "tanpa jawaban (TimeoutError). Coba lagi.", persisted: true } }],
    ["409 unknown", { status: 409, body: { error: "Ada attempt posting yang belum pasti untuk faktur ini — periksa Accurate lalu selesaikan manual.", live: { attemptId: "at-0", state: "unknown", accurateId: "", accurateNumber: "", targetDbId: "DB-1", sameRecord: true, sameTarget: true, stale: true }, generation: 0, currentGeneration: 0 } }],
    // Putaran 2 A: claimed:false dengan kode 409 yang TIDAK terdaftar (konflik attempt kelak) tetap tidak pasti — bukan "failed".
    ["409 claimed:false kode lain", { status: 409, body: { code: "attempt_conflict", claimed: false, live: null, error: "Konflik attempt posting untuk faktur ini (uji)." } }],
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
        // Bukti sudah terunggah: draf berkas dibersihkan (tidak tampil "draf", tidak ada peringatan perubahan belum disimpan).
        await expect(detail.getByText("Bukti tersimpan")).toBeVisible(NAV);
        await expect(main.getByRole("list", { name: "Daftar pengajuan" }).getByRole("button", { name: /DRAFT-0418/ })).not.toContainText("draf");
    });
}

test("A-2/B-2: terposting lalu catatan Finance gagal → belum pasti + nomor PP; tab yang sama bisa 'Catat hasil posting' tanpa kiriman baru", async ({ page }) => {
    test.setTimeout(90_000); // dua kiriman + dua muat ulang: 30 dtk bawaan habis pada jalankan penuh (tinjauan putaran 2)
    const m = await siapkan(page, {
        command: [
            { status: 200, body: { attemptId: "at-1", state: "posted", accurateId: "9001", accurateNumber: "PP/2610/0031", message: "", response: { s: true }, persisted: true } },
            { status: 409, body: { error: "Himpunan faktur ini SUDAH diposting (PP/2610/0031).", live: { attemptId: "at-1", state: "posted", accurateId: "9001", accurateNumber: "PP/2610/0031", targetDbId: "DB-1", sameRecord: true, sameTarget: true, stale: true }, generation: 0, currentGeneration: 0 } },
        ],
        update: [{ status: 500, body: { ok: false, error: "Gagal menulis data pembayaran." } }],
    });
    const { main, detail, dlg } = await bukaDialogPosting(page);
    await dlg.getByRole("button", { name: "Posting Rp 48.200.000" }).click();
    const strip = main.getByRole("status").filter({ hasText: "Hasilnya belum pasti — DRAFT-0418 dikunci." });
    await expect(strip).toContainText("Accurate menjawab Purchase Payment PP/2610/0031", NAV);
    expect(m.update.map((u) => u.accurate_post_status)).toEqual(["posted", "unknown"]);
    // Muat ulang: server = terposting (catatan tertinggal). Kunci lokal tab ini TIDAK boleh membuat tombolnya buntu.
    const catat = detail.getByRole("button", { name: "Catat hasil posting…" });
    await expect(catat).toBeEnabled(NAV);
    await catat.click();
    await page.getByRole("dialog", { name: "Catat hasil posting yang sudah ada?" }).getByRole("button", { name: "Catat hasil posting" }).click();
    await expect(main.getByRole("status").filter({ hasText: "Terposting PP/2610/0031" })).toContainText("Hasil posting sebelumnya dicatat", NAV);
    expect(m.command).toHaveLength(2); // kiriman kedua dijawab 409 posted oleh server — bukan purchase-payment kedua
    expect(m.update.at(-1)).toMatchObject({ accurate_post_status: "posted", accurate_purchase_payment_number: "PP/2610/0031" });
    await expect(detail.getByRole("button", { name: "Transfer & posting…" })).toBeDisabled(NAV);
});

test("A-3: attempt posted himpunan faktur sama dari record lain = TIDAK PASTI (bukan terposting) di record ini", async ({ page }) => {
    const sub = subjek(FAKTUR_A.map(([f]) => f));
    await siapkan(page, {
        rows: () => [pengajuan("DRAFT-0418", "PRINCIPLE A", FAKTUR_A), pengajuan("DRAFT-0419", "PRINCIPLE A", FAKTUR_A)],
        attempts: { [sub]: attempt({ state: "posted", status: "posted", accurateNumber: "PP/2610/0031", stale: true, ageSeconds: 900 }) },
    });
    const { main, detail } = await bukaPengajuan(page, "DRAFT-0419");
    const daftar = main.getByRole("list", { name: "Daftar pengajuan" });
    await expect(daftar.getByRole("button", { name: /DRAFT-0418/ })).toContainText("Terposting PP/2610/0031");
    await expect(daftar.getByRole("button", { name: /DRAFT-0419/ })).toContainText("Posting tidak pasti");
    await expect(detail.getByText("Posting tidak pasti — pengajuan dikunci.")).toBeVisible(NAV);
    await expect(detail.getByRole("button", { name: "Catat hasil posting…" })).toHaveCount(0);
    await expect(detail.getByRole("button", { name: "Transfer & posting…" })).toBeDisabled();
});

test("A-4: 200 not_sent (tak pernah terhubung) = 'tidak sampai ke Accurate', Posting gagal, boleh diposting ulang — bukan 'Accurate menolak'", async ({ page }) => {
    const m = await siapkan(page, { command: [{ status: 200, body: { attemptId: "at-1", state: "not_sent", accurateId: "", accurateNumber: "", message: "tidak terhubung ke Accurate (ECONNREFUSED)", persisted: true } }] });
    const { main, detail, dlg } = await bukaDialogPosting(page);
    await dlg.getByRole("button", { name: "Posting Rp 48.200.000" }).click();
    await expect(main.getByRole("alert").filter({ hasText: "Posting DRAFT-0418 tidak sampai ke Accurate." })).toContainText("Tidak ada yang tersimpan di Accurate", NAV);
    await expect(main).not.toContainText("Accurate menolak");
    expect(m.update.at(-1)).toMatchObject({ accurate_post_status: "failed" });
    await expect(detail.getByRole("button", { name: "Transfer & posting…" })).toBeEnabled(NAV);
});

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

test("A-1 database dikunci ke kiriman: dialog membaca database SEGAR; berganti sebelum/sesudah dialog dibuka = tanpa tulis; 409 server = tidak terkirim", async ({ page }) => {
    const m = await siapkan(page, { command: [{ status: 409, body: { code: "database_changed", claimed: false, live: null,
        error: "Database Accurate berganti sejak dialog dibuka (sekarang PT CONTOH B). Tidak ada yang dikirim ke Accurate; muat ulang lalu periksa tujuan." } }] });
    const { main, detail } = await bukaPengajuan(page);
    await expect(detail.getByLabel("Pemasok")).toHaveValue("V-0012", NAV);
    await detail.getByLabel("Bukti transfer").setInputFiles(PDF);
    // 1) Tab lain membuka database B setelah daftar dimuat: dialog menyebut B (bukan A dari daftar) dan terkunci dengan alasan TERLIHAT.
    m.sesiDb = { id: "DB-2", alias: "PT CONTOH B" };
    await detail.getByRole("button", { name: "Transfer & posting…" }).click();
    const dlg = page.getByRole("dialog", { name: "Posting Purchase Payment ke Accurate?" });
    await expect(dlg).toContainText("PT CONTOH B", NAV);
    await expect(dlg).not.toContainText("PT CONTOH A");
    await expect(dlg.getByText(/^Database Accurate berganti sejak daftar dimuat \(sekarang PT CONTOH B\)/)).toBeVisible();
    await expect(dlg.getByRole("button", { name: "Posting Rp 48.200.000" })).toBeDisabled();
    await dlg.getByRole("button", { name: "Batal" }).click();
    // 2) Kembali ke A, dialog dibuka (A), lalu sesi berganti ke B sebelum konfirmasi: klien berhenti SEBELUM simpan tujuan.
    m.sesiDb = { id: "DB-1", alias: "PT CONTOH A" };
    await detail.getByRole("button", { name: "Transfer & posting…" }).click();
    await expect(dlg).toContainText("PT CONTOH A", NAV);
    m.sesiDb = { id: "DB-2", alias: "PT CONTOH B" };
    await dlg.getByRole("button", { name: "Posting Rp 48.200.000" }).click();
    await expect(dlg.getByRole("alert")).toContainText("Database Accurate berganti sejak dialog dibuka (sekarang PT CONTOH B)", NAV);
    expect(m.urutan).toEqual([]);
    // 3) Celah waktu: klien melihat A, server melihat B → 409 database_changed {claimed:false} = pasti tidak terkirim, TIDAK dikunci.
    m.sesiDb = { id: "DB-1", alias: "PT CONTOH A" };
    await dlg.getByRole("button", { name: "Batal" }).click();
    await detail.getByRole("button", { name: "Transfer & posting…" }).click();
    await expect(dlg).toContainText("PT CONTOH A", NAV);
    await dlg.getByRole("button", { name: "Posting Rp 48.200.000" }).click();
    await expect(main.getByRole("alert").filter({ hasText: "Tidak ada yang dikirim ke Accurate untuk DRAFT-0418." })).toBeVisible(NAV);
    expect(m.command).toHaveLength(1);
    expect(m.command[0].expectedDatabaseId).toBe("DB-1");
    expect(m.update.at(-1)).toMatchObject({ accurate_post_status: "failed" });
    await expect(detail.getByRole("button", { name: "Transfer & posting…" })).toBeEnabled(NAV);
    await expect(detail.getByText("Posting tidak pasti — pengajuan dikunci.")).toHaveCount(0);
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
    await dlg.getByRole("radio", { name: "Ada di Accurate", exact: true }).check();
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

test("Putaran 2 B-3: dialog Selesaikan membaca sesi Accurate SEGAR — berganti database sesudah daftar dimuat = terkunci dengan alasan", async ({ page }) => {
    const sub = subjek(FAKTUR_A.map(([f]) => f));
    const m = await siapkan(page, {
        rows: () => [pengajuan("DRAFT-0418", "PRINCIPLE A", FAKTUR_A, { status_pembayaran: "Sudah Transfer", transfer_date: HARI_INI, accurate_post_status: "unknown", transfer_proof: { proof_id: "pf-0", original_filename: "b.pdf" } })],
        attempts: { [sub]: attempt({ state: "sending", status: "stale", stale: true, ageSeconds: 600 }) },
    });
    const { detail } = await bukaPengajuan(page);
    await expect(detail.getByText("Posting tidak pasti — pengajuan dikunci.")).toBeVisible(NAV);
    m.sesiDb = { id: "DB-2", alias: "PT CONTOH B" }; // tab lain membuka database B setelah daftar dimuat
    await detail.getByRole("button", { name: "Selesaikan…" }).click();
    const dlg = page.getByRole("dialog", { name: "Selesaikan posting tidak pasti" });
    await expect(dlg.getByText("Percobaan dikirim ke database lain (ID DB-1); sesi Anda PT CONTOH B. Buka database itu dulu.")).toBeVisible(NAV);
    await expect(dlg).not.toContainText("sama dengan database percobaan");
    await dlg.getByRole("radio", { name: "Tidak ada di Accurate" }).check();
    await dlg.getByLabel("Diperiksa di").fill("Accurate › Pembayaran Pembelian");
    await dlg.getByLabel("Alasan").fill("Tidak ada pembayaran dengan faktur ini di Accurate.");
    await expect(dlg.getByRole("button", { name: "Simpan penyelesaian" })).toBeDisabled();
    // Kembali ke database A: buka ulang dialog = bacaan segar lagi.
    m.sesiDb = { id: "DB-1", alias: "PT CONTOH A" };
    await dlg.getByRole("button", { name: "Batal" }).click();
    await detail.getByRole("button", { name: "Selesaikan…" }).click();
    await expect(dlg.getByText("Sesi Accurate Anda (PT CONTOH A) sama dengan database percobaan.")).toBeVisible(NAV);
    expect(m.resolve).toHaveLength(0);
});

test("A-5: already_posted dengan nomor berbeda dari attempt server ditolak di dialog; nomor sama → catatan posted", async ({ page }) => {
    const sub = subjek(FAKTUR_A.map(([f]) => f));
    const m = await siapkan(page, {
        rows: () => [pengajuan("DRAFT-0418", "PRINCIPLE A", FAKTUR_A, { status_pembayaran: "Sudah Transfer", transfer_date: HARI_INI, accurate_post_status: "unknown", transfer_proof: { proof_id: "pf-0", original_filename: "b.pdf" } })],
        attempts: { [sub]: attempt({ ageSeconds: 30 }) },
        resolve: [{ status: 409, body: { ok: false, code: "already_posted", error: "sudah posted PP/2610/0031" } }, { status: 409, body: { ok: false, code: "already_posted", error: "sudah posted PP/2610/0031" } }],
    });
    const { main, detail } = await bukaPengajuan(page);
    await detail.getByRole("button", { name: "Selesaikan…" }).click();
    const dlg = page.getByRole("dialog", { name: "Selesaikan posting tidak pasti" });
    // Sementara itu tab lain mencatat attempt ini TERPOSTING PP/2610/0031.
    m.attempts[sub] = attempt({ state: "posted", status: "posted", accurateNumber: "PP/2610/0031", ageSeconds: 200 });
    await dlg.getByRole("radio", { name: "Ada di Accurate", exact: true }).check();
    await dlg.getByLabel("Nomor Purchase Payment").fill("PP/2610/0099");
    await dlg.getByLabel("Diperiksa di").fill("Accurate › Pembayaran Pembelian");
    await dlg.getByLabel("Alasan").fill("Pembayaran ada dengan nilai dan faktur yang sama.");
    await dlg.getByRole("button", { name: "Simpan penyelesaian" }).click();
    await expect(dlg.getByRole("alert")).toContainText("TERPOSTING sebagai PP/2610/0031, berbeda dengan nomor yang Anda isi (PP/2610/0099)", NAV);
    expect(m.update).toHaveLength(0);
    await dlg.getByLabel("Nomor Purchase Payment").fill("pp/2610/0031");
    await dlg.getByRole("button", { name: "Simpan penyelesaian" }).click();
    await expect(main.getByRole("status").filter({ hasText: "ditandai terposting PP/2610/0031" })).toBeVisible(NAV);
    expect(m.update.at(-1)).toMatchObject({ accurate_post_status: "posted", accurate_purchase_payment_number: "PP/2610/0031" });
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

test("B-5: pengajuan berubah sejak dimuat (nilai diubah di tab lain) → batal SEBELUM tulis apa pun; data sama → lanjut", async ({ page }) => {
    const m = await siapkan(page);
    const { main, dlg } = await bukaDialogPosting(page);
    m.rows[0].total_nilai = 47_000_000; // diubah orang lain setelah daftar dimuat
    await dlg.getByRole("button", { name: "Posting Rp 48.200.000" }).click();
    await expect(dlg.getByRole("alert")).toContainText("Pengajuan berubah sejak dimuat (nilai dibayar); tidak ada yang dikirim.", NAV);
    expect(m.urutan).toEqual([]);
    m.rows[0].total_nilai = 48_200_000; // kembali sama → lanjut
    await dlg.getByRole("button", { name: "Posting Rp 48.200.000" }).click();
    await expect(main.getByRole("status").filter({ hasText: "Terposting PP/2610/0031" })).toBeVisible(NAV);
    expect(m.urutan).toEqual(["mapping", "proof", "command", "update:posted"]);
});

test("B-4: Selesaikan separuh jalan (resolve tercatat, catatan Finance 400) → dialog ditutup, muat ulang, 'periksa status' — bukan 'Ulangi'", async ({ page }) => {
    const sub = subjek(FAKTUR_A.map(([f]) => f));
    const m = await siapkan(page, {
        rows: () => [pengajuan("DRAFT-0418", "PRINCIPLE A", FAKTUR_A, { accurate_post_status: "unknown" })],
        attempts: { [sub]: attempt({ ageSeconds: 30 }) },
        update: [{ status: 400, body: { ok: false, error: "Tanggal transfer wajib diisi untuk status Sudah Transfer." } }],
    });
    const { main, detail } = await bukaPengajuan(page);
    await detail.getByRole("button", { name: "Selesaikan…" }).click();
    const dlg = page.getByRole("dialog", { name: "Selesaikan posting tidak pasti" });
    await dlg.getByRole("radio", { name: "Ada di Accurate", exact: true }).check();
    await dlg.getByLabel("Nomor Purchase Payment").fill("PP/2610/0030");
    await dlg.getByLabel("Diperiksa di").fill("Accurate › Pembayaran Pembelian");
    await dlg.getByLabel("Alasan").fill("Pembayaran ada dengan nilai dan faktur yang sama.");
    const muat = m.dataDates.length;
    await dlg.getByRole("button", { name: "Simpan penyelesaian" }).click();
    const strip = main.getByRole("status").filter({ hasText: "Penyelesaian baru tercatat sebagian." });
    await expect(strip).toContainText("periksa status pengajuan setelah dimuat ulang", NAV);
    await expect(strip).toContainText("Tanggal transfer wajib diisi");
    await expect(dlg).toBeHidden();
    await expect(main.getByText(/Ulangi/)).toHaveCount(0);
    await expect.poll(() => m.dataDates.length, NAV).toBeGreaterThan(muat);
    expect(m.resolve).toHaveLength(1);
    await expect(detail.getByText("Posting tidak pasti — pengajuan dikunci.")).toBeVisible(NAV);
});

test("B-6: gagal muat ulang dengan data masih tampil = tulis terkunci berlasan; galat JSON FastAPI tanpa 'localhost'", async ({ page }) => {
    const m = await siapkan(page);
    const { main, detail } = await bukaPengajuan(page);
    await detail.getByLabel("Bukti transfer").setInputFiles(PDF);
    await expect(detail.getByRole("button", { name: "Transfer & posting…" })).toBeEnabled(NAV);
    m.dataGagal = { status: 500, body: { ok: false, error: "Gagal membaca http://localhost:8000/payments/finance/data (localhost:8000 tidak menjawab)" } };
    await main.getByRole("button", { name: "Muat ulang", exact: true }).click();
    const strip = main.getByRole("alert").filter({ hasText: "Gagal memuat ulang pengajuan." });
    await expect(strip).toBeVisible(NAV);
    await expect(strip).toContainText("Gagal membaca server");
    await expect(main).not.toContainText("localhost");
    // Data sebelumnya tetap tampil, tetapi semua tulis terkunci dengan alasan TERLIHAT.
    await expect(main.getByRole("list", { name: "Daftar pengajuan" }).getByRole("button", { name: /DRAFT-0418/ })).toBeVisible();
    await expect(detail.getByRole("button", { name: "Transfer & posting…" })).toBeDisabled();
    await expect(detail.getByText("Data gagal dimuat ulang; yang tampil hasil sebelumnya. Muat ulang dulu.", { exact: true })).toBeVisible();
    await expect(detail.getByRole("button", { name: "Kembalikan ke Pembayaran" })).toBeDisabled();
    expect(m.urutan).toEqual([]);
});

test("B-6: kunci lokal — kiriman putus sebelum server mencatat apa pun & catatan unknown gagal: tab ini tetap mengunci, tab baru tidak", async ({ context }) => {
    test.setTimeout(60_000);
    const m = await siapkan(context, { commandTakSampai: true, update: [{ status: 500, body: { ok: false, error: "Gagal menulis data pembayaran." } }] });
    const a = await context.newPage();
    const { main, detail, dlg } = await bukaDialogPosting(a);
    await dlg.getByRole("button", { name: "Posting Rp 48.200.000" }).click();
    await expect(main.getByRole("status").filter({ hasText: "Hasilnya belum pasti — DRAFT-0418 dikunci." })).toBeVisible(NAV);
    expect(m.update.map((u) => u.accurate_post_status)).toEqual(["unknown"]); // catatan ditolak server: tidak ada yang tersimpan
    // Setelah muat ulang server tidak tahu apa-apa (tanpa attempt, tanpa catatan) — hanya kunci lokal tab ini yang menahan.
    await expect(detail.getByText("Posting tidak pasti — pengajuan dikunci.")).toBeVisible(NAV);
    await expect(detail.getByRole("button", { name: "Transfer & posting…" })).toBeDisabled();
    await expect(detail.getByRole("button", { name: "Selesaikan…" })).toBeEnabled();
    const b = await context.newPage();
    const { detail: detailB } = await bukaPengajuan(b);
    await expect(b.locator("main").getByRole("list", { name: "Daftar pengajuan" }).getByRole("button", { name: /DRAFT-0418/ })).toContainText("Belum diposting", NAV);
    await expect(detailB.getByText("Posting tidak pasti — pengajuan dikunci.")).toHaveCount(0);
});

test("Putaran 2 B-4: kunci lokal lepas saat muat ulang menunjukkan status final dari orang lain; catatan gagal tanpa penyelesaian baru tetap dikunci", async ({ page }) => {
    test.setTimeout(90_000);
    const m = await siapkan(page, { commandTakSampai: true, update: [{ status: 500, body: { ok: false, error: "Gagal menulis data pembayaran." } }] });
    const { main, detail, dlg } = await bukaDialogPosting(page);
    await dlg.getByRole("button", { name: "Posting Rp 48.200.000" }).click();
    await expect(main.getByRole("status").filter({ hasText: "Hasilnya belum pasti — DRAFT-0418 dikunci." })).toBeVisible(NAV);
    await expect(detail.getByText("Posting tidak pasti — pengajuan dikunci.")).toBeVisible(NAV);
    const muatUlang = async () => {
        const n = m.dataDates.length;
        await main.getByRole("button", { name: "Muat ulang", exact: true }).click();
        await expect.poll(() => m.dataDates.length, NAV).toBeGreaterThan(n);
        await expect(main.getByText("memperbarui…")).toHaveCount(0, NAV);
    };
    const bukti = { proof_id: "pf-1", original_filename: "bukti_0418.pdf", stored_filename: "proof_x.pdf" };
    // Catatan "gagal" tanpa penyelesaian baru (mis. tab lain): belum bukti apa pun tentang kiriman tab ini — tetap dikunci.
    Object.assign(m.rows[0], { status_pembayaran: "Sudah Transfer", transfer_date: HARI_INI, transfer_proof: bukti, accurate_post_status: "failed", accurate_post_error: "Accurate menolak: vendor" });
    await muatUlang();
    await expect(detail.getByText("Posting tidak pasti — pengajuan dikunci.")).toBeVisible(NAV);
    await expect(detail.getByRole("button", { name: "Transfer & posting…" })).toBeDisabled();
    // Finance lain menyelesaikannya "Tidak ada di Accurate" (penyelesaian baru): status final → kunci lokal lepas.
    m.rows[0].accurate_post_resolution = { from: "unknown", to: "failed", source: "manual_attestation", by: "betterauth|finance|finance.b@example.invalid", at: `${HARI_INI} 09:10:00`, note: "dicek manual di Accurate: tidak ditemukan — Pembayaran Pembelian" };
    m.rows[0].accurate_post_error = "dicek manual: tidak ada di Accurate";
    await muatUlang();
    await expect(detail.getByText("Posting tidak pasti — pengajuan dikunci.")).toHaveCount(0, NAV);
    await expect(detail.getByRole("button", { name: "Transfer & posting…" })).toBeEnabled(NAV);
});

test("B-6: tanpa izin ubah Finance (finance.update) — posting, tujuan, dan status nonaktif dengan alasan berkalimat yang TERLIHAT", async ({ page }) => {
    await siapkan(page);
    await tanpaIzin(page, ["finance.update"]);
    const { detail } = await bukaPengajuan(page);
    await expect(detail.getByRole("button", { name: "Transfer & posting…" })).toBeDisabled(NAV);
    await expect(detail.getByText(/^Akun Anda belum berwenang mencatat transfer dan memposting ke Accurate/)).toBeVisible();
    await expect(detail.getByLabel("Pemasok")).toHaveCount(0); // tujuan baca-saja
    await expect(detail.getByText(/^Akun Anda belum berwenang mengubah data Finance/).first()).toBeVisible();
    await expect(detail.getByRole("button", { name: "Kembalikan ke Pembayaran" })).toBeDisabled();
    await expect(detail.getByRole("list", { name: "Alasan aksi nonaktif" })).toContainText("belum berwenang mengubah data Finance");
    await expect(detail).not.toContainText("finance.update");
});

test("Putaran 2 B-1: tanpa izin selesaikan (finance.resolve_unknown) — catatan Finance Tidak pasti + attempt posted: Catat hasil posting nonaktif berkalimat", async ({ page }) => {
    const sub = subjek(FAKTUR_A.map(([f]) => f));
    const m = await siapkan(page, {
        rows: () => [pengajuan("DRAFT-0418", "PRINCIPLE A", FAKTUR_A, { status_pembayaran: "Sudah Transfer", transfer_date: HARI_INI, accurate_post_status: "unknown",
            transfer_proof: { proof_id: "pf-0", original_filename: "b.pdf" } })],
        attempts: { [sub]: attempt({ state: "posted", status: "posted", accurateNumber: "PP/2610/0031", ageSeconds: 200 }) },
    });
    await tanpaIzin(page, ["finance.resolve_unknown"]);
    const { main, detail } = await bukaPengajuan(page);
    const catat = detail.getByRole("button", { name: "Catat hasil posting…" });
    await expect(catat).toBeDisabled(NAV);
    await expect(detail.getByText(/^Catatan Finance pengajuan ini masih Tidak pasti/).first()).toBeVisible();
    await expect(main).not.toContainText("resolve_unknown");
    await expect(main).not.toContainText(/tekan Catat hasil posting/i);
    expect(m.command).toHaveLength(0);
    expect(m.update).toHaveLength(0);
});

test("Putaran 2 B-1: tanpa izin selesaikan — terposting lalu catatan Finance gagal: pesan hasil tidak menyuruh menekan tombol yang akan ditolak", async ({ page }) => {
    test.setTimeout(90_000);
    const m = await siapkan(page, { update: [{ status: 500, body: { ok: false, error: "Gagal menulis data pembayaran." } }] });
    await tanpaIzin(page, ["finance.resolve_unknown"]);
    const { main, detail, dlg } = await bukaDialogPosting(page);
    await dlg.getByRole("button", { name: "Posting Rp 48.200.000" }).click();
    const strip = main.getByRole("status").filter({ hasText: "Hasilnya belum pasti — DRAFT-0418 dikunci." });
    await expect(strip).toContainText("hanya Finance yang berwenang mencatatnya", NAV);
    await expect(strip).not.toContainText(/tekan Catat hasil posting/i);
    expect(m.update.map((u) => u.accurate_post_status)).toEqual(["posted", "unknown"]);
    // Setelah muat ulang: catatan Finance unknown + attempt posted → tombol terkunci dengan alasan berkalimat.
    await expect(detail.getByRole("button", { name: "Catat hasil posting…" })).toBeDisabled(NAV);
    await expect(main).not.toContainText("resolve_unknown");
    expect(m.command).toHaveLength(1);
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
    await main.getByRole("button", { name: "Muat ulang", exact: true }).click();
    await expect(main.getByRole("status").filter({ hasText: "Status posting dari server tidak terbaca." })).toBeVisible(NAV);
    // B-3: tak terbaca ≠ "Belum diposting"; tidak dihitung ke kartu posting mana pun.
    await expect(main.getByRole("list", { name: "Daftar pengajuan" }).getByRole("button", { name: /DRAFT-0418/ })).toContainText("Status posting tidak terbaca");
    await expect(main.getByText("Belum diposting")).toHaveCount(0);
    await expect(main.getByRole("button", { name: /^Posting tidak pasti\s*0/ })).toBeVisible();
    await expect(main.getByRole("button", { name: /^Terposting\s*0/ })).toBeVisible();
    await main.getByRole("list", { name: "Daftar pengajuan" }).getByRole("button", { name: /DRAFT-0418/ }).click();
    const detail = main.getByRole("region", { name: "Detail pengajuan" });
    await detail.getByLabel("Bukti transfer").setInputFiles(PDF);
    await expect(detail.getByRole("button", { name: "Transfer & posting…" })).toBeDisabled();
    await expect(detail.getByText("Status posting dari server tidak terbaca; muat ulang dulu.", { exact: true })).toBeVisible();
});

test("Klik ganda konfirmasi = satu POST; dua tab: tab kedua melihat 'Sedang diposting' dan tidak bisa memposting", async ({ context }) => {
    test.setTimeout(60_000); // dua tab = dua kompilasi halaman di server dev
    let lepas!: () => void;
    const m = await siapkan(context, { tahanCommand: new Promise<void>((ok) => { lepas = ok; }) });
    const a = await context.newPage();
    const { main, dlg } = await bukaDialogPosting(a);
    // Dua klik dalam SATU tugas JS: React belum merender ulang (atribut disabled belum terpasang), jadi yang menahan kiriman kedua
    // adalah penjaga ref (ConfirmDialog inFlight / postingRef) — bukan disabled.
    const konfirmasi = dlg.getByRole("button", { name: "Posting Rp 48.200.000" });
    await expect(konfirmasi).toBeEnabled(NAV);
    await konfirmasi.evaluate((el: HTMLElement) => { el.click(); el.click(); });
    await expect.poll(() => m.command.length, NAV).toBe(1); // klaim server sudah ada (attempt 'sending') sebelum tab kedua dibuka
    const b = await context.newPage();
    const { detail: detailB } = await bukaPengajuan(b);
    await expect(detailB.getByText("Sedang diposting dari sesi atau tab lain.")).toBeVisible(NAV);
    await expect(detailB.getByRole("button", { name: "Transfer & posting…" })).toBeDisabled();
    lepas();
    await a.bringToFront(); // tab latar bisa ditahan peramban; hasil dibaca di tab yang mengirim
    await expect(main.getByRole("status").filter({ hasText: "Terposting PP/2610/0031" })).toBeVisible(NAV);
    expect(m.command).toHaveLength(1);
    await b.locator("main").getByRole("button", { name: "Muat ulang", exact: true }).click();
    await expect(detailB.getByText("Terposting PP/2610/0031").first()).toBeVisible(NAV);
});

test("Ponsel 390 px: daftar ↔ detail tanpa gulir menyamping; draf tujuan ditandai", async ({ page }) => {
    const m = await siapkan(page);
    await page.setViewportSize({ width: 390, height: 844 });
    const { main, detail } = await bukaPengajuan(page, "DRAFT-0411");
    await expect(detail.getByLabel("Rekening bank")).toBeVisible(NAV);
    await expect(detail.getByText("Rekening wajib sebelum posting.")).toBeVisible();
    await detail.getByLabel("Rekening bank").selectOption("1101-01");
    await expect(detail.getByText("Draf belum disimpan")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: "test-results/fiori-finance-ponsel.png", fullPage: true });
    await detail.getByRole("button", { name: "Simpan tujuan" }).click();
    await expect(main.getByRole("status").filter({ hasText: "Tujuan PRINCIPLE B tersimpan." })).toBeVisible(NAV);
    expect(m.mapping).toEqual([{ principle: "PRINCIPLE B", vendorNo: "V-0031", vendorName: "PRINCIPLE B", bankNo: "1101-01", bankName: "KAS BESAR" }]);
    await expect(detail.getByText("Draf belum disimpan")).toHaveCount(0, NAV);
    await main.getByRole("button", { name: "Kembali ke daftar" }).click();
    await expect(main.getByRole("list", { name: "Daftar pengajuan" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("Kembalikan ke Pembayaran lewat dialog: tolakan 409 (BL-49) tampil di dialog, lalu berhasil; payload hanya status", async ({ page }) => {
    const m = await siapkan(page, {
        rows: () => [pengajuan("DRAFT-0418", "PRINCIPLE A", FAKTUR_A, { status_pembayaran: "Sudah Transfer", transfer_date: HARI_INI, accurate_post_status: "failed", accurate_post_error: "Accurate menolak: vendor tidak ditemukan" })],
        update: [{ status: 409, body: { ok: false, error: "LPB A sudah terposting di Accurate (PP/1010/1); status tidak bisa dikembalikan ke Ajukan Ulang." } }],
    });
    const { main, detail } = await bukaPengajuan(page);
    await expect(detail.getByText(/^Posting gagal: Accurate menolak: vendor tidak ditemukan\. Boleh diposting ulang/)).toBeVisible(NAV);
    await detail.getByRole("button", { name: "Kembalikan ke Pembayaran" }).click();
    const dlg = page.getByRole("dialog", { name: "Kembalikan DRAFT-0418 ke Pembayaran?" });
    await expect(dlg).toContainText("terbuka lagi di Pembayaran untuk diubah lalu diajukan ulang");
    await dlg.getByRole("button", { name: "Kembalikan ke Pembayaran" }).click();
    await expect(dlg.getByRole("alert")).toContainText("sudah terposting di Accurate (PP/1010/1)");
    await dlg.getByRole("button", { name: "Kembalikan ke Pembayaran" }).click();
    await expect(main.getByRole("status").filter({ hasText: "DRAFT-0418 dikembalikan ke Pembayaran." })).toBeVisible(NAV);
    expect(m.update).toHaveLength(2);
    expect(m.update[1]).toEqual({ principle: "PRINCIPLE A", tipe_pengajuan: "LPB", submission_id: "", draft_id: "DRAFT-0418", date: HARI_INI, status_pembayaran: "Ajukan Ulang" });
    expect(m.command).toHaveLength(0);
});
