/*
 * Tujuan: Greeting & fallback responses untuk chatbot.
 * Caller: lib/chatbot/matcher.ts.
 * Dependensi: types.ts.
 */
import type { BotResponse } from "./types";

const GREETINGS = [
  "Halo! Saya Asisten Bantuan. Ada yang bisa saya bantu?",
  "Selamat datang di Ruang Kerja! Ketik 'menu' untuk panduan, atau tanya langsung.",
  "Hai! Saya siap membantu navigasi sistem. Apa yang Anda cari?",
];

const FALLBACKS = [
  "Maaf, saya belum mengerti pertanyaan itu. Coba ketik 'menu' untuk melihat panduan.",
  "Saya tidak yakin bisa menjawab itu. Ketik 'faq' untuk pertanyaan yang sering diajukan.",
  "Pertanyaan itu di luar kemampuan saya. Ketik 'bantuan' untuk opsi yang tersedia.",
];

const MENU_RESPONSE: BotResponse = {
  text: "Berikut yang bisa saya bantu:\n\n" +
    "📋 **FAQ**: Ketik 'faq' untuk pertanyaan umum\n" +
    "🧭 **Navigasi**: Tanya lokasi menu (misal: 'di mana OPC?')\n" +
    "📊 **Data**: Tanya data (misal: 'total klaim bulan ini')\n" +
    "🔧 **Modul**: Tanya tentang modul spesifik\n" +
    "👤 **Role**: Tanya berdasarkan role Anda\n" +
    "❓ **Bantuan**: Ketik 'bantuan' untuk panduan ini lagi\n\n" +
    "**Contoh pertanyaan:**\n" +
    "- \"bagaimana cara submit OPC?\"\n" +
    "- \"apa yang bisa dilakukan supervisor?\"\n" +
    "- \"total batch\"\n" +
    "- \"di mana menu insentif?\"\n" +
    "- \"bagaimana cara ganti tema?\"\n" +
    "- \"bagaimana cara mengelola pembayaran?\"\n" +
    "- \"apa itu Form Kontrol?\"",
  links: [
    { label: "Beranda", href: "/" },
    { label: "OFF Program Control", href: "/off-program-control" },
    { label: "Claim Workflow", href: "/claim-workflow" },
    { label: "Pembayaran", href: "/payments" },
    { label: "Insentif Sales", href: "/insentif-sales" },
    { label: "Form Kontrol", href: "/form-kontrol" },
    { label: "Finance", href: "/finance" },
  ],
};

export function getGreeting(): BotResponse {
  const text = GREETINGS[Math.floor(Math.random() * GREETINGS.length)];
  return {
    text,
    links: [{ label: "Mulai Jelajahi", href: "/" }],
  };
}

export function getFallback(): BotResponse {
  const text = FALLBACKS[Math.floor(Math.random() * FALLBACKS.length)];
  return { text };
}

export function getMenu(): BotResponse {
  return MENU_RESPONSE;
}
