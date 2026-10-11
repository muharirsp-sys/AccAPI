/*
 * Tujuan: Rekonsiliasi harian Kasir ↔ Incaso (K1a, BL-59) — lib MURNI tanpa I/O.
 *   (a) alokasi uang pelunasan (chequeAmount = nominal owner) ke ORANG salesman faktur: semua baris milik satu orang -> chequeAmount
 *       PENUH ke orang itu; multi-orang -> per baris invoicePayment, Σ ≠ chequeAmount -> selisihnya ke ember TAK TERALOKASI per
 *       pelunasan (membawa orang[] + arah; tidak pernah dibagi diam-diam); metode OTHERS dikeluarkan;
 *   (b) masterSalesmanId -> kode (accurate_employee.number) -> ORANG (gabungan sales_code_merge per bulan);
 *   (c) rekonsiliasi per orang per hari: klop = sama persis ATAU setoran = total dibulatkan KE ATAS ke kelipatan Rp 100;
 *       Tutup hari terhalang sampai setiap selisih orang DAN setiap ember tak teralokasi dijelaskan (owner 11 Okt, T2);
 *   (d) kunci hari: tutup/kunci tercatat ATAU ≥ 20.00 WITA; dibuka kembali hanya oleh event buka beralasan.
 * Keputusan owner: scratch/fiori-intake/OWNER-ANSWERS-S7-2026-10-10.md (C8 + Kasir 11 Okt). Kontrak: docs/handover/KASIR-KONTRAK.md.
 * Caller: K1b (pembaca Accurate, cache kasir_pelunasan*), K2 (route & UI /kasir), K3 (Beranda).
 * Dependensi: lib/sales-code-merge (applyMergeMap), lib/insentif-payment-date (todayWita), lib/promo-ui (rupiah) — semuanya murni.
 * Main Functions: keSen, senKeTeks, alokasiPelunasan, orangDariKode, orangDariSalesmanId, klop, bulatkanKeAtas100,
 *   rekonsiliasiHari, rencanaSetoranOrang, penghalangTutup, snapshotHari, batasKunci, statusHari, bolehDiubah, hariKerja.
 * Side Effects: tidak ada.
 *
 * SEMUA nominal = SEN (bilangan bulat aman; Rp 1 = 100 sen) — tanpa galat floating. Nominal rusak = RangeError (gagal keras),
 * bukan 0 dan bukan dibulatkan.
 */
import { applyMergeMap } from "../sales-code-merge.ts";
import { todayWita } from "../insentif-payment-date.ts";
import { rupiah } from "../promo-ui.ts";

/** Rupiah dalam sen (bilangan bulat aman). */
export type Sen = number;

const SEN_RP_100 = 100 * 100;

function wajibSen(v: number, apa: string): Sen {
    if (!Number.isSafeInteger(v)) throw new RangeError(`${apa} bukan sen bulat: ${String(v)}`);
    return v;
}

/**
 * Nominal desimal -> sen TEPAT. Masukan: angka JSON Accurate (108741.15) atau teks numeric Postgres ("108741.15").
 * Lebih dari 2 desimal, notasi e, pemisah ribuan, kosong, NaN/Infinity, di luar bilangan bulat aman -> RangeError.
 * (Teks isian manusia "Rp 1.250.000" BUKAN untuk fungsi ini — pakai parseLocaleNumber lib/insentif-sales-excel lalu keSen.)
 */
export function keSen(v: number | string): Sen {
    const t = typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : String(v).trim();
    const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(t);
    if (!m) throw new RangeError(`Nominal tidak sah: ${JSON.stringify(v)} (maks. 2 desimal, tanpa pemisah ribuan)`);
    const sen = Number(m[2]) * 100 + Number((m[3] ?? "").padEnd(2, "0"));
    if (!Number.isSafeInteger(sen)) throw new RangeError(`Nominal di luar batas: ${JSON.stringify(v)}`);
    return m[1] && sen ? -sen : sen;
}

