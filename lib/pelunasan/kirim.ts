/**
 * Tujuan: orkestrasi KIRIM Pelunasan (sales-receipt bulk-save) sebagai fungsi murni — dipindah dari cabang sales-receipt
 *   `executeBulkPayload` (`app/(dashboard)/api-wrapper/page.tsx` basis 95859d59, S6e-2 butir 7): lock idempotency → paket 100
 *   lewat /api/proxy → laporan per baris → /api/idempotency/complete. Hasil per baris: terposting | gagal (pasti tidak terkirim)
 *   | tidak_pasti (C11) | ditahan (mirip riwayat Accurate, butuh izin Finance).
 * Caller: app/(dashboard)/api-wrapper/page.tsx (executeBulkPayload); S6e-2b (wizard Pelunasan).
 * Main Functions: kirimPelunasan.
 * Side Effects: HTTP lewat `postJson` DIINJEKSI (lock, proxy, complete); pencarian riwayat (petunjuk) lewat `cariRiwayat` DIINJEKSI.
 *   Tidak ada toast/Excel — pemanggil yang menampilkan.
 */
import { buildSalesReceiptIdempotencyPayload } from "../sales-receipt-fingerprint.ts";
import { memuatPlaceholderAkun, salesReceiptRowReports } from "../sales-receipt-upload.ts";
import type { Bebas } from "./sel.ts";

export type HasilKirim = "terposting" | "gagal" | "tidak_pasti" | "ditahan";
export type BarisHasil = {
    /** Indeks baris di `rows` masukan. */
    index: number;
    /** Nomor paket (mulai 1). */
    paket: number;
    outcome: HasilKirim;
    message: string;
    /** Kode server bila ditolak sebelum kirim (SALES_RECEIPT_LOCK_REQUIRED, database_changed, ACCURATE_HISTORY, …). */
    code?: string;
    /** Nomor sales-receipt Accurate yang identik (ditahan) atau mirip (petunjuk tidak pasti). */
    receiptNumbers?: string[];
    /** Item jawaban Accurate per baris (terposting). */
    item?: unknown;
};
/** `status` HTTP + JSON jawaban (null bila bukan JSON). Galat jaringan = melempar. */
export type JawabanHttp = { status: number; data: unknown };
export type OverrideKirim = { allowDuplicateKeys?: string[]; allowLockedKeys?: string[]; allowHistoryKeys?: string[]; overrideReason?: string };
export type DepsKirim = {
    postJson: (url: string, body: unknown) => Promise<JawabanHttp>;
    /** Database Accurate yang DITAMPILKAN ke pengguna (dikirim ke proxy; berbeda dari sesi = 409 database_changed). */
    expectedDatabaseId: string;
    override?: OverrideKirim;
    /** Petunjuk untuk baris tidak pasti (pratinjauRiwayatAccurate): kunci → nomor mirip. Tidak pernah menaikkan ke terposting. */
    cariRiwayat?: (rows: Bebas[]) => Promise<Map<string, string[]>>;
    lapor?: (p: { tahap: "lock" | "paket"; paket?: number; totalPaket?: number; dari?: number; sampai?: number }) => void;
    ukuranPaket?: number;
};

/**
 * Galat SEBELUM ada yang dikirim (lock ditolak / terblokir / tak terbit / jaringan saat lock): membawa `code` server agar UI
 * memetakan menurut kode (PERMISSION_REQUIRED = pelunasan.kirim, OVERRIDE_PERMISSION_REQUIRED = finance.override_duplicate, …),
 * bukan teks. `sent` selalu false di sini.
 */
export class GalatKirim extends Error {
    readonly code: string;
    readonly status: number;
    readonly sent = false as const;
    constructor(message: string, code: string, status: number) {
        super(message);
        this.name = "GalatKirim";
        this.code = code;
        this.status = status;
    }
}

const PATH = "/api/sales-receipt/bulk-save.do";
/** Penolakan proxy sebelum kirim yang berlaku untuk SEMUA paket berikutnya (sesi/izin/database) — kirim dihentikan. */
const BERHENTI = new Set(["database_changed", "ACCURATE_SESSION_INCOMPLETE", "DATABASE_REQUIRED", "PERMISSION_REQUIRED"]);

type Data = { error?: unknown; code?: unknown; sent?: unknown; rows?: unknown; lockId?: unknown; blockedKeys?: unknown } | null;
const teks = (v: unknown) => (typeof v === "string" ? v : "");

/**
 * Lock + kirim. Galat lock (ditolak, ada yang berubah terblokir, lock tak terbit, jaringan) MELEMPAR GalatKirim {code, status,
 * sent:false} — tidak ada yang dikirim. Setelah lock terbit tidak pernah melempar: setiap baris mendapat hasil.
 */
