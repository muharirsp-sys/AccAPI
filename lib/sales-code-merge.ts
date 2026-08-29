/*
 * Tujuan: Deteksi kandidat penggabungan sales — beberapa kode sales berbeda yang memakai
 *   prefiks rute/slot yang sama (mis. MS10_ISMAIL KADIR vs MS10_TANSI), yang biasanya berarti
 *   pergantian orang di tengah bulan. Pencapaian digabung ke kode yang dipilih user.
 * Caller: lib/insentif-sales (agregasi MTD), app/api/insentif-sales/code-merge.
 * Dependensi: tidak ada (pure).
 * Main Functions: namePrefix, personName, groupByPrefix, groupByPerson, mergeCandidates,
 *   applyMergeMap.
 * Side Effects: none.
 *
 * PENTING: penggabungan TIDAK PERNAH otomatis. Prefiks sama tidak selalu berarti orang yang
 * sama digantikan — contoh nyata FS1_GITO (GT) vs FS1_MT_SYAHRUL (MT): dua orang berbeda,
 * channel berbeda, nomor rute kebetulan sama. Karena itu hasil fungsi ini hanya KANDIDAT
 * yang harus dikonfirmasi user, bukan keputusan.
 */

/**
 * Prefiks rute/slot dari nama salesman di file closing.
 * "MS10_TANSI" → "MS10" | "M2_5_MT_YUANITA" → "M2_5" | "FS1_MT_SYAHRUL" → "FS1"
 * Penanda channel (_MT_) bukan bagian prefiks — supaya GT & MT dengan nomor sama tetap
 * terdeteksi sebagai kandidat dan bisa ditolak user secara sadar.
 * null kalau nama tidak berpola prefiks (mis. "SPV_SUMARTONO", "EN_OFFICE").
 */
export function namePrefix(salesName: string): string | null {
    const s = (salesName ?? "").trim().toUpperCase();
    // M2_5_MT_NAMA / M2_1_NAMA → M2_5 / M2_1
    const multi = s.match(/^([A-Z]+\d+_\d+)_/);
    if (multi) return multi[1];
    // MS10_NAMA / KN2_NAMA / FS1_MT_NAMA → MS10 / KN2 / FS1
    const single = s.match(/^([A-Z]+\d+)_/);
    if (single) return single[1];
    return null;
}

/**
 * Nama orang tanpa prefiks rute. "FRN5_BASRI YUSUF" → "BASRI YUSUF",
 * "M2_1_BASRI YUSUF" → "BASRI YUSUF", "GDI3_MT_DINI PRATIWI" → "DINI PRATIWI".
 *
 * Ini menangkap kasus yang LUPUT dari namePrefix: satu orang dipegang dua rute berbeda,
 * jadi prefiksnya beda dan kedua kodenya tidak pernah dipertemukan. Nyata pada closing
 * Juli 2026 — BASRI YUSUF punya target FOKUS RITEL di M-BSR (M2_1_) tapi penjualannya
 * dibukukan di M-BSR2 (FRN5_), Rp 271,5 jt tidak menghasilkan insentif sama sekali.
 * JUSNIATI kebalikannya: target di M-JUS (FRN5_), penjualan di M-JUS2 (M2_1_).
 *
 * null kalau nama tidak berpola prefiks_nama, atau sisanya bukan nama orang
 * (mis. "EN_OFFICE" → null; baris kantor bukan salesman).
 */
export function personName(salesName: string): string | null {
    const s = (salesName ?? "").trim().toUpperCase().replace(/\s+/g, " ");
    // Buang prefiks rute + penanda channel: FRN5_, M2_1_, GDI3_MT_, MTRHNZ10_
    const m = s.match(/^[A-Z]+\d*(?:_\d+)?(?:_MT\d*)?_(.+)$/);
    if (!m) return null;
    const nama = m[1].replace(/^MT\d*_/, "").trim();
    // "OFFICE" bukan orang — pos target kantor. Nama satu-huruf juga bukan nama.
    if (!nama || nama === "OFFICE" || nama.length < 2) return null;
    return nama;
}

export interface CodeNamePair {
    salesCode: string;
    salesName: string;
}

