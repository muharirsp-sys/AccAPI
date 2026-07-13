import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { reconcileKinoSales } from "@/lib/off-program-control/sales-reconciliation";
import { requirePermission } from "@/lib/rbac/resolve";

export const runtime = "nodejs";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const XLSX_MIMES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/octet-stream",
  "",
]);

class UploadError extends Error {
  constructor(message: string, readonly status: 400 | 413 | 422) {
    super(message);
  }
}

function validateFile(value: FormDataEntryValue | null, field: string): File {
  if (!(value instanceof File)) throw new UploadError(`${field} wajib diunggah.`, 400);
  if (!value.name.toLowerCase().endsWith(".xlsx")) throw new UploadError(`${field} harus berupa .xlsx.`, 400);
  if (!XLSX_MIMES.has(value.type)) throw new UploadError(`${field} memiliki tipe file yang tidak didukung.`, 400);
  if (!value.size) throw new UploadError(`${field} kosong.`, 400);
  if (value.size > MAX_FILE_BYTES) throw new UploadError(`${field} melebihi batas 10 MB.`, 413);
  return value;
}

function isZip(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
}

export async function POST(request: Request) {
  const gate = await requirePermission(request, "reconciliation.run");
  if (gate.response) return gate.response;

  try {
    const form = await request.formData();
    const accurateFile = validateFile(form.get("accurateFile"), "File Accurate");
    const principalFile = validateFile(form.get("principalFile"), "File SALES_DETAIL");
    const [accurate, principal, mapping] = await Promise.all([
      accurateFile.arrayBuffer().then((value) => Buffer.from(value)),
      principalFile.arrayBuffer().then((value) => Buffer.from(value)),
      readFile(path.join(process.cwd(), "data", "reconciliation", "Kino.xlsx")),
    ]);
    if (!isZip(accurate) || !isZip(principal)) {
      throw new UploadError("File upload bukan workbook XLSX yang valid.", 422);
    }
    return NextResponse.json(reconcileKinoSales(accurate, principal, mapping, { valueTolerance: 1 }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Rekonsiliasi gagal diproses.";
    if (/ENOENT/.test(message)) {
      return NextResponse.json({ error: "Master mapping KINO tidak tersedia." }, { status: 500 });
    }
    return NextResponse.json(
      { error: error instanceof UploadError ? message : "Rekonsiliasi gagal diproses." },
      { status: error instanceof UploadError ? error.status : 422 },
    );
  }
}