const MAX_FILE_BYTES = 10 * 1024 * 1024;
const XLSX_MIMES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/octet-stream",
  "",
]);
const FIELDS = ["accurateFile", "principalFile"] as const;

export class UploadError extends Error {
  readonly status: 400 | 413 | 422;

  constructor(message: string, status: 400 | 413 | 422) {
    super(message);
    this.status = status;
  }
}

function validateFile(value: FormDataEntryValue, field: string): File {
  if (!(value instanceof File)) throw new UploadError(`${field} wajib berupa file.`, 400);
  if (!value.name.toLowerCase().endsWith(".xlsx")) throw new UploadError(`${field} harus berupa .xlsx.`, 400);
  if (!XLSX_MIMES.has(value.type)) throw new UploadError(`${field} memiliki tipe file yang tidak didukung.`, 400);
  if (!value.size) throw new UploadError(`${field} kosong.`, 400);
  if (value.size > MAX_FILE_BYTES) throw new UploadError(`${field} melebihi batas 10 MB.`, 413);
  return value;
}

export function validateUploadForm(form: FormData): [File, File] {
  for (const key of form.keys()) {
    if (!(FIELDS as readonly string[]).includes(key)) throw new UploadError(`Field upload tidak dikenal: ${key}.`, 400);
  }
  return FIELDS.map((key) => {
    const values = form.getAll(key);
    if (values.length !== 1) throw new UploadError(`${key} wajib diunggah tepat satu kali.`, 400);
    return validateFile(values[0], key === "accurateFile" ? "File Accurate" : "File SALES_DETAIL");
  }) as [File, File];
}

export function safeParserMessage(error: unknown): string | null {
  if (!(error instanceof Error) || /[\\/]|\b(?:stack|internal|enoent)\b/i.test(error.message)) return null;
  return /^(?:File (?:XLSX|mapping) kosong|Sheet (?:mapping )?[\w ]+ tidak ditemukan atau kosong|Header wajib tidak ditemukan: [\w, ]+|(?:[\w_]+ (?:kosong|negatif|tidak valid|terlalu besar)|[\w_]+ harus [\w/ ]+|[\w_]+ harus memuat tepat satu nomor order) pada baris \d+|Mapping_[\w]+ (?:tidak lengkap pada baris \d+|memiliki mapping konflik untuk [\w.-]+))$/.test(error.message)
    ? error.message
    : null;
}

export async function authorizeThenProcess(
  request: Request,
  authorize: (request: Request) => Promise<Response | null>,
  process: (request: Request) => Promise<Response>,
): Promise<Response> {
  return (await authorize(request)) ?? process(request);
}
