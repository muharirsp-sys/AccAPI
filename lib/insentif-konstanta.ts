/*
 * Tujuan: SATU tempat untuk semua konstanta uang skema insentif (Sales GT/MT, SPV, SM, PPh),
 *         supaya bisa diubah dari UI Admin tanpa deploy.
 * Caller: lib/insentif-{sales,mt,spv,sm}-calc & lib/insentif-pph (parameter opsional),
 *         lib/insentif-settings (baca/tulis app_setting), panel Admin insentif-sales.
 * Dependensi: tidak ada — pure, aman diimpor komponen klien.
 * Main Functions: parseKonstanta (gabung setelan tersimpan di atas bawaan), validateKonstanta,
 *   KONSTANTA_FIELDS (metadata untuk merender editor).
 * Side Effects: tidak ada.
 *
 * Kenapa satu blob JSON, bukan satu baris app_setting per angka: angka-angka ini dibaca
 * BERSAMAAN pada setiap hitungan, dan sebagian saling terkait (bobot MT harus berjumlah pool).
 * Satu baris = satu kali baca, satu kali tulis, tidak ada keadaan setengah-berubah.
 *
 * Bawaan di bawah ini adalah aturan yang berlaku sebelum editor ada. Setelan yang belum pernah
 * disimpan, rusak, atau tak terbaca HARUS jatuh ke sini — angka yang hilang tidak boleh
 * diam-diam menggeser nominal ke nol.
 */

export interface Konstanta {
    gt: {
        pool1: number;        // pool 1 principle (exclusive & mix n=1)
        aoAmbang: number;     // penyebut AO skema GT/TT (mode "fixed240")
        bobotAo: number;      // porsi pool utk KPI AO
        bobotValue: number;   // porsi pool utk KPI Value
        mix2: number; mix3: number; mix4: number; mix5: number; // pool per jumlah principle
        ambangBayar: number;  // < ambang → KPI 0; ambang..1 → proporsional; > 1 → cap
    };
    mt: {
        bobotValue: number; bobotEc: number; bobotAo: number; bobotIa: number; // nominal, jumlah = pool 100%
        ambangIa: number;     // ambang khusus IA (KPI MT lain memakai gt.ambangBayar)
    };
    spv: {
        rate1: number;        // rate flat kalau pegang 1 principal
        rateBase: number;     // rate(n) = rateBase + rateFaktor / n
        rateFaktor: number;
        rateFloor: number;    // rate tidak turun di bawah ini
        ambang: number;       // semua-atau-tidak: >= ambang → rate penuh
    };
    sm: {
        ambang1: number; nominal1: number; // strata terendah yang dibayar
        ambang2: number; nominal2: number;
        ambang3: number; nominal3: number; // strata tertinggi
    };
    pph: { rate: number };
}

export const DEFAULT_KONSTANTA: Konstanta = {
    gt: {
        pool1: 1_000_000, aoAmbang: 240, bobotAo: 0.7, bobotValue: 0.3,
        mix2: 1_000_000, mix3: 1_200_000, mix4: 1_400_000, mix5: 1_500_000,
        ambangBayar: 0.9,
    },
    mt: { bobotValue: 350_000, bobotEc: 150_000, bobotAo: 150_000, bobotIa: 350_000, ambangIa: 0.8 },
    spv: { rate1: 1_500_000, rateBase: 200_000, rateFaktor: 1_200_000, rateFloor: 400_000, ambang: 1 },
    sm: {
        ambang1: 0.9, nominal1: 1_500_000,
        ambang2: 1.0, nominal2: 2_500_000,
        ambang3: 1.1, nominal3: 3_500_000,
    },
    pph: { rate: 0.025 },
};

/** Satuan sebuah angka — menentukan cara UI menampilkan & memvalidasi batas atasnya. */
export type KonstantaKind = "rp" | "rasio" | "qty";

export interface KonstantaField {
    /** "gt.bobotAo" — dipakai UI dan validasi; bentuknya selalu "grup.nama". */
    path: string;
    grup: "Sales GT / TT" | "Sales MT" | "SPV" | "SM" | "PPh";
    label: string;
    kind: KonstantaKind;
    catatan?: string;
}

/**
 * Metadata editor. Sengaja daftar datar: satu tempat menambah angka baru, dan UI merender
 * apa pun yang ada di sini tanpa perlu diubah.
 */
