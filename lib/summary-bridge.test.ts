/* Kunci: baris yang keluar dari sini masuk ke GERBANG yang menahan faktur. Aturan yang salah
   di sini akan MEMBENARKAN potongan yang tidak punya dasar — kebalikan dari gunanya gerbang. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { bridgeRows, type PublishedLetter, type SummaryProgram } from "./summary-bridge.ts";

const program = (over: Partial<SummaryProgram> = {}): SummaryProgram => ({
    id: "row-1-1", name: "PROMO BRAND RESIK V", start: "2026-09-01", end: "2026-09-30",
    codes: ["K1370000005010", "K1370000009010"], channel: "ALL",
    outlet_mode: "all", outlet_classes: [], unit: "PCS", mix: false,
    threshold: "quantity", value_scope: "eligible", basis: "gross", stacking: false, priority: 1,
    tiers: [{ minimum: "30", bonus_quantity: "1", bonus_unit: "PCS", repeat: true }],
    source_page: 1, source_quote: "SETIAP PEMBELIAN 30 PCS ...", ...over,
});

const letter = (over: Partial<PublishedLetter> = {}): PublishedLetter => ({
    draftId: "8f3a1c22-0000-0000-0000-000000000000", principal: "KINO NON FOOD",
    suratProgram: "BP2609007713", promoLabel: "PROMO BRAND RESIK V", promoGroup: "RESIK V KHASIAT MANJAKANI",
    programs: [program()],
    itemNames: { K1370000005010: "KNF RESIK V MANJAKANI 50ML", K1370000009010: "KNF RESIK V MANJAKANI 90ML" },
    settlement: "on_invoice", beban: "PRINCIPAL", outletCodes: [], ...over,
});

test("bonus barang jadi satu aturan BONUS_QTY per kode barang", () => {
    const hasil = bridgeRows(letter());
    assert.deepEqual(hasil.refused, []);
    assert.equal(hasil.rows.length, 2);
    assert.equal(hasil.rows[0].benefitType, "BONUS_QTY");
    assert.equal(hasil.rows[0].benefitValue, "1");
    assert.equal(hasil.rows[0].triggerQty, "30");
    assert.equal(hasil.rows[0].triggerUnit, "PCS");
    assert.equal(hasil.rows[0].suratProgram, "BP2609007713");
    assert.equal(hasil.rows[0].itemCode, "K1370000005010");
    assert.equal(hasil.rows[1].itemCode, "K1370000009010");
    assert.equal(hasil.rows[0].benefitBeban, "PRINCIPAL");
    assert.equal(hasil.rows[0].onFaktur, true);
});

test("potongan rupiah SELURUH NOTA jadi satu aturan tingkat faktur, bukan per barang", () => {
    // Bentuk program MSG: Rp 20.000 untuk seluruh nota bila belanja >= Rp 1 juta. Kalau ia
    // dimuat per barang, satu potongan nota akan dikalikan sebanyak barisnya.
    const msg = bridgeRows(letter({
        suratProgram: "BP2609006016",
        programs: [program({
            threshold: "value",
            tiers: [
                { minimum: "1000000", rupiah: "20000", rupiah_mode: "once" },
                { minimum: "2000000", rupiah: "40000", rupiah_mode: "once" },
            ],
        })],
    }));
    assert.deepEqual(msg.refused, []);
    assert.equal(msg.rows.length, 2, "dua strata, dua baris — bukan dikali jumlah barang");
    assert.equal(msg.rows[0].itemCode, "");
    assert.equal(msg.rows[0].benefitType, "DISC_RP");
    assert.equal(msg.rows[0].triggerUnit, "RP");
    assert.equal(msg.rows[0].triggerQty, "1000000");
    assert.equal(msg.rows[1].tierNo, 2);
    assert.equal(msg.rows[1].benefitValue, "40000");
});

test("potongan rupiah PER UNIT tetap aturan per barang", () => {
    const hasil = bridgeRows(letter({
        programs: [program({ tiers: [{ minimum: "1", rupiah: "4700", rupiah_mode: "per_unit" }] })],
    }));
    assert.equal(hasil.rows.length, 2);
    assert.equal(hasil.rows[0].itemCode, "K1370000005010");
    assert.equal(hasil.rows[0].benefitType, "DISC_RP");
    assert.equal(hasil.rows[0].benefitValue, "4700");
});

test("RAFAKSI ditolak seluruhnya: ia tidak memotong faktur", () => {
    const hasil = bridgeRows(letter({ settlement: "rafaksi" }));
    assert.deepEqual(hasil.rows, []);
    assert.match(hasil.refused[0], /tidak memotong faktur/);
    // "Pilih rafaksi atau on faktur" juga ditolak: yang belum dipilih belum boleh jadi aturan.
    assert.equal(bridgeRows(letter({ settlement: "choose_rafaksi_or_on_invoice" })).rows.length, 0);
});

test("rantai beberapa persen dalam satu strata ditolak, bukan diambil yang pertama", () => {
    // "8%+2%" adalah DUA potongan di dua posisi, dan posisi menentukan siapa menanggung.
    const hasil = bridgeRows(letter({
        programs: [program({ tiers: [{ minimum: "2", percentages: ["8", "2"] }] })],
    }));
    assert.deepEqual(hasil.rows, []);
    assert.match(hasil.refused[0], /8\+2/);
});

test("kelas outlet jadi daftar peserta, dua arah", () => {
    const hanya = bridgeRows(letter({
        programs: [program({ outlet_mode: "only", outlet_classes: ["LOYALTY"] })],
    }));
    assert.equal(hanya.rows[0].outletList, "LOYALTY");
    assert.equal(hanya.rows[0].outletListMode, "INCLUDE");

    const kecuali = bridgeRows(letter({
        programs: [program({ outlet_mode: "except", outlet_classes: ["LOYALTY"] })],
    }));
    assert.equal(kecuali.rows[0].outletListMode, "EXCLUDE");

    // Dua kelas sekaligus tidak bisa dinyatakan satu aturan; ditolak, tidak dipilih salah satu.
    const dua = bridgeRows(letter({
        programs: [program({ outlet_mode: "only", outlet_classes: ["LOYALTY", "CONTRACTUAL"] })],
    }));
    assert.deepEqual(dua.rows, []);
    assert.match(dua.refused[0], /SATU daftar/);

    // Daftar outlet khusus pada setelan detail memakai nomor suratnya sebagai nama daftar.
    const khusus = bridgeRows(letter({ outletCodes: ["C-BA0003", "C-WA0012"] }));
    assert.equal(khusus.rows[0].outletList, "BP2609007713");
    assert.equal(khusus.rows[0].outletListMode, "INCLUDE");
});

test("yang tidak bisa dinyatakan utuh ditolak dengan sebabnya, bukan dimuat separuh", () => {
    assert.match(bridgeRows(letter({ programs: [program({ basis: "net" })] })).refused[0], /NETTO/);
    assert.match(bridgeRows(letter({ programs: [program({ value_scope: "order" })] })).refused[0], /SELURUH order/);
    assert.match(bridgeRows(letter({ programs: [program({ codes: [] })] })).refused[0], /kode barang/);
    assert.match(bridgeRows(letter({ programs: [program({ tiers: [] })] })).refused[0], /strata/);
    assert.match(bridgeRows(letter({ programs: [program({ tiers: [{ minimum: "5" }] })] })).refused[0], /tanpa benefit/);
    assert.match(bridgeRows(letter({ suratProgram: "" })).refused[0], /nomor surat/);
    // Satu program yang ditolak TIDAK menjatuhkan program lain pada surat yang sama.
    const campur = bridgeRows(letter({ programs: [program({ basis: "net" }), program({ id: "row-1-2" })] }));
    assert.equal(campur.rows.length, 2);
    assert.equal(campur.refused.length, 1);
});

test("yang dimuat tetapi perlu diketahui pemeriksanya masuk catatan, bukan ditelan", () => {
    const hasil = bridgeRows(letter({ programs: [program({ mix: true, stacking: true })] }));
    assert.equal(hasil.rows.length, 2);
    assert.equal(hasil.notes.length, 2);
    assert.match(hasil.notes.join(" "), /dicampur antar barang/);
    assert.match(hasil.notes.join(" "), /bertumpuk/);
});

test("beban distributor terbawa apa adanya", () => {
    const hasil = bridgeRows(letter({ beban: "DISTRIBUTOR" }));
    assert.equal(hasil.rows[0].benefitBeban, "DISTRIBUTOR");
});

test("dua program menyebut barang dan tingkat yang sama dengan ISI SAMA: dimuat sekali, bukan ditolak", () => {
    // Kunci unik promo_rule memuat (surat, kelompok, barang, tingkat). Dua detail satu surat
    // bisa menyebut barang yang sama; kalau tidak dijaga di sini, satu bentrok menjatuhkan
    // seluruh muatan — termasuk aturan yang tidak ada urusannya.
    //
    // Kembar yang ISINYA SAMA tidak menandakan apa pun yang salah, dan pada potongan setingkat
    // nota ia bahkan tidak bisa dihindari. Melaporkannya sebagai penolakan membuat tiap muat
    // surat terlihat gagal separuh, dan penolakan yang selalu muncul berhenti dibaca.
    const hasil = bridgeRows(letter({
        programs: [
            program({ id: "row-1-1", codes: ["K1370000005010"] }),
            program({ id: "row-2-1", codes: ["K1370000005010", "K1370000009010"] }),
        ],
    }));
    assert.deepEqual(hasil.rows.map((r) => `${r.promoGroupId}:${r.itemCode}`),
        ["row-1-1:K1370000005010", "row-2-1:K1370000009010"]);
    assert.deepEqual(hasil.refused, []);
    assert.equal(hasil.notes.length, 1);
    assert.match(hasil.notes[0], /isi yang SAMA; dimuat sekali saja/);
});

test("kembar yang ISINYA BERBEDA tetap ditolak: di situ memang ada dua jawaban", () => {
    const hasil = bridgeRows(letter({
        programs: [
            program({ id: "row-1-1", codes: ["K1370000005010"] }),
            program({
                id: "row-2-1", codes: ["K1370000005010"],
                tiers: [{ minimum: "30", bonus_quantity: "2", bonus_unit: "PCS", repeat: true }],
            }),
        ],
    }));
    assert.equal(hasil.rows.length, 1);
    assert.equal(hasil.rows[0].benefitValue, "1", "yang pertama yang dipakai");
    assert.equal(hasil.refused.length, 1);
    assert.match(hasil.refused[0], /isi BERBEDA \(1PCS lawan 2PCS\)/);
});

/* SATU PUBLIKASI, BANYAK SURAT (sejak #74 Summary menumpuk per principal + bulan). Sampai
   2026-09-16 nomor surat dan kelompok diambil dari BARIS PERTAMA publikasi dan dipasang ke
   SEMUA baris: aturan surat kedua tersimpan atas nama surat pertama, surat keduanya hilang
   dari `promo_rule`, dan memuat ulang surat pertama kelak akan mencabut aturan surat kedua. */