export interface MergeCandidateGroup {
    prefix: string;
    members: CodeNamePair[];
}

/**
 * Kelompokkan pasangan kode+nama menurut prefiks. Hanya kelompok berisi >1 kode
 * yang dikembalikan (kelompok tunggal bukan kandidat).
 */
export function groupByPrefix(pairs: CodeNamePair[]): MergeCandidateGroup[] {
    const byPrefix = new Map<string, Map<string, string>>();
    for (const p of pairs) {
        const prefix = namePrefix(p.salesName);
        if (!prefix) continue;
        const inner = byPrefix.get(prefix) ?? new Map<string, string>();
        if (!inner.has(p.salesCode)) inner.set(p.salesCode, p.salesName);
        byPrefix.set(prefix, inner);
    }
    const out: MergeCandidateGroup[] = [];
    for (const [prefix, inner] of byPrefix) {
        if (inner.size < 2) continue;
        out.push({
            prefix,
            members: [...inner].map(([salesCode, salesName]) => ({ salesCode, salesName }))
                .sort((a, b) => a.salesCode.localeCompare(b.salesCode)),
        });
    }
    return out.sort((a, b) => a.prefix.localeCompare(b.prefix));
}

/**
 * Kelompokkan menurut NAMA ORANG (prefiks dibuang). Bentuk hasilnya sama dengan
 * groupByPrefix supaya pemanggil dan UI tidak perlu tahu bedanya — `prefix` diisi nama
 * orangnya, dan nilai itu memang cuma label (kolom `prefix` di sales_code_merge).
 */
export function groupByPerson(pairs: CodeNamePair[]): MergeCandidateGroup[] {
    const byPerson = new Map<string, Map<string, string>>();
    for (const p of pairs) {
        const orang = personName(p.salesName);
        if (!orang) continue;
        const inner = byPerson.get(orang) ?? new Map<string, string>();
        if (!inner.has(p.salesCode)) inner.set(p.salesCode, p.salesName);
        byPerson.set(orang, inner);
    }
    const out: MergeCandidateGroup[] = [];
    for (const [orang, inner] of byPerson) {
        if (inner.size < 2) continue;
        out.push({
            prefix: orang,
            members: [...inner].map(([salesCode, salesName]) => ({ salesCode, salesName }))
                .sort((a, b) => a.salesCode.localeCompare(b.salesCode)),
        });
    }
    return out.sort((a, b) => a.prefix.localeCompare(b.prefix));
}

/** Kunci identitas satu kelompok: kumpulan kodenya, bukan labelnya. */
function kunciAnggota(g: MergeCandidateGroup): string {
    return g.members.map((m) => m.salesCode).sort().join("|");
}

/**
 * Seluruh kandidat: prefiks rute sama ATAU nama orang sama. Kelompok nama yang kumpulan
 * kodenya PERSIS sama dengan kelompok prefiks dibuang — kalau tidak, user ditanya dua kali
 * untuk pasangan yang sama dengan label berbeda.
 *
 * Tetap bukan keputusan otomatis: nama sama pun bisa dua orang berbeda (homonim), sama
 * seperti prefiks sama bisa dua orang berbeda. Semuanya masih dikonfirmasi user.
 */
export function mergeCandidates(pairs: CodeNamePair[]): MergeCandidateGroup[] {
    const prefiks = groupByPrefix(pairs);
    const sudahAda = new Set(prefiks.map(kunciAnggota));
    const orang = groupByPerson(pairs).filter((g) => !sudahAda.has(kunciAnggota(g)));
    return [...prefiks, ...orang];
}

/**
 * Terjemahkan kode sales lewat peta merge (from → to). Rantai diikuti (A→B, B→C ⇒ A→C)
 * dengan batas iterasi supaya siklus data rusak tidak menggantung.
 */
export function applyMergeMap(salesCode: string, mergeMap: Map<string, string>): string {
    let code = salesCode;
    for (let i = 0; i < 10; i++) {
        const next = mergeMap.get(code);
        if (!next || next === code) return code;
        code = next;
    }
    return code; // ponytail: batas 10 hop; data siklik berhenti di sini, bukan hang.
}
