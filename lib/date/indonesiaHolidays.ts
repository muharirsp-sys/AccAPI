/*
 * Tujuan: Helper format tanggal API/display dan penanda tanggal merah Indonesia.
 * Caller: DatePickerField dan halaman dashboard yang memakai input tanggal.
 * Dependensi: date-fns untuk formatting kalender lokal.
 * Main Functions: formatDateForDisplay, formatDateForApi, isHoliday, isSunday, isRedDate, getHolidayName.
 * Side Effects: Tidak ada; data libur nasional/cuti bersama disimpan in-memory.
 */

import { format, isValid } from "date-fns";
import { id as idLocale } from "date-fns/locale";

export type IndonesiaHoliday = {
    date: string;
    name: string;
    kind: "national" | "joint_leave";
};

export const indonesiaHolidays: IndonesiaHoliday[] = [
    { date: "2026-01-01", name: "Tahun Baru 2026 Masehi", kind: "national" },
    { date: "2026-01-16", name: "Isra Mikraj Nabi Muhammad SAW", kind: "national" },
    { date: "2026-02-16", name: "Cuti Bersama Tahun Baru Imlek 2577 Kongzili", kind: "joint_leave" },
    { date: "2026-02-17", name: "Tahun Baru Imlek 2577 Kongzili", kind: "national" },
    { date: "2026-03-18", name: "Cuti Bersama Hari Suci Nyepi Tahun Baru Saka 1948", kind: "joint_leave" },
    { date: "2026-03-19", name: "Hari Suci Nyepi Tahun Baru Saka 1948", kind: "national" },
    { date: "2026-03-20", name: "Cuti Bersama Hari Raya Idul Fitri 1447 H", kind: "joint_leave" },
    { date: "2026-03-21", name: "Hari Raya Idul Fitri 1447 H", kind: "national" },
    { date: "2026-03-22", name: "Hari Raya Idul Fitri 1447 H", kind: "national" },
    { date: "2026-03-23", name: "Cuti Bersama Hari Raya Idul Fitri 1447 H", kind: "joint_leave" },
    { date: "2026-03-24", name: "Cuti Bersama Hari Raya Idul Fitri 1447 H", kind: "joint_leave" },
    { date: "2026-04-03", name: "Wafat Yesus Kristus", kind: "national" },
    { date: "2026-04-05", name: "Kebangkitan Yesus Kristus (Paskah)", kind: "national" },
    { date: "2026-05-01", name: "Hari Buruh Internasional", kind: "national" },
    { date: "2026-05-14", name: "Kenaikan Yesus Kristus", kind: "national" },
    { date: "2026-05-15", name: "Cuti Bersama Kenaikan Yesus Kristus", kind: "joint_leave" },
    { date: "2026-05-27", name: "Idul Adha 1447 H", kind: "national" },
    { date: "2026-05-28", name: "Cuti Bersama Idul Adha 1447 H", kind: "joint_leave" },
    { date: "2026-05-31", name: "Hari Raya Waisak 2570 BE", kind: "national" },
    { date: "2026-06-01", name: "Hari Lahir Pancasila", kind: "national" },
    { date: "2026-06-16", name: "1 Muharam Tahun Baru Islam 1448 H", kind: "national" },
    { date: "2026-08-17", name: "Proklamasi Kemerdekaan", kind: "national" },
    { date: "2026-08-25", name: "Maulid Nabi Muhammad SAW", kind: "national" },
    { date: "2026-12-24", name: "Cuti Bersama Kelahiran Yesus Kristus", kind: "joint_leave" },
    { date: "2026-12-25", name: "Kelahiran Yesus Kristus", kind: "national" },
];

const holidayByDate = new Map(indonesiaHolidays.map((holiday) => [holiday.date, holiday]));

function pad2(value: number): string {
    return String(value).padStart(2, "0");
}

export function parseApiDate(value?: string | Date | null): Date | undefined {
    if (!value) return undefined;
    if (value instanceof Date) return isValid(value) ? value : undefined;

    const text = String(value).trim();
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (match) {
        const year = Number(match[1]);
        const month = Number(match[2]);
        const day = Number(match[3]);
        const date = new Date(year, month - 1, day);
        return isValid(date) ? date : undefined;
    }

    const date = new Date(text);
    return isValid(date) ? date : undefined;
}

export function formatDateForApi(value?: string | Date | null): string {
    const date = parseApiDate(value);
    if (!date) return "";
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function formatDateForDisplay(value?: string | Date | null): string {
    const date = parseApiDate(value);
    if (!date) return "";
    return format(date, "dd MMM yyyy", { locale: idLocale });
}

export function isSunday(value?: string | Date | null): boolean {
    const date = parseApiDate(value);
    return Boolean(date && date.getDay() === 0);
}

export function getHoliday(value?: string | Date | null): IndonesiaHoliday | undefined {
    const apiDate = formatDateForApi(value);
    return apiDate ? holidayByDate.get(apiDate) : undefined;
}

export function isHoliday(value?: string | Date | null): boolean {
    return Boolean(getHoliday(value));
}

export function isRedDate(value?: string | Date | null): boolean {
    return isHoliday(value) || isSunday(value);
}

export function getHolidayName(value?: string | Date | null): string {
    const holiday = getHoliday(value);
    if (holiday) return holiday.name;
    return isSunday(value) ? "Minggu" : "";
}