/** Sen -> teks numeric 2 desimal untuk kolom numeric(18,2) ("108741.15"). */
export function senKeTeks(sen: Sen): string {
    wajibSen(sen, "senKeTeks");
    const a = Math.abs(sen);
    return `${sen < 0 ? "-" : ""}${Math.trunc(a / 100)}.${String(a % 100).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// (a) Alokasi uang pelunasan ke salesman
// ---------------------------------------------------------------------------------------------------------------------

/** Pelunasan retur / ayat silang (bukan uang masuk) — dikeluarkan dari rekonsiliasi, ditampilkan sebagai info non-kas. */
export const METODE_NON_KAS = "OTHERS";

/** Satu baris faktur dalam pelunasan (sales-receipt detailInvoice[]). */
export interface PelunasanFaktur {
    fakturId: number;
    nomorFaktur?: string | null;
    /** detailInvoice[].invoice.masterSalesmanId; null = tidak ada. */
    masterSalesmanId: number | null;
    invoicePayment: Sen;
}

/** Satu pelunasan (sales-receipt) — bentuk cache kasir_pelunasan + kasir_pelunasan_faktur. */
export interface Pelunasan {
    id: number;
    nomor: string;
    /** transDate, YYYY-MM-DD. */
    tanggal: string;
    /** paymentMethod Accurate: CASH_OTHER | BANK_TRANSFER | BANK_CHEQUE | OTHERS | … */
    metode: string;
    chequeAmount: Sen;
    faktur: readonly PelunasanFaktur[];
}

/** Bagian uang satu pelunasan untuk satu ORANG. */
export interface BagianOrang {
    pelunasanId: number;
    nomor: string;
    metode: string;
    orang: string;
    /** Kode salesman baris faktur yang terlipat ke orang ini, urut. */
    kode: string[];
    /** masterSalesmanId tanpa kode di accurate_employee (orang = TANPA_SALESMAN). */
    salesmanIdTakDikenal: number[];
    jumlahFaktur: number;
    sen: Sen;
}

export type AlasanTakTeralokasi = "jumlah_invoice_payment_beda" | "tanpa_baris_faktur";

export interface TakTeralokasi {
    pelunasanId: number;
    nomor: string;
    metode: string;
    chequeAmount: Sen;
    jumlahInvoicePayment: Sen;
    /** chequeAmount − Σ invoicePayment: > 0 = uang lebih / lebih bayar, < 0 = kredit / non-kas (mis. useCredit). */
    sisa: Sen;
    arah: "lebih_bayar" | "kredit";
    alasan: AlasanTakTeralokasi;
    /** Orang pemilik baris faktur pelunasan itu (TANPA_SALESMAN = ""), urut kemunculan. */
    orang: string[];
}

/**
 * Owner 11 Okt: nominal = uang pelunasan (chequeAmount). Pelunasan yang SEMUA baris fakturnya milik SATU orang -> chequeAmount
 * PENUH ke orang itu (lebih bayar / kredit ikut orangnya, tanpa ember). Pelunasan multi-orang -> per baris invoicePayment; bila
 * Σ invoicePayment ≠ chequeAmount, baris tetap utuh dan SELISIHNYA masuk ember tak teralokasi berisi orang[] + arah (tidak dibagi
 * diam-diam). Tanpa baris faktur -> seluruh chequeAmount ke ember. Invarian: Σ bagian + Σ sisa = Σ chequeAmount metode uang.
 * Metode OTHERS -> `nonKas`, tidak dialokasikan. Orang dihitung dengan peta gabungan bulan `tanggal` pelunasan.
 */
export function alokasiPelunasan(daftar: readonly Pelunasan[], peta: PetaOrang) {
    const bagian: BagianOrang[] = [];
    const takTeralokasi: TakTeralokasi[] = [];
    const nonKas: Pelunasan[] = [];
    const sudah = new Set<number>();
    for (const p of daftar) {
        if (sudah.has(p.id)) throw new Error(`Pelunasan ganda di masukan: id ${p.id} (${p.nomor})`);
        sudah.add(p.id);
        wajibSen(p.chequeAmount, `chequeAmount ${p.nomor}`);
        for (const f of p.faktur) wajibSen(f.invoicePayment, `invoicePayment ${p.nomor}/${f.fakturId}`);
        if (p.metode === METODE_NON_KAS) {
            nonKas.push(p);
            continue;
        }
        const per = new Map<string, BagianOrang>();
        let jumlah = 0;
        for (const f of p.faktur) {
            const { orang, kode } = orangDariSalesmanId(f.masterSalesmanId, p.tanggal, peta);
            let b = per.get(orang);
            if (!b) per.set(orang, b = { pelunasanId: p.id, nomor: p.nomor, metode: p.metode, orang, kode: [], salesmanIdTakDikenal: [], jumlahFaktur: 0, sen: 0 });
            if (kode && !b.kode.includes(kode)) b.kode.push(kode);
            if (!kode && f.masterSalesmanId !== null && !b.salesmanIdTakDikenal.includes(f.masterSalesmanId)) b.salesmanIdTakDikenal.push(f.masterSalesmanId);
            b.jumlahFaktur++;
            b.sen += f.invoicePayment;
            jumlah += f.invoicePayment;
        }
        const daftarOrang = [...per.values()];
        for (const b of daftarOrang) {
            b.kode.sort();
            b.salesmanIdTakDikenal.sort((x, y) => x - y);
        }
        if (daftarOrang.length === 1) {
            daftarOrang[0].sen = p.chequeAmount; // satu orang: uang pelunasan utuh miliknya
        } else if (jumlah !== p.chequeAmount) {
            const sisa = p.chequeAmount - jumlah;
            takTeralokasi.push({ pelunasanId: p.id, nomor: p.nomor, metode: p.metode, chequeAmount: p.chequeAmount, jumlahInvoicePayment: jumlah,
                sisa, arah: sisa > 0 ? "lebih_bayar" : "kredit", alasan: p.faktur.length ? "jumlah_invoice_payment_beda" : "tanpa_baris_faktur",
                orang: daftarOrang.map((b) => b.orang) });
        }
        bagian.push(...daftarOrang);
    }
    return { bagian, takTeralokasi, nonKas };
}

// ---------------------------------------------------------------------------------------------------------------------
// (b) salesman id -> kode -> ORANG
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Kunci orang untuk uang yang salesman-nya tidak dikenal (id null / id tanpa kode). String kosong SENGAJA: kolom
 * kasir_setoran.salesman_kode wajib tidak kosong (CHECK), jadi kunci ini tidak pernah bertabrakan dengan kode nyata.
 */
export const TANPA_SALESMAN = "";

export interface PetaOrang {
    /** accurate_employee: id (= masterSalesmanId) -> number (kode salesman). */
    kodeSalesman: ReadonlyMap<number, string>;
    /** sales_code_merge decision 'merge' per bulan "YYYY-MM": from_sales_code -> to_sales_code. */
    gabunganPerBulan: ReadonlyMap<string, Map<string, string>>;
}

/** Kode salesman -> kode ORANG pada bulan `tanggal` (rantai gabungan diikuti; tanpa gabungan = orang sendiri). */
export function orangDariKode(kode: string, tanggal: string, peta: Pick<PetaOrang, "gabunganPerBulan">): string {
    const k = kode.trim();
    if (!k) return TANPA_SALESMAN;
    const g = peta.gabunganPerBulan.get(tanggal.slice(0, 7));
    return g ? applyMergeMap(k, g) : k;
}

export function orangDariSalesmanId(id: number | null, tanggal: string, peta: PetaOrang): { orang: string; kode: string | null } {
    const kode = id === null ? "" : (peta.kodeSalesman.get(id) ?? "").trim();
    return kode ? { orang: orangDariKode(kode, tanggal, peta), kode } : { orang: TANPA_SALESMAN, kode: null };
}

// ---------------------------------------------------------------------------------------------------------------------
// (c) Rekonsiliasi per orang per hari
// ---------------------------------------------------------------------------------------------------------------------

/** ⌈sen / Rp 100⌉ × Rp 100 — aritmetika bulat (tepat untuk semua bilangan bulat aman, juga negatif). */
export function bulatkanKeAtas100(sen: Sen): Sen {
    wajibSen(sen, "bulatkanKeAtas100");
    const sisa = ((sen % SEN_RP_100) + SEN_RP_100) % SEN_RP_100;
    return sisa === 0 ? sen : sen - sisa + SEN_RP_100;
}

/** Owner 6–7 Okt + C8: klop = setoran sama persis ATAU = total dibulatkan ke atas ke kelipatan Rp 100. */
export function klop(pelunasan: Sen, setoran: Sen): boolean {
    return setoran === pelunasan || setoran === bulatkanKeAtas100(pelunasan);
}

/** Satu revisi setoran (kasir_setoran). Hanya revisi TERBESAR per kode yang berlaku. */
export interface SetoranRevisi {
    salesmanKode: string;
    revisi: number;
    tunai: Sen;
    transfer: Sen;
    giro: Sen;
}

/** Penjelasan selisih (kasir_selisih_catatan): angka saat dijelaskan; angka berubah = penjelasan tidak berlaku. */
export interface CatatanSelisih {
    salesmanKode: string;
    pelunasan: Sen;
    setoran: Sen;
}

/** Penjelasan uang tak teralokasi (kasir_tak_teralokasi_catatan, sudah disaring ke database Accurate yang dibaca):
 * berlaku untuk pelunasan itu selama `sisa` sama. */
export interface CatatanTakTeralokasi {
    pelunasanId: number;
    sisa: Sen;
}

export type StatusOrang = "klop" | "selisih" | "belum_setor" | "setoran_tanpa_pelunasan";

/** Revisi TERAKHIR satu rantai kode setoran yang terlipat ke seorang orang. */
export interface SetoranKode {
    kode: string;
    revisi: number;
    tunai: Sen;
    transfer: Sen;
    giro: Sen;
    total: Sen;
}

export interface BarisOrang {
    /** Kode orang (kode kanonik sesudah gabungan); TANPA_SALESMAN = "". */
    orang: string;
    /** Kode salesman (faktur & setoran) yang terlipat ke orang ini, urut. */
    kode: string[];
    pelunasan: Sen;
    pelunasanPerMetode: Record<string, Sen>;
    jumlahFaktur: number;
    /** null = belum ada setoran tercatat. Setoran 0 yang tercatat BUKAN null. Jumlah dari `setoranPerKode`. */
    setoran: { tunai: Sen; transfer: Sen; giro: Sen; total: Sen } | null;
    /** Revisi terakhir tiap rantai kode milik orang ini (urut kode) — dasar `rencanaSetoranOrang`. */
    setoranPerKode: SetoranKode[];
    /** setoran.total − pelunasan; null bila belum setor. */
    selisih: Sen | null;
    status: StatusOrang;
    dijelaskan: boolean;
    /** masterSalesmanId yang tidak dikenal accurate_employee (hanya untuk baris TANPA_SALESMAN). */
    salesmanIdTakDikenal: number[];
}

export interface MasukanRekonsiliasi {
    tanggal: string;
    pelunasan: readonly Pelunasan[];
    setoran: readonly SetoranRevisi[];
    catatan?: readonly CatatanSelisih[];
    catatanTakTeralokasi?: readonly CatatanTakTeralokasi[];
    peta: PetaOrang;
}

export interface HasilRekonsiliasi {
    tanggal: string;
    baris: BarisOrang[];
    takTeralokasi: (TakTeralokasi & { dijelaskan: boolean })[];
    nonKas: Pelunasan[];
    total: { pelunasan: Sen; setoran: Sen; takTeralokasi: Sen; nonKas: Sen };
}

function status(pelunasan: Sen, adaPelunasan: boolean, setoran: Sen | null): StatusOrang {
    if (setoran === null) return pelunasan === 0 ? "klop" : "belum_setor";
    if (!adaPelunasan) return setoran === 0 ? "klop" : "setoran_tanpa_pelunasan";
    return klop(pelunasan, setoran) ? "klop" : "selisih";
}

/**
 * Rekonsiliasi satu hari. `pelunasan` = semua pelunasan bertanggal `tanggal` (lain tanggal = galat pemanggil); `setoran` = semua
 * revisi hari itu (revisi terbesar per kode berlaku; kode setoran juga dilipat lewat gabungan bulan itu, jadi gabungan yang
 * diputuskan belakangan tetap menyatukan setoran orang yang sama). Baris = setiap orang yang punya pelunasan ATAU setoran.
 */
export function rekonsiliasiHari(m: MasukanRekonsiliasi): HasilRekonsiliasi {
    wajibTanggal(m.tanggal);
    for (const p of m.pelunasan) {
        if (p.tanggal !== m.tanggal) throw new Error(`Pelunasan ${p.nomor} bertanggal ${p.tanggal}, bukan ${m.tanggal}`);
    }
    const { bagian, takTeralokasi, nonKas } = alokasiPelunasan(m.pelunasan, m.peta);

    type Kerja = { kode: Set<string>; pelunasan: Sen; perMetode: Record<string, Sen>; faktur: number; adaPelunasan: boolean;
        setoran: BarisOrang["setoran"]; perKode: SetoranKode[]; takDikenal: Set<number> };
    const per = new Map<string, Kerja>();
    const ambil = (orang: string) => {
        let k = per.get(orang);
        if (!k) per.set(orang, k = { kode: new Set(), pelunasan: 0, perMetode: {}, faktur: 0, adaPelunasan: false, setoran: null, perKode: [], takDikenal: new Set() });
        return k;
    };

    for (const b of bagian) {
        const k = ambil(b.orang);
        b.kode.forEach((x) => k.kode.add(x));
        b.salesmanIdTakDikenal.forEach((x) => k.takDikenal.add(x));
        k.pelunasan += b.sen;
        k.perMetode[b.metode] = (k.perMetode[b.metode] ?? 0) + b.sen;
        k.faktur += b.jumlahFaktur;
        k.adaPelunasan = true;
    }

    const terakhir = new Map<string, SetoranRevisi>();
    for (const s of m.setoran) {
        for (const v of [s.tunai, s.transfer, s.giro]) wajibSen(v, `setoran ${s.salesmanKode} revisi ${s.revisi}`);
        const lama = terakhir.get(s.salesmanKode);
        if (lama?.revisi === s.revisi) throw new Error(`Setoran ${s.salesmanKode} revisi ${s.revisi} ganda`);
        if (!lama || s.revisi > lama.revisi) terakhir.set(s.salesmanKode, s);
    }
    for (const s of terakhir.values()) {
        const k = ambil(orangDariKode(s.salesmanKode, m.tanggal, m.peta));
        k.kode.add(s.salesmanKode.trim());
        const a = k.setoran ?? { tunai: 0, transfer: 0, giro: 0, total: 0 };
        const total = s.tunai + s.transfer + s.giro;
        k.setoran = { tunai: a.tunai + s.tunai, transfer: a.transfer + s.transfer, giro: a.giro + s.giro, total: a.total + total };
        k.perKode.push({ kode: s.salesmanKode.trim(), revisi: s.revisi, tunai: s.tunai, transfer: s.transfer, giro: s.giro, total });
    }

    const dijelaskan = new Set((m.catatan ?? []).map((c) => `${orangDariKode(c.salesmanKode, m.tanggal, m.peta)}|${c.pelunasan}|${c.setoran}`));
    const baris: BarisOrang[] = [...per].map(([orang, k]) => {
        const total = k.setoran?.total ?? null;
        return {
            orang, kode: [...k.kode].sort(), pelunasan: k.pelunasan, pelunasanPerMetode: k.perMetode, jumlahFaktur: k.faktur,
            setoran: k.setoran, setoranPerKode: k.perKode.sort((x, y) => x.kode.localeCompare(y.kode)),
            selisih: total === null ? null : total - k.pelunasan, status: status(k.pelunasan, k.adaPelunasan, total),
            dijelaskan: dijelaskan.has(`${orang}|${k.pelunasan}|${total ?? 0}`), salesmanIdTakDikenal: [...k.takDikenal].sort((x, y) => x - y),
        };
    }).sort((a, b) => (a.orang === TANPA_SALESMAN ? 1 : 0) - (b.orang === TANPA_SALESMAN ? 1 : 0) || a.orang.localeCompare(b.orang));

    const embJelas = new Set((m.catatanTakTeralokasi ?? []).map((c) => `${c.pelunasanId}|${c.sisa}`));
    const jumlah = (xs: Sen[]) => xs.reduce((s, x) => s + x, 0);
    return {
        tanggal: m.tanggal, baris, nonKas,
        takTeralokasi: takTeralokasi.map((t) => ({ ...t, dijelaskan: embJelas.has(`${t.pelunasanId}|${t.sisa}`) })),
        total: {
            pelunasan: jumlah(baris.map((b) => b.pelunasan)),
            setoran: jumlah(baris.map((b) => b.setoran?.total ?? 0)),
            takTeralokasi: jumlah(takTeralokasi.map((t) => t.sisa)),
            nonKas: jumlah(nonKas.map((p) => p.chequeAmount)),
        },
    };
}

/** Satu baris kasir_setoran yang harus disisipkan (revisiSebelumnya = kolom revisi_sebelumnya). */
export interface RevisiBaru {
    salesmanKode: string;
    revisi: number;
    revisiSebelumnya: number | null;
    tunai: Sen;
    transfer: Sen;
    giro: Sen;
}

/**
 * RENCANA catat/koreksi setoran satu ORANG (K2 menulis SEMUA barisnya dalam SATU transaksi, diserialkan per tanggal):
 * kode utama (= `orang`, kode kanonik sesudah gabungan) mendapat revisi baru bernominal baru; setiap rantai kode LAIN yang terlipat
 * ke orang itu dan masih ≠ 0 mendapat revisi baru bernilai 0. Tanpa ini koreksi di satu rantai meninggalkan rantai lain dan total
 * orang terhitung dobel (gabungan sales_code_merge bisa diputuskan SESUDAH setoran dicatat per kode). Rantai yang sudah 0 tidak
 * ditulis ulang. `baris.setoranPerKode` = revisi terakhir tiap rantai (rekonsiliasiHari).
 */
export function rencanaSetoranOrang(baris: Pick<BarisOrang, "orang" | "setoranPerKode">, nominal: { tunai: Sen; transfer: Sen; giro: Sen }): RevisiBaru[] {
    if (baris.orang === TANPA_SALESMAN) throw new Error("Setoran tidak bisa dicatat untuk Tanpa salesman");
    for (const v of [nominal.tunai, nominal.transfer, nominal.giro]) {
        if (wajibSen(v, "nominal setoran") < 0) throw new RangeError(`Nominal setoran negatif: ${v}`);
    }
    const lanjut = (kode: string) => {
        const lama = baris.setoranPerKode.find((x) => x.kode === kode);
        return { salesmanKode: kode, revisi: (lama?.revisi ?? 0) + 1, revisiSebelumnya: lama?.revisi ?? null };
    };
    return [
        { ...lanjut(baris.orang), ...nominal },
        ...baris.setoranPerKode.filter((x) => x.kode !== baris.orang && x.total !== 0)
            .map((x) => ({ ...lanjut(x.kode), tunai: 0, transfer: 0, giro: 0 })),
    ];
}

const rp = (sen: Sen) => rupiah(senKeTeks(sen));

function alasanBaris(b: BarisOrang): string {
    const siapa = namaOrang(b.orang);
    if (b.status === "belum_setor") return `${siapa} belum setor dan belum dijelaskan: pelunasan ${rp(b.pelunasan)}.`;
    const setoran = b.setoran?.total ?? 0;
    if (b.status === "setoran_tanpa_pelunasan") return `Setoran ${siapa} tanpa pelunasan belum dijelaskan: ${rp(setoran)}.`;
    return `Selisih ${siapa} belum dijelaskan: setoran ${rp(setoran)} lawan pelunasan ${rp(b.pelunasan)} (${rp(setoran - b.pelunasan)}).`;
}

const namaOrang = (orang: string) => (orang === TANPA_SALESMAN ? "Tanpa salesman" : orang);

function alasanEmber(t: TakTeralokasi): string {
    if (t.alasan === "tanpa_baris_faktur") return `Uang tak teralokasi ${t.nomor} belum dijelaskan: ${rp(t.sisa)} (pelunasan tanpa baris faktur).`;
    const arah = t.arah === "lebih_bayar" ? "uang lebih / lebih bayar" : "kredit / non-kas";
    return `Uang tak teralokasi ${t.nomor} belum dijelaskan: ${rp(t.sisa)} ${arah} (pelunasan ${rp(t.chequeAmount)}, faktur `
        + `${rp(t.jumlahInvoicePayment)}; orang ${t.orang.map(namaOrang).join(", ")}).`;
}

/**
 * Syarat Tutup hari (spec it11 + owner 11 Okt T2): SETIAP baris orang klop atau dijelaskan DAN SETIAP ember tak teralokasi
 * dijelaskan. `alasan` = kalimat siap tampil (urut: orang, lalu ember). Kunci otomatis 20.00 tidak memakai syarat ini (kunci ≠ tutup).
 */
export function penghalangTutup(h: HasilRekonsiliasi) {
    const baris = h.baris.filter((b) => b.status !== "klop" && !b.dijelaskan);
    const takTeralokasi = h.takTeralokasi.filter((t) => !t.dijelaskan);
    const alasan = [...baris.map(alasanBaris), ...takTeralokasi.map(alasanEmber)];
    return { bisaDitutup: alasan.length === 0, alasan, baris, takTeralokasi };
}

/**
 * Snapshot angka untuk kasir_hari_event (tutup / kunci) — JSON murni, sen bulat. Banding dengan snapshot baru = "berubah sejak
 * ditutup". `terhalang` = alasan penghalangTutup SAAT itu: Tutup hanya sah bila kosong (CHECK kasir_hari_event_tutup_tuntas);
 * snapshot KUNCI otomatis boleh berisi — mencatat selisih/ember yang belum dijelaskan saat hari terkunci (menjelaskannya
 * sesudah itu butuh buka kembali, kasir.buka).
 */
export function snapshotHari(h: HasilRekonsiliasi) {
    return {
        versi: 1 as const,
        tanggal: h.tanggal,
        total: { ...h.total },
        baris: h.baris.map((b) => ({ orang: b.orang, pelunasan: b.pelunasan, setoran: b.setoran?.total ?? null, status: b.status, dijelaskan: b.dijelaskan })),
        takTeralokasi: h.takTeralokasi.map((t) => ({ pelunasanId: t.pelunasanId, nomor: t.nomor, sisa: t.sisa, alasan: t.alasan, arah: t.arah,
            orang: t.orang, dijelaskan: t.dijelaskan })),
        terhalang: penghalangTutup(h).alasan,
    };
}

// ---------------------------------------------------------------------------------------------------------------------
// (d) Kunci hari 20.00 WITA
// ---------------------------------------------------------------------------------------------------------------------

/** Jejak kasir_hari_event. Urutan = id (urutan sisip), bukan urutan masukan. */
export interface EventHari {
    id: number;
    jenis: "tutup" | "kunci" | "buka";
    pada: Date | string;
    alasan?: string | null;
}

/** Alasan buka kembali minimal (sama dengan CHECK kasir_hari_event_alasan_buka dan pola idempotency_resolution). */
export const ALASAN_BUKA_MIN = 15;

function wajibTanggal(tanggal: string) {
    const ms = /^\d{4}-\d{2}-\d{2}$/.test(tanggal) ? Date.parse(`${tanggal}T00:00:00Z`) : NaN;
    if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== tanggal) throw new Error(`Format tanggal salah: ${tanggal} (YYYY-MM-DD)`);
}

/** 20.00 WITA (UTC+8 tetap) pada `tanggal`. */
export function batasKunci(tanggal: string): Date {
    wajibTanggal(tanggal);
    return new Date(`${tanggal}T20:00:00+08:00`);
}

/** 20.00 WITA pertama SESUDAH-atau-pada `t` belum lewat: hari WITA `t` bila t < 20.00, selain itu besoknya. */
function kunciSesudah(t: Date): Date {
    const hari = todayWita(t);
    const b = batasKunci(hari);
    return t < b ? b : batasKunci(todayWita(new Date(b.getTime() + 24 * 60 * 60 * 1000)));
}

export interface StatusHari {
    terkunci: boolean;
    sebab: "tutup" | "kunci" | "otomatis_20" | null;
    /** Kapan terbuka-nya berakhir otomatis (null bila sudah terkunci). */
    kunciBerikutnya: Date | null;
}

/**
 * Event terakhir (menurut id) yang sah menentukan: tutup/kunci -> terkunci. Tanpa event -> terkunci sejak 20.00 WITA hari itu.
 * Buka beralasan (≥ 15 huruf) -> terbuka sampai 20.00 WITA berikutnya sesudah waktu buka, lalu terkunci otomatis lagi
 * (owner 11 Okt, T1). Buka tanpa alasan sah diabaikan. `sekarang` disuntikkan (tanpa jam sistem).
 */
export function statusHari(tanggal: string, events: readonly EventHari[], sekarang: Date): StatusHari {
    const batasHari = batasKunci(tanggal);
    const sah = events.filter((e) => e.jenis !== "buka" || (e.alasan ?? "").trim().length >= ALASAN_BUKA_MIN);
    const akhir = [...sah].sort((a, b) => a.id - b.id).at(-1);
    if (akhir && akhir.jenis !== "buka") return { terkunci: true, sebab: akhir.jenis, kunciBerikutnya: null };
    // Buka tidak pernah memperpendek jendela hari itu sendiri (buka bertanggal lebih awal tetap sampai 20.00 hari itu).
    const sesudahBuka = akhir ? kunciSesudah(new Date(akhir.pada)) : batasHari;
    const batas = sesudahBuka > batasHari ? sesudahBuka : batasHari;
    return sekarang >= batas ? { terkunci: true, sebab: "otomatis_20", kunciBerikutnya: null } : { terkunci: false, sebab: null, kunciBerikutnya: batas };
}

/** Setoran / penjelasan hari `tanggal` boleh dicatat: tidak terkunci dan bukan hari yang belum tiba (WITA). */
export function bolehDiubah(tanggal: string, events: readonly EventHari[], sekarang: Date): boolean {
    return !statusHari(tanggal, events, sekarang).terkunci && tanggal <= todayWita(sekarang);
}

/** Hari kerja Senin–Sabtu (owner 11 Okt). */
export function hariKerja(tanggal: string): boolean {
    wajibTanggal(tanggal);
    return new Date(`${tanggal}T00:00:00Z`).getUTCDay() !== 0;
}
