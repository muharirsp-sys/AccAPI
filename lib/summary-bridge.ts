/*
 * Tujuan: Menerjemahkan PROGRAM TERBIT hasil Summary menjadi baris `promo_rule` — jembatan
 *         dari surat yang sudah ditinjau manusia ke gerbang yang menahan faktur.
 * Caller: app/api/promo-rule/from-summary.
 * Dependensi: tidak ada. Main Functions: bridgeRows. Murni — tanpa DB dan tanpa jaringan.
 *
 * KENAPA SUMBERNYA "PROGRAM TERBIT", BUKAN DRAFT.
 * Rantainya: surat PDF -> Mistral OCR 4.1 -> baris draft -> KOREKSI MANUSIA -> `publish_detail`
 * (yang menolak apa pun yang belum lengkap lewat `readiness()`, lalu memvalidasinya sebagai
 * `Program`) -> barulah ke sini. Membaca draft berarti melompati satu-satunya tempat manusia
 * menyatakan "saya sudah memeriksa ini", dan gerbang faktur adalah tempat terakhir yang boleh
 * menerima tebakan.
 *
 * KENAPA ADA YANG DITOLAK DI SINI PADAHAL SUDAH TERBIT.
 * `Program` lebih kaya daripada `promo_rule`: ia bisa menyatakan rafaksi, dasar harga netto,
 * rantai beberapa persen dalam satu strata. `promo_rule` hanya bisa menyatakan SATU potongan
 * per barang per posisi — karena itulah yang bisa diperiksa terhadap faktur Accurate. Program
 * yang tidak bisa dinyatakan utuh TIDAK dimuat separuh: separuh aturan akan meloloskan potongan
 * dengan alasan yang salah, dan itu lebih buruk daripada tidak punya aturan sama sekali.
 *
 * SATU HAL YANG BELUM DIJAGA GERBANG, dan sengaja dicatat di sini supaya tidak terlupa:
 * `triggerQty` pada aturan PER BARANG hari ini hanya keterangan. `matchItemRule` mencocokkan
 * PERSENNYA, dan `matchBonusRule` mencocokkan baris bonus 100% — keduanya tidak menghitung
 * jumlah beli. Jadi "Beli 30 gratis 1" yang diberikan pada pembelian 10 pcs TIDAK akan tertahan
 * gerbang. Itu lubang yang diketahui, bukan yang tersembunyi.
 */

/** Satu strata program terbit; bentuknya sama dengan `Tier` pada `python_backend/summary_rules.py`. */
export type SummaryTier = {
    minimum: string;
    percentages?: string[];
    rupiah?: string;
    rupiah_mode?: "once" | "per_unit";
    bonus_code?: string;
    bonus_quantity?: string;
    bonus_unit?: string;
    bonus_scope?: "code" | "purchased";
    repeat?: boolean;
};

/** Program terbit; bentuknya sama dengan `Program` pada `python_backend/summary_rules.py`. */
export type SummaryProgram = {
    id: string;
    name: string;
    /**
     * Nomor surat dan kelompok PROGRAM INI. Kosong pada publikasi yang dibekukan sebelum
     * 2026-09-16; pembacanya mundur ke nilai tingkat publikasi. Lihat `Program` di
     * `python_backend/summary_rules.py` untuk kenapa keduanya pindah ke sini.
     */
    surat_program?: string;
    kelompok?: string;
    start: string;
    end: string;
    codes: string[];
    channel: string;
    outlet_mode?: "all" | "only" | "except";
    outlet_classes?: string[];
    unit: string;
    mix?: boolean;
    threshold: "quantity" | "value";
    value_scope?: "eligible" | "order";
    basis?: "gross" | "net";
    stacking?: boolean;
    priority?: number;
    tiers: SummaryTier[];
    source_page?: number;
    source_quote?: string;
};