test("tiap program membawa nomor surat dan kelompoknya sendiri", () => {
    const hasil = bridgeRows(letter({
        programs: [
            program({ id: "PN-A", surat_program: "BP2609007664", kelompok: "OVALE FACIAL LOTION", codes: ["K1330001006010"] }),
            program({ id: "PN-B", surat_program: "BP2609007713", kelompok: "RESIK V MANJAKANI", codes: ["K1370000005010"] }),
        ],
    }));
    assert.deepEqual(hasil.refused, []);
    assert.deepEqual(hasil.rows.map((row) => [row.suratProgram, row.promoGroup]), [
        ["BP2609007664", "OVALE FACIAL LOTION"],
        ["BP2609007713", "RESIK V MANJAKANI"],
    ]);
});

test("publikasi beku tanpa asal per program mundur ke nilai publikasi", () => {
    const hasil = bridgeRows(letter({ programs: [program({ surat_program: "", kelompok: "" })] }));
    assert.deepEqual(hasil.refused, []);
    assert.equal(hasil.rows[0].suratProgram, "BP2609007713");
    assert.equal(hasil.rows[0].promoGroup, "RESIK V KHASIAT MANJAKANI");
});

test("program tanpa nomor surat di mana pun ditolak sendirian, bukan menjatuhkan publikasinya", () => {
    const hasil = bridgeRows(letter({
        suratProgram: "",
        programs: [program({ id: "PN-A", surat_program: "BP2609007664" }), program({ id: "PN-B", surat_program: "" })],
    }));
    assert.equal(hasil.rows.length, 2);
    assert.deepEqual(hasil.rows.map((row) => row.suratProgram), ["BP2609007664", "BP2609007664"]);
    assert.equal(hasil.refused.length, 1);
    assert.match(hasil.refused[0], /PN-B.*nomor surat/);
});

