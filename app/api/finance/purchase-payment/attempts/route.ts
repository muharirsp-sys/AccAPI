/**
 * Tujuan: BACA-SAJA status attempt posting purchase-payment per kelompok Finance (S6-0e butir 6) — layar Finance
 *   (S6b) menampilkan mengirim / basi / terposting / tidak pasti / gagal, nomor PP, aktor, umur, database target.
 * Caller: app/(dashboard)/finance (S6b).
 * Dependensi: lib/accurate-write-attempt (latestAttemptsBySubject, purchasePaymentSubject), lib/rbac/resolve.
 * Main Functions: GET ?invoices=INV-1,INV-2&invoices=INV-3 (satu parameter = satu kelompok, maks. 100) ->
 *   {ok, data:[{invoices, subjectKey, attempt|null}]}. Subjek = himpunan faktur yang sama dengan POST (format kunci tidak berubah).
 * Side Effects: SELECT accurate_write_attempt (+ nama user). Tidak menulis apa pun, tidak memanggil Accurate.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/resolve";
import {
    attemptStatus, latestAttemptsBySubject, PURCHASE_PAYMENT_OPERATION, purchasePaymentSubject, type AttemptView,
} from "@/lib/accurate-write-attempt";

const MAX_GROUPS = 100;

/** Jam WITA (UTC+8, tanpa DST) untuk tampilan; ISO asli tetap dikirim. */
const wita = (d: Date) => new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 19).replace("T", " ");

function view(a: AttemptView) {
    const resolution = (a.resolution ?? null) as Record<string, unknown> | null;
    return {
        attemptId: a.id,
        state: a.state,
        status: attemptStatus(a.state, a.stale),
        stale: a.stale,
        accurateNumber: a.accurateNumber,
        accurateId: a.accurateId,
        actor: a.actor,
        actorName: a.actorName,
        targetDbId: a.targetDbId,
        generation: a.generation,
        ageSeconds: a.ageSeconds,
        createdAt: a.createdAt.toISOString(),
        createdAtWita: wita(a.createdAt),
        updatedAt: a.updatedAt.toISOString(),
        updatedAtWita: wita(a.updatedAt),
        message: String((a.outcome as { message?: unknown } | null)?.message ?? ""),
        resolution: resolution && {
            decision: resolution.decision ?? null, by: resolution.by ?? null, at: resolution.at ?? null,
            reason: resolution.reason ?? null, checkedSource: resolution.checked_source ?? null,
        },
    };
}

export async function GET(request: Request) {
    const gate = await requirePermission(request, "finance.view");
    if (gate.response) {
        const status = gate.response.status;
        return NextResponse.json({ ok: false, error: status === 401 ? "Sesi berakhir. Masuk ulang." : "Butuh izin finance.view." }, { status });
    }
    const groups = new URL(request.url).searchParams.getAll("invoices")
        .map((raw) => [...new Set(raw.split(",").map((x) => x.trim()).filter(Boolean))])
        .filter((list) => list.length > 0);
    if (!groups.length) {
        return NextResponse.json({ ok: false, error: "Parameter invoices wajib: satu per kelompok, nomor faktur dipisah koma." }, { status: 400 });
    }
    if (groups.length > MAX_GROUPS) {
        return NextResponse.json({ ok: false, error: `Maksimal ${MAX_GROUPS} kelompok per permintaan.` }, { status: 400 });
    }
    const subjects = groups.map((invoices) => purchasePaymentSubject({ detailInvoice: invoices.map((invoiceNo) => ({ invoiceNo, paymentAmount: 0 })) }));
    let latest: Map<string, AttemptView>;
    try {
        latest = await latestAttemptsBySubject(db, PURCHASE_PAYMENT_OPERATION, [...new Set(subjects)]);
    } catch (err) {
        console.error("[finance/purchase-payment/attempts] baca attempt gagal:", err);
        return NextResponse.json({ ok: false, error: "Status posting tidak bisa dibaca dari database. Coba lagi." }, { status: 503 });
    }
    return NextResponse.json({
        ok: true,
        data: groups.map((invoices, i) => {
            const attempt = latest.get(subjects[i]);
            return { invoices, subjectKey: subjects[i], attempt: attempt ? view(attempt) : null };
        }),
    });
}