/** Satu publikasi Summary, sudah diratakan oleh pemanggil dari isi `summary_draft`. */
export type PublishedLetter = {
    draftId: string;
    principal: string;
    /**
     * Nomor surat dan kelompok tingkat PUBLIKASI — cadangan saja, dipakai hanya bila
     * programnya sendiri tidak menyebutkannya (publikasi beku sebelum 2026-09-16). Satu
     * publikasi kini bisa memuat banyak surat, jadi nilai ini tidak lagi mewakili semuanya.
     */
    suratProgram: string;
    promoLabel: string;
    promoGroup: string;
    programs: SummaryProgram[];
    /** Kode barang -> nama, dari master yang ikut disimpan saat publikasi. */
    itemNames: Record<string, string>;
    /** `on_invoice` | `rafaksi` | `choose_rafaksi_or_on_invoice`, dari setelan detailnya. */
    settlement: string;
    /** PRINCIPAL (bisa ditagih) atau DISTRIBUTOR (beban sendiri). */
    beban: string;
    /** Daftar outlet peserta khusus pada setelan detail, bila ada. */
    outletCodes: string[];
};

/** Baris siap tulis ke `promo_rule`; namanya mengikuti kolom tabelnya. */
export type BridgeRow = {
    principal: string;
    suratProgram: string;
    promoLabel: string;
    promoGroupId: string;
    promoGroup: string;
    itemCode: string;
    itemName: string;
    customerCode: string;
    periodStart: string;
    periodEnd: string;
    active: boolean;
    tierNo: number;
    triggerQty: string;
    triggerUnit: string;
    benefitType: "DISC_PCT" | "DISC_RP" | "BONUS_QTY";
    benefitValue: string;
    benefitUnit: string;
    benefitBeban: string;
    onFaktur: boolean;
    /** Channel yang disebut surat: "GT", "MT", atau kosong/"ALL" = di mana saja. */
    channel: string;
    outletList: string;
    outletListMode: string;
    note: string;
};

export type BridgeResult = {
    rows: BridgeRow[];
    /** Program yang TIDAK dimuat, masing-masing dengan sebabnya. Bukan daftar peringatan. */
    refused: string[];
    /** Dimuat, tetapi ada yang wajib diketahui pemeriksanya. */
    notes: string[];
    /**
     * Nama daftar outlet yang DIBUAT dari nomor surat, karena publikasinya membawa daftar
     * outletnya sendiri. Satu per surat: pemanggil menuliskan anggotanya ke `promo_outlet`
     * dengan nama-nama ini, dan aturan yang menunjuknya harus menunjuk nama yang sama.
     */
    outletLists: string[];
};

