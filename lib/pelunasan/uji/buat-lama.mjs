// Membangkitkan oracle kode LAMA (verbatim) dari page.tsx di basis 5d6cc936.
// Pakai: node buat-lama.mjs <worktree>
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const wt = process.argv[2];
const BASIS = "5d6cc936";
const src = execFileSync("git", ["-C", wt, "show", `${BASIS}:app/(dashboard)/api-wrapper/page.tsx`], { encoding: "utf8", maxBuffer: 1 << 26, env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
const L = src.split("\n");
const ambil = (a, b) => L.slice(a - 1, b).join("\n");

const out = `/* eslint-disable @typescript-eslint/no-explicit-any, prefer-const, @typescript-eslint/no-unused-vars -- SEMENTARA (S6e-1 tahap 1): salinan VERBATIM kode lama, dihapus di tahap 2 */
/**
 * ORACLE SEMENTARA S6e-1 tahap 1 — BUKAN kode produksi. Dihapus di tahap 2 setelah lib/pelunasan lulus golden.
 * Isi blok bertanda VERBATIM disalin mekanis dari \`git show ${BASIS}:app/(dashboard)/api-wrapper/page.tsx\`:
 *   W:30-45 (tipe duplikat), W:80-87 (normalizePayloadMoney), W:275-1629 (helper retur + parser Pelunasan),
 *   W:1903-2053 (previewAccurateSalesReceiptHistory + previewSalesReceiptDuplicates).
 * Verifikasi: bandingkan tiap blok VERBATIM dengan \`sed -n A,Bp\` berkas basis — harus identik byte demi byte.
 * Yang BUKAN verbatim hanya pembungkus: toast/setPayloadStr/XLSX/setTimeout/fetch diganti perekam.
 */
import { buildSalesReceiptIdempotencyPayload } from "../../sales-receipt-fingerprint.ts";

export type OpsiLama = {
    trxDate: string;
    isKeySaved: boolean;
    mapTunaiAutoNum: string; mapTunaiBank: string;
    mapTrfAutoNum: string; mapTrfBank: string;
    mapBgAutoNum: string; mapBgBank: string;
    mapPot1Account: string; mapPot2Account: string; mapPot3Account: string;
    accurateFetch: (path: string, method: string, payload?: unknown) => Promise<any>;
};

export async function jalankanPelunasanLama(cleanedDataMasuk: any[], opsi: OpsiLama) {
    const { trxDate, isKeySaved, mapTunaiAutoNum, mapTunaiBank, mapTrfAutoNum, mapTrfBank, mapBgAutoNum, mapBgBank,
        mapPot1Account, mapPot2Account, mapPot3Account, accurateFetch } = opsi;
    const keluaran = { payloadStr: null as string | null, manualRows: null as any[] | null, toasts: [] as any[][] };
    const catat = (jenis: string) => (...args: any[]) => { keluaran.toasts.push([jenis, ...args]); };
    const toast = { loading: catat("loading"), success: catat("success"), warning: catat("warning"), error: catat("error") };
    const setPayloadStr = (s: string) => { keluaran.payloadStr = s; };
    const setInputMode = (_m: string) => {};
    const e = { target: { value: "" as string } };
    const XLSX = {
        utils: { json_to_sheet: (rows: any[]) => { keluaran.manualRows = rows; return {}; }, book_new: () => ({}), book_append_sheet: (..._a: any[]) => {} },
        writeFile: (..._a: any[]) => {},
    };
    const setTimeout = (fn: () => void, _ms?: number) => { fn(); };

    // ---- VERBATIM W:80-87
${ambil(80, 87)}
    // ---- akhir VERBATIM W:80-87

    const jalan = async () => {
        let cleanedData = cleanedDataMasuk;
        // ---- VERBATIM W:275-1629
${ambil(275, 1629)}
        // ---- akhir VERBATIM W:275-1629
    };
    await jalan();
    return keluaran;
}

// ---- VERBATIM W:30-45
${ambil(30, 45)}
// ---- akhir VERBATIM W:30-45

export async function jalankanPratinjauLama(rows: any[], routeKey: string, opsi: {
    blockedEntries: any[];
    accurateFetch: (path: string, method: string, payload?: unknown) => Promise<any>;
}) {
    type RouteKey = string;
    const { accurateFetch } = opsi;
    const fetch = async (_url: string, _init: any) => ({ ok: true, json: async () => ({ blockedEntries: opsi.blockedEntries }) });

    // ---- VERBATIM W:1903-2053
${ambil(1903, 2053)}
    // ---- akhir VERBATIM W:1903-2053

    return previewSalesReceiptDuplicates(rows, routeKey);
}
`;
writeFileSync(join(wt, "lib/pelunasan/uji/lama.ts"), out);
console.log("ok", out.split("\n").length, "baris");
