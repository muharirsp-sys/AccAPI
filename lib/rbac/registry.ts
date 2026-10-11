/*
 * Tujuan: SUMBER TUNGGAL daftar permission key valid untuk Dynamic RBAC (Fase 2/4 — Opsi A).
 * Caller: lib/rbac/resolve.ts (guard route), UI admin RBAC (P6), registry.test.ts (guard test).
 * Main Functions: PERMISSION_REGISTRY, allPermissionKeys, isValidPermissionKey, CAPABILITY_KEYS, moduleAllOn, toggleModuleKeys.
 * Side Effects: Tidak ada; pure registry permission in-memory.
 * Dependensi: TIDAK ADA (pure data) — sengaja bebas import agar bisa di-test di mana saja.
 * Catatan: permission baru = tambah action di sini → otomatis terbaca RBAC. Default-deny:
 *   key yang TIDAK ada di registry ditolak; test-guard gagal kalau route pakai key tak terdaftar.
 *   `moduleActions` di lib/rbac.ts tetap ada untuk preset legacy selama transisi.
 */

// module -> daftar action valid. Permission key = `${module}.${action}`.
export const PERMISSION_REGISTRY = {
    dashboard: ["view"],
    api_wrapper: ["view", "execute"],
    // Order Masuk internal. Tanpa pendaftaran di sini, Access Group TIDAK BISA memberi
    // izin ini (registry adalah satu-satunya daftar key yang boleh disimpan) — jadi
    // modulnya hanya bisa dipakai admin. Ketinggalan saat modul order dibuat.
    // resolve_unknown (S6-0d E6/D-17, owner 9 Okt 2026) = selesaikan faktur antrean TIDAK PASTI
    //   (Tetapkan terposting / tidak terposting, wajib hasil pencarian + alasan). Kunci kapabilitas:
    //   order.edit TIDAK memberinya dan centang modul tidak menyalakannya; IT Support menambahkan ke grup.
    order: ["view", "create", "edit", "export", "resolve_unknown"],
    // Order Sales (Web Sales). SENGAJA terpisah dari `order`: `order.create` membuka
    // POST /orders internal yang menerima harga dari klien, sedangkan sales hanya boleh
    // mengirim kode/satuan/jumlah. Akun sales cukup `websales.view` + `websales.create`.
    websales: ["view", "create"],
    payments: ["view", "create", "edit", "update", "delete", "upload", "export", "submit"],
    sppd: ["view", "edit_settings", "upload_excel", "generate", "download"],
    // Aksi yang MEMBUKA kiriman ulang ke Accurate (owner D-14/D-15/D-18, 2026-09-30) = kewenangan Finance,
    //   satu kunci per kapabilitas (tidak saling menggantikan, ditegakkan backend):
    //   resolve_unknown    = selesaikan attempt purchase-payment sending/unknown (D-14);
    //   override_duplicate = override blok duplikat sales-receipt (D-18);
    //   repost_payment     = reopen/repost purchase-payment posted yang dihapus/void di Accurate (D-15,
    //                        belum ada route — menunggu ADR-004).
    //   retry_post = kunci lama; TIDAK memberi satu pun kapabilitas di atas (tidak ditegakkan, lihat D-01).
    finance: ["view", "approve", "transfer", "upload_proof", "post_accurate", "retry_post", "export", "update", "resolve_unknown", "override_duplicate", "repost_payment"],
    principles: ["view", "upload", "delete"],
    master_barang: ["view", "create", "upload", "edit", "generate", "export", "manage"],
    summary: ["view", "upload", "generate", "email", "export", "edit", "update"],
    reconciliation: ["view", "run", "manage"],
    // S7-1b (AM-042, D-01 §D): create/update/export DIPENSIUNKAN (KUNCI_PENSIUN di bawah) — diganti kunci granular; approve menyusul
    //   sesudah profil Beranda pindah ke bintang (S7-3, PK-O2).
    off_program_control: [
        "view", "approve",
        // workflow granular (mirror OffAction) — chain SPV→SM→Claim→OM→Finance:
        "create_batch", "edit_returned_batch", "submit_batch", "sm_approve", "sm_return",
        "claim_review", "claim_final", "om_approve", "om_cancel", "finance_payment",
        "submit_refund", "audit_read", "audit_export", "audit_correct", "period_close",
        "period_unlock", "discount_view", "discount_manage",
    ],
    claim_workflow: ["view", "create", "edit", "update", "submit", "approve", "export"],
    // S7-1b: create_user/edit_user/delete_user/set_role/set_permission DIPENSIUNKAN -> users.manage (KUNCI_PENSIUN).
    users: ["view", "manage"],
    // Modul yang sebelumnya TIDAK terdaftar di RBAC (temuan Fase 3 — page-guard gap):
    form_kontrol: ["view", "submit", "manage"],
    // view          = boleh membuka halaman & membaca angkanya (dipakai semua GET modul ini)
    // view_dashboard= tab Dashboard SM. Terpisah dari `view` supaya Finance yang cuma
    //                 memverifikasi pembayaran tidak ikut melihat layar performa tim.
    // view_all      = lihat seluruh perusahaan tanpa identitas hierarki. Kodenya sudah
    //                 menerima key ini sejak 2026-08-29 (LIHAT_SEMUA_KEYS di
    //                 lib/insentif-hierarchy-scope) dan grup Manager sudah memakainya
    //                 di produksi; pendaftarannya di sini sempat tertunda.
    insentif_sales: [
        "view", "view_dashboard", "view_all", "manage", "upload_target", "upload_progress",
        "input_support", "manage_payment", "manage_hierarchy",
    ],
    // History Penjualan (cascade No Faktur -> Detail). manage = upload/import CSV e-Faktur.
    sales_history: ["view", "export", "manage"],
    // Laporan Harian per SPV/SM (upload FIX -> feed dashboard + email). send = kirim email (gated); manage = ubah mapping penerima.
    laporan_harian: ["view", "upload", "send", "manage"],
    // Rekapan Nota (wave-based picking). print = cetak lembar picking/TTF;
    // approve_takeout = melepas nota dari wave (butuh persetujuan gudang, Q9).
    rekapan_nota: ["view", "manage", "print", "approve_takeout"],
    // kirim (S6e-2, owner #5 10 Okt 2026) = kirim pelunasan (sales-receipt) ke Accurate. Ditegakkan server di
    //   /api/proxy cabang tulis sales-receipt dan /api/idempotency/lock non-pratinjau (api_wrapper.execute tidak diminta dan tidak
    //   cukup). Tulis Konsol lain lewat /api/proxy = api_wrapper.execute + katalog Konsol (S7-1b, AM-024; GET baca = sesi app).
    //   Belum ada di preset grup mana pun — IT Support menambahkannya ke grup pengirim (D-17).
    pelunasan: ["kirim"],
    // Kasir ↔ Incaso (K1a BL-59, owner 11 Okt 2026). catat = catat/koreksi setoran + jelaskan selisih; tutup = tutup hari;
    //   buka = buka kembali hari terkunci (alasan tercatat) — kunci KAPABILITAS untuk OM/Admin (CAPABILITY_KEYS). Kasir/Incaso tidak
    //   memegang buka (D-01). Ke grup lewat docs/handover/RBAC_PRESET_KASIR.sql (sesudah RBAC_PRESET_BL37.sql S7-1).
    kasir: ["view", "catat", "tutup", "buka"],
} as const;

