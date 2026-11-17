/*
 * Tujuan: Mengunci aturan mesin status yang dipusatkan (docs/MESIN_STATUS.md) — antrean faktur,
 *         gerbang tahap OPC, transisi manual Claim Workflow, status bayar insentif, run Laporan Harian,
 *         gerbang nama mirip Master Barang.
 *         Yang dikunci adalah perilaku SAAT INI: tes ini gagal bila aturan bergeser tanpa sengaja.
 * Caller: npm test (tsx --test).
 * Dependensi: modul pure saja — tanpa DB, tanpa jaringan.
 * Side Effects: Tidak ada.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DISCARDABLE_STATES, OUTBOX_STATES, SAPU_SETELAH_MENIT, discardable, resendable, sendable } from "@/lib/accurate-invoice-write";
import { claimWorkflowStatusList, claimWorkflowStatuses as S, claimWorkflowTransitions } from "@/lib/claim-workflow/constants";
import { STATUS_BAYAR_INSENTIF, tolakMundurLunas } from "@/lib/insentif-payment-date";
import { MACET_MENIT, RETRYABLE_RECIPIENT_STATUSES, canClaimReportRun, catatSendingAt, runMacet, sendingAtDariNote } from "@/lib/laporan-harian/send-state";
import { modeDariNote, statusRun } from "@/lib/laporan-harian/ui";
import { tolakNamaMirip, type MasterAksi, type MasterStatus } from "@/lib/master-barang/status";
import { canDecideOm, canReviewClaim, canReviewSm, canSubmitBatch } from "@/lib/off-program-control/workflow";

test("antrean faktur: tiap status punya tepat satu jalan keluar yang sah", () => {
    const aksi = Object.fromEntries(OUTBOX_STATES.map((s) => [s, { kirim: sendable(s), ulang: resendable(s), buang: discardable(s) }]));
    assert.deepEqual(aksi, {
        queued: { kirim: true, ulang: false, buang: true },
        sending: { kirim: false, ulang: false, buang: false },
        posted: { kirim: false, ulang: false, buang: false },
        // Tidak pasti = fakturnya mungkin sudah ada di Accurate: hanya "Selesaikan", tidak pernah kirim/ulang/buang.
        unknown: { kirim: false, ulang: false, buang: false },
        rejected: { kirim: false, ulang: true, buang: true },
    });
    // Klausa WHERE penghapus memakai daftar yang sama dengan predikatnya.
    assert.deepEqual(OUTBOX_STATES.filter(discardable).sort(), [...DISCARDABLE_STATES].sort());
    assert.equal(SAPU_SETELAH_MENIT, 15);
});

test("OPC: gerbang submit -> SM -> Klaim -> OM", () => {
    const b = (status: string, smStatus = "Not Started", claimStatus = "Not Started") => ({ status, smStatus, claimStatus });
    for (const status of ["Draft", "Returned by SM", "Returned by Claim"]) assert.equal(canSubmitBatch(b(status)), true, status);
    assert.equal(canSubmitBatch(b("Submitted to SM", "Waiting Review")), false);
    assert.equal(canSubmitBatch(b("Claim Approved", "Approved by SM", "Approved")), false);
    assert.equal(canSubmitBatch(b("Lain", "Returned")), true);
    assert.equal(canSubmitBatch(b("Lain", "Approved by SM", "Returned")), true);

    assert.equal(canReviewSm("Submitted to SM", "Not Started"), true);
    assert.equal(canReviewSm("Lain", "Waiting Review"), true);
    assert.equal(canReviewSm("Draft", "Not Started"), false);
    assert.equal(canReviewSm("Approved by SM", "Approved by SM"), false);

    // BL-06 (17 Nov 2026): Klaim hanya meninjau yang BELUM diputuskannya — sama dengan antrean layar.
    const klaim = { status: "Approved by SM", smStatus: "Approved by SM", claimStatus: "Not Started" };
    assert.equal(canReviewClaim(klaim), null);
    assert.match(canReviewClaim({ ...klaim, smStatus: "Waiting Review" }) ?? "", /Sales Manager/);
    for (const status of ["Claim Approved", "OM Approved", "Partial Paid", "Paid", "Completed", "Cancelled by OM"])
        assert.match(canReviewClaim({ status, smStatus: "Approved by SM", claimStatus: "Approved" }) ?? "", /sudah diputuskan Klaim/, status);
    assert.match(canReviewClaim({ status: "Returned by Claim", smStatus: "Approved by SM", claimStatus: "Returned" }) ?? "", /sudah diputuskan Klaim/);

    const om = { smStatus: "Approved by SM", claimStatus: "Approved", omStatus: "Waiting Approval" };
    assert.equal(canDecideOm(om), null);
    assert.match(canDecideOm({ ...om, smStatus: "Waiting Review" }) ?? "", /Sales Manager/);
    assert.match(canDecideOm({ ...om, claimStatus: "Returned" }) ?? "", /Klaim/);
    assert.match(canDecideOm({ ...om, omStatus: "Approved" }) ?? "", /OM/);
    // Urutan pemeriksaan: SM dulu, lalu Klaim, lalu OM — pesan pertama yang gagal yang keluar.
    assert.match(canDecideOm({ smStatus: "x", claimStatus: "x", omStatus: "x" }) ?? "", /Sales Manager/);
    assert.match(canDecideOm({ ...om, claimStatus: "x", omStatus: "x" }) ?? "", /Klaim/);
});

test("Claim Workflow: transisi manual hanya Draft/Need Revision <-> Ready -> Submitted", () => {
    const boleh = (aksi: keyof typeof claimWorkflowTransitions) =>
        claimWorkflowStatusList.filter((s) => (claimWorkflowTransitions[aksi].dari as readonly string[]).includes(s));
    assert.deepEqual(boleh("mark_ready"), [S.draft, S.needRevision]);
    assert.deepEqual(boleh("return_to_draft"), [S.readyToSubmit]);
    assert.deepEqual(boleh("submit_to_principal"), [S.readyToSubmit]);
    assert.equal(claimWorkflowTransitions.mark_ready.ke, S.readyToSubmit);
    assert.equal(claimWorkflowTransitions.return_to_draft.ke, S.draft);
    assert.equal(claimWorkflowTransitions.submit_to_principal.ke, S.submittedToPrincipal);
    // Pesan 409 yang dibaca pengguna ikut dikunci: tertukar antar-aksi = tes gagal.
    assert.match(claimWorkflowTransitions.mark_ready.tolak, /^Mark Ready .*Draft atau Need Revision\.$/);
    assert.match(claimWorkflowTransitions.return_to_draft.tolak, /^Return to Draft .*Ready to Submit\.$/);
    assert.match(claimWorkflowTransitions.submit_to_principal.tolak, /^Submit to Principal .*Ready to Submit\.$/);
    // Status pembayaran dan penutupan tidak pernah ditulis dari tabel ini.
    const tujuan: string[] = Object.values(claimWorkflowTransitions).map((t) => t.ke);
    for (const s of [S.partiallyPaid, S.paid, S.closed, S.cancelled]) assert.equal(tujuan.includes(s), false, s);
});

test("Master Barang: nama mirip yang belum dikonfirmasi menahan SEMUA aksi tulis, termasuk simpan kamus", () => {
    const aksi: Record<MasterAksi, RegExp> = { upload: /upload sumber/, kamus: /Kamus Kode/, finalisasi: /belum selesai 3 tahap/ };
    for (const [a, pesan] of Object.entries(aksi) as [MasterAksi, RegExp][]) {
        assert.match(tolakNamaMirip("blocked_similarity", a) ?? "", pesan, a);
        for (const s of ["draft", "review", "ready"] satisfies MasterStatus[]) assert.equal(tolakNamaMirip(s, a), null, `${s}/${a}`);
    }
    // Pesan upload dan finalisasi tidak berubah dari sebelum dipusatkan.
    assert.equal(tolakNamaMirip("blocked_similarity", "upload"), "Selesaikan 3 konfirmasi nama mirip sebelum upload sumber.");
    assert.equal(tolakNamaMirip("blocked_similarity", "finalisasi"), "Konfirmasi nama mirip belum selesai 3 tahap.");
});

test("insentif & laporan harian: daftar status yang sah", () => {
    assert.deepEqual([...STATUS_BAYAR_INSENTIF], ["belum", "lunas", "tunggakan"]);
    assert.deepEqual([...RETRYABLE_RECIPIENT_STATUSES], ["pending", "failed"]);
    assert.deepEqual(["dry_run", "sending", "sent", "failed"].filter((s) => canClaimReportRun(s)), ["dry_run", "failed"]);
    // Baris lunas tidak mundur lewat POST/PATCH; permintaan yang tidak menyentuh status tetap boleh.
    assert.match(tolakMundurLunas("lunas", "belum") ?? "", /sudah lunas/);
    assert.match(tolakMundurLunas("lunas", "tunggakan") ?? "", /sudah lunas/);
    for (const [lama, baru] of [["lunas", "lunas"], ["lunas", undefined], ["belum", "tunggakan"], ["tunggakan", "belum"], [undefined, "belum"], [null, "lunas"]] as const)
        assert.equal(tolakMundurLunas(lama, baru), null, `${lama} -> ${baru}`);
});

test("Laporan Harian: run macet dihitung dari jam klaim dan bisa diklaim ulang (BL-29)", () => {
    const t0 = new Date("2026-11-17T01:00:00.000Z");
    const menit = (n: number) => new Date(t0.getTime() + n * 60_000);
    const note = catatSendingAt("feed dashboard: +3 baris; email_mode:daily", t0);
    assert.equal(note, "feed dashboard: +3 baris; email_mode:daily; sending_at:2026-11-17T01:00:00.000Z");
    assert.equal(sendingAtDariNote(note)?.toISOString(), t0.toISOString());
    assert.equal(modeDariNote(note), "daily");
    // Klaim ulang MENGGANTI penanda — note tidak tumbuh, dan dua klaim serentak punya note berbeda.
    assert.equal(catatSendingAt(note, menit(20)), `feed dashboard: +3 baris; email_mode:daily; sending_at:${menit(20).toISOString()}`);
    assert.equal(catatSendingAt(null, t0), "sending_at:2026-11-17T01:00:00.000Z");
    assert.equal(sendingAtDariNote("email_mode:daily"), null);

    // Run lama (dibuat berminggu lalu) yang baru saja dikirim ulang BUKAN macet; lewat ambang baru macet.
    const lama = "2026-11-01T00:00:00Z";
    assert.equal(runMacet("sending", note, lama, menit(MACET_MENIT)), false);
    assert.equal(runMacet("sending", note, lama, menit(MACET_MENIT + 1)), true);
    assert.equal(runMacet("sending", null, lama, t0), true); // tanpa penanda: jatuh ke createdAt
    assert.equal(runMacet("failed", note, lama, menit(60)), false);
    assert.equal(statusRun("sending", lama, menit(5), note).kode, "mengirim");
    assert.equal(statusRun("sending", lama, menit(11), note).kode, "macet");

    assert.equal(canClaimReportRun("sending"), false);
    assert.equal(canClaimReportRun("sending", true), true);
    assert.equal(canClaimReportRun("sent", true), false);
});