export const KONSTANTA_FIELDS: readonly KonstantaField[] = [
    { path: "gt.pool1", grup: "Sales GT / TT", label: "Pool 1 principle", kind: "rp" },
    { path: "gt.mix2", grup: "Sales GT / TT", label: "Pool 2 principle", kind: "rp" },
    { path: "gt.mix3", grup: "Sales GT / TT", label: "Pool 3 principle", kind: "rp" },
    { path: "gt.mix4", grup: "Sales GT / TT", label: "Pool 4 principle", kind: "rp" },
    { path: "gt.mix5", grup: "Sales GT / TT", label: "Pool 5+ principle", kind: "rp", catatan: "Dipakai juga untuk n > 5 (cap)." },
    { path: "gt.bobotAo", grup: "Sales GT / TT", label: "Bobot AO", kind: "rasio", catatan: "Bobot AO + Value idealnya 1,00." },
    { path: "gt.bobotValue", grup: "Sales GT / TT", label: "Bobot Value", kind: "rasio" },
    { path: "gt.aoAmbang", grup: "Sales GT / TT", label: "Ambang AO (mode 240)", kind: "qty" },
    { path: "gt.ambangBayar", grup: "Sales GT / TT", label: "Ambang bayar KPI", kind: "rasio", catatan: "Berlaku juga untuk Value/EC/OA di MT. IA MT punya ambang sendiri." },

    { path: "mt.bobotValue", grup: "Sales MT", label: "Nominal Value", kind: "rp" },
    { path: "mt.bobotEc", grup: "Sales MT", label: "Nominal EC", kind: "rp" },
    { path: "mt.bobotAo", grup: "Sales MT", label: "Nominal OA", kind: "rp" },
    { path: "mt.bobotIa", grup: "Sales MT", label: "Nominal IA", kind: "rp" },
    { path: "mt.ambangIa", grup: "Sales MT", label: "Ambang bayar IA", kind: "rasio" },

    { path: "spv.rate1", grup: "SPV", label: "Rate 1 principal", kind: "rp" },
    { path: "spv.rateBase", grup: "SPV", label: "Rate — konstanta", kind: "rp", catatan: "rate(n) = konstanta + faktor ÷ n, minimum = lantai." },
    { path: "spv.rateFaktor", grup: "SPV", label: "Rate — faktor", kind: "rp" },
    { path: "spv.rateFloor", grup: "SPV", label: "Rate — lantai", kind: "rp" },
    { path: "spv.ambang", grup: "SPV", label: "Ambang bayar", kind: "rasio", catatan: "Semua-atau-tidak: di bawah ambang → Rp 0." },

    { path: "sm.ambang1", grup: "SM", label: "Ambang strata 1", kind: "rasio" },
    { path: "sm.nominal1", grup: "SM", label: "Nominal strata 1", kind: "rp" },
    { path: "sm.ambang2", grup: "SM", label: "Ambang strata 2", kind: "rasio" },
    { path: "sm.nominal2", grup: "SM", label: "Nominal strata 2", kind: "rp" },
    { path: "sm.ambang3", grup: "SM", label: "Ambang strata 3", kind: "rasio" },
    { path: "sm.nominal3", grup: "SM", label: "Nominal strata 3", kind: "rp" },

    { path: "pph.rate", grup: "PPh", label: "Tarif PPh", kind: "rasio" },
];

/** Batas atas wajar per satuan. Bukan aturan bisnis — jaring pengaman salah ketik. */
const BATAS: Record<KonstantaKind, number> = { rp: 100_000_000, rasio: 5, qty: 100_000 };

function kindOf(path: string): KonstantaKind {
    return KONSTANTA_FIELDS.find((f) => f.path === path)?.kind ?? "rp";
}

function ambil(obj: unknown, grup: string, nama: string): unknown {
    if (obj == null || typeof obj !== "object") return undefined;
    const g = (obj as Record<string, unknown>)[grup];
    if (g == null || typeof g !== "object") return undefined;
    return (g as Record<string, unknown>)[nama];
}

/**
 * Gabungkan setelan tersimpan di atas bawaan. Angka yang tidak ada / bukan angka / di luar
 * batas wajar diabaikan (pakai bawaan) — bukan dijadikan 0, karena 0 berarti tidak membayar.
 * Hanya field yang terdaftar di KONSTANTA_FIELDS yang dibaca; kunci asing dibuang.
 */
export function parseKonstanta(raw: unknown): Konstanta {
    const hasil: Konstanta = JSON.parse(JSON.stringify(DEFAULT_KONSTANTA));
    for (const f of KONSTANTA_FIELDS) {
        const [grup, nama] = f.path.split(".");
        const v = ambil(raw, grup, nama);
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > BATAS[f.kind]) continue;
        (hasil[grup as keyof Konstanta] as unknown as Record<string, number>)[nama] = v;
    }
    return hasil;
}

/**
 * Validasi masukan editor. Mengembalikan daftar pesan; kosong = boleh disimpan.
 * Dipakai di route PATCH (trust boundary): angka aneh yang lolos akan mengubah nominal
 * SELURUH perusahaan, dan gejalanya cuma "kok jumlahnya beda".
 */
export function validateKonstanta(raw: unknown): string[] {
    const pesan: string[] = [];
    if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return ["konstanta harus berupa objek."];
    for (const f of KONSTANTA_FIELDS) {
        const [grup, nama] = f.path.split(".");
        const v = ambil(raw, grup, nama);
        if (v === undefined) continue; // tidak dikirim = pakai nilai tersimpan/bawaan
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
            pesan.push(`${f.label} (${f.path}) harus angka >= 0.`);
            continue;
        }
        if (v > BATAS[f.kind]) pesan.push(`${f.label} (${f.path}) melebihi batas wajar ${BATAS[f.kind]}.`);
    }
    // Urutan strata SM harus naik; kalau tidak, strata tengah tak akan pernah kena dan
    // pencapaian tinggi bisa dibayar lebih kecil dari pencapaian rendah.
    const k = parseKonstanta(raw);
    if (!(k.sm.ambang1 < k.sm.ambang2 && k.sm.ambang2 < k.sm.ambang3)) {
        pesan.push("Ambang strata SM harus naik: strata 1 < 2 < 3.");
    }
    if (k.gt.bobotAo + k.gt.bobotValue > 1.000001) {
        pesan.push("Bobot AO + Value tidak boleh lebih dari 1,00.");
    }
    return pesan;
}

/** Ubah satu field pada salinan konstanta. Dipakai editor UI. */
export function setField(k: Konstanta, path: string, nilai: number): Konstanta {
    const [grup, nama] = path.split(".");
    const salinan: Konstanta = JSON.parse(JSON.stringify(k));
    (salinan[grup as keyof Konstanta] as unknown as Record<string, number>)[nama] = nilai;
    return salinan;
}

/** Nilai satu field. Dipakai editor UI (dan test). */
export function getField(k: Konstanta, path: string): number {
    const [grup, nama] = path.split(".");
    return (k[grup as keyof Konstanta] as unknown as Record<string, number>)[nama];
}

export { kindOf as konstantaKind };