const text = (value: unknown) => String(value ?? "").trim();
const num = (value: unknown) => {
    const parsed = Number(String(value ?? "").replace(",", "."));
    return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Benefit satu strata -> satu bentuk `promo_rule`, atau alasan kenapa tidak bisa.
 *
 * `rupiah_mode: "once"` adalah potongan untuk SELURUH nota (bentuk program MSG), jadi ia
 * menjadi aturan tingkat FAKTUR — `itemCode` kosong. `per_unit` memotong tiap barang, jadi ia
 * tetap aturan per barang. Menyamakan keduanya berarti satu potongan nota dikalikan sebanyak
 * barisnya.
 */
function benefitOf(tier: SummaryTier): { type: BridgeRow["benefitType"]; value: string; unit: string; perFaktur: boolean } | { error: string } {
    const percentages = (tier.percentages ?? []).map(text).filter(Boolean);
    const rupiah = num(tier.rupiah);
    const bonus = num(tier.bonus_quantity);
    const kinds = [percentages.length > 0, rupiah > 0, bonus > 0].filter(Boolean).length;
    if (kinds === 0) return { error: "strata tanpa benefit yang bisa dihitung" };
    if (kinds > 1) return { error: "satu strata membawa lebih dari satu jenis benefit; pecah dulu programnya" };
    if (percentages.length > 1) {
        // Rantai seperti "8%+2%" adalah DUA potongan di dua posisi berbeda, dan posisi
        // menentukan siapa menanggung. Memuat yang pertama saja akan meloloskan potongan kedua
        // tanpa dasar; menjumlahkannya akan menyembunyikan penanggungnya.
        return { error: `strata membawa ${percentages.length} persen sekaligus (${percentages.join("+")}); satu aturan hanya bisa menyatakan satu posisi` };
    }
    if (percentages.length === 1) return { type: "DISC_PCT", value: percentages[0], unit: "%", perFaktur: false };
    if (bonus > 0) return { type: "BONUS_QTY", value: String(bonus), unit: text(tier.bonus_unit) || "PCS", perFaktur: false };
    return { type: "DISC_RP", value: String(rupiah), unit: "RP", perFaktur: (tier.rupiah_mode ?? "once") === "once" };
}

/**
 * Program terbit -> baris `promo_rule`.
 *
 * Satu baris per (program x strata x kode barang), karena `promo_rule` melekat pada BARANG.
 * Kecuali potongan rupiah setingkat nota, yang justru harus satu baris tanpa kode barang.
 */
export function bridgeRows(letter: PublishedLetter): BridgeResult {
    const rows: BridgeRow[] = [];
    const refused: string[] = [];
    const notes: string[] = [];
    const outletLists = new Set<string>();

    const settlement = text(letter.settlement).toLowerCase();
    const beban = text(letter.beban).toUpperCase() === "DISTRIBUTOR" ? "DISTRIBUTOR" : "PRINCIPAL";

    // Rafaksi TIDAK memotong faktur — ia ditagihkan terpisah. Memuatnya sebagai aturan promo
    // berarti gerbang akan MEMBENARKAN potongan pada faktur yang seharusnya tidak ada di sana.
    if (settlement && settlement !== "on_invoice") {
        return {
            rows: [],
            refused: [`Cara penyelesaiannya "${settlement}", bukan on faktur. Programnya nyata, tetapi ia tidak memotong faktur — memuatnya jadi aturan promo akan membenarkan potongan yang seharusnya tidak ada.`],
            notes, outletLists: [],
        };
    }

    for (const program of letter.programs) {
        const sebut = `${program.id} (${program.name})`;
        const tolak = (alasan: string) => refused.push(`${sebut}: ${alasan}`);

        // Asal PER PROGRAM, dengan nilai publikasi sebagai cadangan. Diperiksa per program dan
        // bukan sekali untuk seluruh publikasi: satu Summary kini memuat banyak surat, jadi
        // "publikasi ini menyebut nomor surat" tidak lagi berarti semua programnya menyebutnya.
        const surat = text(program.surat_program) || letter.suratProgram;
        const kelompok = text(program.kelompok) || letter.promoGroup || program.name;
        if (!surat) { tolak("tidak menyebut nomor surat; aturan tanpa asal tidak boleh masuk gerbang"); continue; }

        if (!program.start || !program.end) { tolak("periode belum lengkap"); continue; }
        if (!program.codes?.length) { tolak("tidak ada kode barang"); continue; }
        // Dasar netto mengubah ambang yang dihitung gerbang: gerbang membandingkan BRUTO.
        if ((program.basis ?? "gross") === "net") { tolak("ambangnya berdasar harga NETTO, sedangkan gerbang membandingkan bruto"); continue; }
        if ((program.value_scope ?? "eligible") === "order") {
            tolak("ambangnya menghitung SELURUH order termasuk barang di luar program; gerbang menghitung barang yang masuk aturan");
            continue;
        }

        // Kelas outlet pada program terbit dipetakan langsung ke daftar outlet peserta:
        // "only" = hanya peserta, "except" = semua kecuali peserta. Satu daftar, dua arah —
        // bentuk yang sama dengan yang dipakai gerbang (lihat `outletAllowed`).
        const mode = program.outlet_mode ?? "all";
        const classes = (program.outlet_classes ?? []).map(text).filter(Boolean);
        let outletList = "";
        let outletListMode = "";
        if (mode !== "all") {
            if (!classes.length) { tolak("menyebut daftar peserta tetapi tidak menyebut kelasnya"); continue; }
            // Beberapa kelas ditulis dipisah koma dan digabung UNION saat dibaca
            // (`outletAllowed`). Surat MSG `BP2609006016` berbunyi "EXCLUDE LOYALTY DAN
            // CONTRACTUAL": dua kelas, satu aturan. Sebelum 17 Sep 2026 program semacam itu
            // DITOLAK di sini, dan penolakannya tak pernah terlihat karena uji e2e berhenti
            // satu gerbang lebih awal.
            outletList = [...new Set(classes.map((x) => x.toUpperCase()))].sort().join(",");
            outletListMode = mode === "except" ? "EXCLUDE" : "INCLUDE";
        } else if (letter.outletCodes.length) {
            // Daftar outlet yang ditulis pada setelan detail memakai nomor suratnya sendiri
            // sebagai nama daftar; pemanggil yang menuliskan anggotanya ke `promo_outlet`.
            outletList = surat.toUpperCase();
            outletListMode = "INCLUDE";
            outletLists.add(outletList);
        }

        if (program.stacking) notes.push(`${sebut}: ditandai bisa bertumpuk; gerbang memeriksa per posisi, jadi tumpukannya harus punya aturannya sendiri-sendiri`);
        if (program.mix) notes.push(`${sebut}: ambangnya boleh dicampur antar barang, sedangkan aturan tersimpan per barang — ambangnya jadi keterangan, bukan penjaga`);

        const tiers = program.tiers ?? [];
        if (!tiers.length) { tolak("tidak punya strata"); continue; }

        const calon: BridgeRow[] = [];
        let gagal = "";
        tiers.forEach((tier, index) => {
            if (gagal) return;
            const benefit = benefitOf(tier);
            if ("error" in benefit) { gagal = `strata ${index + 1}: ${benefit.error}`; return; }
            const dasar = {
                principal: letter.principal,
                suratProgram: surat,
                promoLabel: letter.promoLabel || program.name,
                promoGroupId: program.id,
                promoGroup: kelompok,
                customerCode: "",
                periodStart: program.start,
                periodEnd: program.end,
                active: true,
                tierNo: index + 1,
                triggerQty: String(num(tier.minimum)),
                triggerUnit: program.threshold === "value" ? "RP" : (text(program.unit).toUpperCase() || "PCS"),
                benefitValue: benefit.value,
                benefitUnit: benefit.unit,
                benefitBeban: beban,
                onFaktur: true,
                // Channel dari suratnya sendiri. "ALL" disimpan kosong supaya satu arti punya
                // satu bentuk di basis data, dan supaya baris lama yang kosong berarti sama.
                channel: text(program.channel).toUpperCase() === "ALL" ? "" : text(program.channel).toUpperCase(),
                outletList, outletListMode,
                note: `dari publikasi Summary ${letter.draftId.slice(0, 8)} (${program.id})`,
            };
            if (benefit.perFaktur) {
                // Satu potongan untuk SELURUH nota: satu baris tanpa kode barang, dan ambangnya
                // selalu nilai belanja — bentuk yang sama dengan program MSG yang sudah termuat.
                //
                // KELOMPOKNYA SENGAJA DILEBUR. Potongan setingkat nota tidak melihat kelompok
                // sama sekali, tetapi Summary MEMECAH satu baris menjadi satu baris per kelompok
                // master supaya Form-nya terbaca. Surat MSG yang berlaku untuk SELURUH barang
                // karena itu pulang sebagai 53 program yang tier-nya sama persis, dan tanpa
                // peleburan ini ia menulis 530 aturan yang isinya identik — 53 kali lipat dari
                // yang dimaksud suratnya (diuji atas `BP2609006016`, 17 Sep 2026).
                //
                // Gerbangnya sendiri tidak salah menjawab: `checkSoPromo` memilih SATU tier
                // tertinggi yang tercapai, dan ke-53 kembar itu isinya sama. Yang rusak adalah
                // isi tabelnya — dan tabel yang dibanjiri kembar adalah tabel yang berhenti
                // bisa dibaca orang saat ada yang bertanya "aturan mana yang memotong ini?".
                //
                // Dilebur ke satu nama per SURAT, jadi penjaga kembar di bawah menyatukannya
                // menjadi satu baris per strata dan menyebutkan penyatuannya.
                calon.push({ ...dasar, promoGroup: "(TINGKAT NOTA)", itemCode: "", itemName: "",
                    triggerUnit: "RP", benefitType: benefit.type });
                return;
            }
            for (const code of program.codes) {
                calon.push({ ...dasar, itemCode: text(code), itemName: text(letter.itemNames[code]), benefitType: benefit.type });
            }
        });
        if (gagal) { tolak(gagal); continue; }
        rows.push(...calon);
    }

    // Kunci unik `promo_rule` adalah (principal, surat, kelompok, barang, outlet, tingkat).
    // Satu surat bisa punya beberapa detail, dan dua di antaranya bisa menyebut BARANG yang
    // sama pada tingkat yang sama. Kalau itu dibiarkan, seluruh muatan gagal karena satu
    // bentrok — dan yang gagal bukan hanya yang bentrok. Dideteksi di sini supaya yang bentrok
    // saja yang ditolak, dengan menyebut barangnya.
    //
    // KEMBAR YANG SAMA ISINYA BUKAN PENOLAKAN, dan bedanya penting.
    //
    // Satu detail yang menyebut beberapa barang menghasilkan SATU PROGRAM PER BARANG. Untuk
    // potongan setingkat NOTA, tiap program itu membawa tier yang sama persis — jadi kembarnya
    // TIDAK BISA DIHINDARI dan tidak menandakan apa pun yang salah. Melaporkannya sebagai
    // "ditolak" membuat tiap muat surat MSG terlihat gagal separuh, dan penolakan yang selalu
    // muncul akan berhenti dibaca — termasuk yang sungguhan.
    //
    // Yang sungguhan adalah kembar yang isinya BERBEDA: dua program menyatakan hal yang sama
    // dengan angka yang berlainan. Di situ memang ada dua jawaban, dan gerbang tidak boleh
    // memilih sendiri.
    const terpakai = new Map<string, BridgeRow>();
    const bersih: BridgeRow[] = [];
    const isinya = (row: BridgeRow) => [row.benefitType, row.benefitValue, row.benefitUnit,
        row.triggerQty, row.triggerUnit, row.benefitBeban, row.channel, row.outletList, row.outletListMode].join("|");
    for (const row of rows) {
        const kunci = `${row.suratProgram}|${row.promoGroup}|${row.itemCode}|${row.tierNo}`;
        const kembar = terpakai.get(kunci);
        const sebutBarang = row.itemCode || "(tingkat faktur)";
        if (kembar) {
            if (isinya(kembar) === isinya(row)) {
                notes.push(`${row.promoGroupId}: ${sebutBarang} tingkat ${row.tierNo} sudah dinyatakan `
                    + `${kembar.promoGroupId} dengan isi yang SAMA; dimuat sekali saja. Ini wajar pada `
                    + "potongan setingkat nota — satu detail berbarang banyak memang menghasilkan satu program per barang.");
            } else {
                refused.push(`${row.promoGroupId}: barang ${sebutBarang} tingkat ${row.tierNo} sudah dinyatakan `
                    + `${kembar.promoGroupId} pada kelompok "${row.promoGroup}" dengan isi BERBEDA `
                    + `(${kembar.benefitValue}${kembar.benefitUnit} lawan ${row.benefitValue}${row.benefitUnit}); `
                    + "dua aturan untuk hal yang sama berarti dua jawaban");
            }
            continue;
        }
        terpakai.set(kunci, row);
        bersih.push(row);
    }

    return { rows: bersih, refused, notes, outletLists: [...outletLists] };
}