export type PermissionModule = keyof typeof PERMISSION_REGISTRY;
export type PermissionKey = string; // "module.action"

export const PERMISSION_MODULES = Object.keys(PERMISSION_REGISTRY) as PermissionModule[];

export function allPermissionKeys(): Set<string> {
    const keys = new Set<string>();
    for (const [moduleName, actions] of Object.entries(PERMISSION_REGISTRY)) {
        for (const action of actions) keys.add(`${moduleName}.${action}`);
    }
    return keys;
}

export function isValidPermissionKey(key: string): boolean {
    return allPermissionKeys().has(key);
}

/**
 * S7-1b (AM-042, D-01 §D "Pensiunkan"): kunci yang dihapus dari registry. Masih bisa tersimpan di group_permission sampai
 * docs/handover/RBAC_S7_1B_PENSIUN.sql dijalankan (SESUDAH image) — PATCH grup membuangnya dari kiriman tanpa 400 dan mencatatnya
 * di `removed` audit `group_permission.sync`. TIDAK dipetakan ke kunci granular (memetakan = memperluas akses).
 * off_program_control.approve menyusul di S7-3 (profil Beranda, PK-O2).
 */
export const KUNCI_PENSIUN: ReadonlySet<string> = new Set([
    "off_program_control.create", "off_program_control.update", "off_program_control.export",
    "users.create_user", "users.edit_user", "users.delete_user", "users.set_role", "users.set_permission",
]);

/** Kunci kapabilitas yang membuka kiriman ulang ke Accurate (D-14/D-15/D-18), menetapkan nasib faktur
 * tidak pasti (order.resolve_unknown, S6-0d E6), atau membuka kembali hari Kasir yang terkunci (kasir.buka, K1a).
 * UI grup tidak menyalakannya lewat centang modul — harus dicentang satu per satu (AM-057). UI bukan otoritas;
 * backend tetap menegakkan. */
export const CAPABILITY_KEYS: ReadonlySet<string> = new Set([
    "finance.resolve_unknown", "finance.override_duplicate", "finance.repost_payment", "order.resolve_unknown",
    "kasir.buka",
]);

const moduleKeys = (mod: PermissionModule) => PERMISSION_REGISTRY[mod].map((a) => `${mod}.${a}`);

/** Status centang modul di UI grup: semua kunci NON-kapabilitas modul aktif. */
export function moduleAllOn(current: ReadonlySet<string>, mod: PermissionModule): boolean {
    return moduleKeys(mod).filter((k) => !CAPABILITY_KEYS.has(k)).every((k) => current.has(k));
}

/** Centang modul di UI grup: sudah `moduleAllOn` -> cabut SEMUA kunci modul (termasuk kapabilitas); selain itu
 * nyalakan kunci non-kapabilitas saja. */
export function toggleModuleKeys(current: ReadonlySet<string>, mod: PermissionModule): Set<string> {
    const keys = moduleKeys(mod);
    const next = new Set(current);
    if (moduleAllOn(current, mod)) keys.forEach((k) => next.delete(k));
    else keys.filter((k) => !CAPABILITY_KEYS.has(k)).forEach((k) => next.add(k));
    return next;
}