test("daftar outlet dari setelan publikasi dibuat satu per surat", () => {
    const hasil = bridgeRows(letter({
        outletCodes: ["C-BA0003"],
        programs: [
            program({ id: "PN-A", surat_program: "BP2609007664", codes: ["K1330001006010"] }),
            program({ id: "PN-B", surat_program: "BP2609007713", codes: ["K1370000005010"] }),
        ],
    }));
    assert.deepEqual(hasil.outletLists, ["BP2609007664", "BP2609007713"]);
    assert.deepEqual(hasil.rows.map((row) => row.outletList), ["BP2609007664", "BP2609007713"]);
});

test("potongan setingkat nota dilebur jadi satu kelompok per surat", () => {
    // Surat MSG yang berlaku untuk SELURUH barang pulang sebagai banyak program: Summary
    // memecah satu baris menjadi satu baris per kelompok master supaya Form-nya terbaca.
    // Tier-nya sama persis di tiap pecahan, jadi tanpa peleburan ia menulis satu aturan
    // tingkat-nota PER KELOMPOK — 53 kali lipat pada `BP2609006016` yang sebenarnya.
    const program = (id: string, kelompok: string) => ({
        id, name: "MSG ALL BRAND", surat_program: "BP2609006016", kelompok,
        start: "2026-09-01", end: "2026-09-30", codes: ["A1"], channel: "GT",
        unit: "PCS", mix: true, threshold: "value", outlet_mode: "except",
        outlet_classes: ["LOYALTY"], value_scope: "eligible", basis: "gross",
        stacking: false, priority: 1,
        tiers: [{ minimum: "1000000", percentages: [], rupiah: "20000", rupiah_mode: "once",
                  bonus_code: "", bonus_quantity: "0", bonus_unit: "PCS", bonus_scope: "code", repeat: false }],
    });
    const hasil = bridgeRows({
        draftId: "d0000000-0000-0000-0000-000000000000", principal: "KINO NON FOOD",
        suratProgram: "BP2609006016", promoGroup: "X", promoLabel: "MSG", itemNames: {},
        outletLists: {}, programs: [program("PN1", "SLEEK HAND WASH"), program("PN2", "OVALE FACIAL")],
    } as never);
    const nota = hasil.rows.filter((r) => !r.itemCode);
    assert.equal(nota.length, 1, "dua kelompok, satu strata -> satu baris tingkat nota");
    assert.equal(nota[0].promoGroup, "(TINGKAT NOTA)");
    assert.ok(hasil.notes.some((n) => n.includes("isi yang SAMA")),
        "penyatuannya harus disebutkan, bukan diam-diam");
});