export async function kirimPelunasan(rows: Bebas[], deps: DepsKirim): Promise<{ lockId: string | null; rows: BarisHasil[] }> {
    const n = rows.length;
    const size = deps.ukuranPaket ?? 100;
    const hasil: BarisHasil[] = new Array(n);
    if (n === 0) return { lockId: null, rows: [] };
    const kunci = rows.map((r) => buildSalesReceiptIdempotencyPayload(r));

    // Butir 8 (pra-cek klien; server juga menolak): akun potongan belum dipilih -> tidak ada yang dikunci/dikirim.
    if (memuatPlaceholderAkun(rows)) {
        return { lockId: null, rows: rows.map((_, index) => ({ index, paket: Math.floor(index / size) + 1, outcome: "gagal", code: "PLACEHOLDER_AKUN",
            message: "Akun potongan belum dipilih (ISI_KODE_AKUN_…). Pilih akun di langkah Akun. Tidak ada yang dikirim." })) };
    }

    deps.lapor?.({ tahap: "lock" });
    const o = deps.override ?? {};
    const lock = await deps.postJson("/api/idempotency/lock", {
        keys: kunci,
        allowDuplicateKeys: o.allowDuplicateKeys ?? [],
        allowLockedKeys: o.allowLockedKeys ?? [],
        allowHistoryKeys: o.allowHistoryKeys ?? [],
        overrideReason: o.overrideReason ?? "",
        expectedDatabaseId: deps.expectedDatabaseId,
    }).catch((e: unknown) => {
        throw new GalatKirim(`Gagal mengunci idempotency (${e instanceof Error ? e.message : String(e)}). Tidak ada yang dikirim.`, "NETWORK", 0);
    });
    const ld = lock.data as Data;
    if (lock.status < 200 || lock.status >= 300) {
        throw new GalatKirim(teks(ld?.error) || "Gagal mengunci idempotency.", teks(ld?.code) || `HTTP_${lock.status}`, lock.status);
    }
    if (Array.isArray(ld?.blockedKeys) && ld.blockedKeys.length > 0) {
        throw new GalatKirim("Beberapa baris berubah status duplikat saat review. Buka ulang review lalu pilih kembali.", "BLOCKED_KEYS", lock.status);
    }
    if (typeof ld?.lockId !== "string" || !ld.lockId) throw new GalatKirim("Lock idempotency tidak diterbitkan server. Tidak ada yang dikirim.", "LOCK_NOT_ISSUED", lock.status);
    const lockId = ld.lockId;

    // Status idempotency dicatat SERVER untuk baris yang diteruskan (SENDING → SUCCESS/UNKNOWN); laporan klien hanya menaikkan
    // atau menandai FAILED baris yang belum pernah dikirim (PROCESSING). Galat laporan diabaikan (baris tetap memblokir).
    const lapor = async (idx: number[], status: "SUCCESS" | "FAILED" | "UNKNOWN") => {
        if (!idx.length) return;
        try {
            await deps.postJson("/api/idempotency/complete", { keys: idx.map((i) => kunci[i].key), lockId, status });
        } catch { /* lihat komentar di atas */ }
    };
    const set = (idx: number[], paket: number, outcome: HasilKirim, message: string, extra: Partial<BarisHasil> = {}) =>
        idx.forEach((index) => { hasil[index] = { index, paket, outcome, message, ...extra }; });

    const totalPaket = Math.ceil(n / size);
    let berhenti: { code: string; message: string } | null = null;

    for (let p = 0; p < totalPaket; p++) {
        const paket = p + 1;
        let idx = Array.from({ length: Math.min(size, n - p * size) }, (_, k) => p * size + k);
        if (berhenti) {
            set(idx, paket, "gagal", `Tidak dikirim: ${berhenti.message}`, { code: berhenti.code });
            await lapor(idx, "FAILED");
            continue;
        }
        deps.lapor?.({ tahap: "paket", paket, totalPaket, dari: idx[0] + 1, sampai: idx[idx.length - 1] + 1 });

        // Paling banyak dua kali per paket: kirim ulang SEKALI sisa paket setelah baris mirip riwayat ditahan server.
        for (let coba = 0; coba < 2 && idx.length; coba++) {
            let jawab: JawabanHttp | null = null;
            let galat = "";
            try {
                jawab = await deps.postJson("/api/proxy", {
                    endpointPath: PATH, method: "POST", payload: idx.map((i) => rows[i]), idempotencyLockId: lockId, expectedDatabaseId: deps.expectedDatabaseId,
                });
            } catch (e) {
                galat = e instanceof Error ? e.message : String(e) || "galat jaringan";
            }
            const d = (jawab?.data ?? null) as Data;
            const code = teks(d?.code);

            if (jawab && jawab.status === 409 && code === "ACCURATE_HISTORY" && Array.isArray(d?.rows)) {
                const ditahan = new Set<number>();
                for (const h of d.rows as Array<{ index?: unknown; reason?: unknown; receiptNumbers?: unknown; detail?: unknown }>) {
                    const i = idx[Number(h.index)];
                    if (i === undefined) continue;
                    ditahan.add(i);
                    const nomor = Array.isArray(h.receiptNumbers) ? h.receiptNumbers.map(String) : [];
                    set([i], paket, "ditahan", h.reason === "ACCURATE_HISTORY_UNREADABLE"
                        ? `Ditahan: riwayat Accurate gagal dibaca (${teks(h.detail) || "galat"}). Tidak dikirim; ulangi atau minta izin Finance.`
                        : `Ditahan: mirip pelunasan di Accurate (${nomor.join(", ") || "tanpa nomor"}). Tidak dikirim; butuh izin Finance.`,
                    { code: teks(h.reason) || "ACCURATE_HISTORY", receiptNumbers: nomor });
                }
                await lapor([...ditahan], "FAILED");
                if (!ditahan.size) {
                    set(idx, paket, "gagal", `Tidak dikirim: ${teks(d?.error) || "ditahan server"}`, { code });
                    await lapor(idx, "FAILED");
                }
                idx = ditahan.size ? idx.filter((i) => !ditahan.has(i)) : [];
                continue;
            }
            // Ditolak SEBELUM diteruskan ke Accurate (C11: pasti tidak terkirim) -> gagal, boleh diulang. Tinjauan A5: `sent:false`
            // hanya dipercaya pada 4xx (penolakan penjaga); 5xx/2xx ber-sent:false = jawaban tak terduga -> tidak pasti di bawah.
            const ditolak4xx = jawab !== null && jawab.status >= 400 && jawab.status < 500;
            if (jawab && ((ditolak4xx && d?.sent === false) || jawab.status === 401 || jawab.status === 403)) {
                const msg = teks(d?.error) || `HTTP ${jawab.status}`;
                set(idx, paket, "gagal", code === "SALES_RECEIPT_LOCK_REQUIRED"
                    ? `${msg}. Tidak ada yang dikirim ke Accurate; kirim ulang butuh override Finance lewat tinjauan.`
                    : `${msg}. Tidak ada yang dikirim ke Accurate.`, code ? { code } : {});
                await lapor(idx, "FAILED");
                if (BERHENTI.has(code) || jawab.status === 401 || jawab.status === 403) berhenti = { code: code || `HTTP_${jawab.status}`, message: msg };
                break;
            }
            // Jawaban Accurate (200) atau galat proxy/jaringan (tanpa jawaban): hanya s:true per baris = terposting; sisanya TIDAK PASTI.
            const reports = jawab && jawab.status === 200
                ? salesReceiptRowReports(idx.length, d)
                : salesReceiptRowReports(idx.length, d ?? undefined, galat || (jawab ? `HTTP ${jawab.status}` : "galat jaringan"));
            const ok = idx.filter((_, k) => reports[k].ok);
            const ragu = idx.filter((_, k) => !reports[k].ok);
            idx.forEach((i, k) => {
                if (reports[k].ok) set([i], paket, "terposting", "", { item: reports[k].item ?? { s: true } });
                // Kebutuhan UI S6e-2b: kode server (mis. 409 database_changed tanpa sent:false) dibawa agar sebabnya bisa dijelaskan;
                // klasifikasi tetap tidak pasti.
                else set([i], paket, "tidak_pasti", reports[k].message, code ? { code } : {});
            });
            await lapor(ok, "SUCCESS");
            await lapor(ragu, "UNKNOWN");
            if (ragu.length && deps.cariRiwayat) {
                // Petunjuk saja (D-22): baris tetap tidak pasti walau sidik jarinya ada di riwayat.
                try {
                    const mirip = await deps.cariRiwayat(ragu.map((i) => rows[i]));
                    for (const i of ragu) {
                        const nomor = mirip.get(kunci[i].key) ?? [];
                        if (nomor.length) hasil[i] = { ...hasil[i], receiptNumbers: nomor, message: `${hasil[i].message} | Ditemukan mirip di riwayat Accurate: ${nomor.join(", ")}` };
                    }
                } catch { /* petunjuk opsional */ }
            }
            break;
        }
        // Kirim ulang sisa paket juga ditahan -> sisanya tidak dikirim lagi (tetap aman: tidak ada yang diteruskan).
        const sisa = idx.filter((i) => !hasil[i]);
        if (sisa.length) {
            set(sisa, paket, "gagal", "Tidak dikirim: sisa paket tertahan dua kali. Kirim ulang dari Tinjau.", { code: "ACCURATE_HISTORY" });
            await lapor(sisa, "FAILED");
        }
    }
    return { lockId, rows: hasil };
}
