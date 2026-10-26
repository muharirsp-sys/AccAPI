/*
 * Tujuan: Panel Asisten Bantuan: penjawab berbasis daftar panduan (kata kunci, bukan AI) yang dibuka dari menu profil shell.
 * Caller: app/(dashboard)/layout.tsx (dirender sekali); SidebarLayout memicu lewat OPEN_HELP_EVENT.
 * Dependensi: POST /api/chatbot, lib/chatbot/types, canAccessPathWithKeys (menyaring tautan), komponen Fiori (Button, token).
 * Main Functions: ChatWidget, OPEN_HELP_EVENT.
 * Side Effects: Mengirim pertanyaan ke /api/chatbot; mengembalikan fokus ke pemicu saat ditutup.
 */
"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import Link from "next/link";
import { LifeBuoy, LoaderCircle, Send, User, X } from "lucide-react";
import type { ChatMessage } from "@/lib/chatbot/types";
import { canAccessPathWithKeys } from "@/lib/rbac";
import { fioriClass } from "@/components/fiori/Scope";
import { Button } from "@/components/fiori/core";

const WELCOME: ChatMessage = {
  id: "welcome",
  role: "bot",
  text: "Halo. Ketik 'menu' untuk melihat panduan, atau tulis pertanyaan Anda.",
  timestamp: Date.now(),
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

/** Dibuka dari menu profil shell (Bantuan); tombol chat mengambang dihapus karena menutupi konten dan navigasi bawah. */
export const OPEN_HELP_EVENT = "accapi:open-help";

/** `permKeys`: tautan bantuan hanya ditampilkan bila halamannya boleh dibuka akun ini (bukan pengganti cek izin server). */
export default function ChatWidget({ permKeys = [] }: { permKeys?: string[] }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([WELCOME]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages, loading]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Tanpa tombol mengambang, fokus dikembalikan ke pemicu (avatar menu profil) saat chat ditutup.
  const returnFocus = useRef<HTMLElement | null>(null);
  const close = useCallback(() => { setOpen(false); returnFocus.current?.focus(); }, []);

  useEffect(() => {
    const show = (event: Event) => {
      returnFocus.current = (event as CustomEvent<{ returnFocus?: HTMLElement | null }>).detail?.returnFocus ?? null;
      setOpen(true);
    };
    window.addEventListener(OPEN_HELP_EVENT, show);
    return () => window.removeEventListener(OPEN_HELP_EVENT, show);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;

    const userMsg: ChatMessage = { id: crypto.randomUUID(), role: "user", text, timestamp: Date.now() };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch("/api/chatbot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      if (res.status === 401) {
        setMessages((prev) => [
          ...prev,
          { id: crypto.randomUUID(), role: "bot", text: "Sesi login berakhir. Masuk ulang untuk memakai Asisten Bantuan.", timestamp: Date.now(), links: [{ label: "Masuk", href: "/login" }] },
        ]);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { reply } = await res.json();
      const botMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: "bot",
        text: reply.text ?? "Maaf, jawaban tidak tersedia. Coba tulis dengan kata lain.",
        timestamp: Date.now(),
        links: reply.links,
      };
      setMessages((prev) => [...prev, botMsg]);
    } catch {
      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: "bot", text: "Server tidak menjawab. Periksa koneksi, lalu kirim lagi.", timestamp: Date.now() },
      ]);
    } finally {
      setLoading(false);
    }
  }, [input, loading]);

  if (!open) return null;
  // /login selalu boleh; halaman lain hanya bila izin akun membukanya (tautan ke Akses ditolak tidak membantu).
  const bolehBuka = (href: string) => href === "/login" || canAccessPathWithKeys(href, permKeys);

  return (
    <div
      role="dialog"
      aria-label="Asisten Bantuan"
      aria-modal="false"
      className={`${fioriClass} fixed bottom-44 right-4 z-[100] flex w-[360px] max-w-[calc(100vw-32px)] [--chat-panel-gap:192px] flex-col overflow-hidden rounded-[var(--r-lg)] sm:right-6 md:bottom-24 md:[--chat-panel-gap:140px]`}
      style={{ height: "min(500px, calc(100dvh - var(--chat-panel-gap)))", background: "var(--surface)", boxShadow: "var(--shadow-2)" }}
    >
      <div className="flex items-center gap-2 border-b border-line bg-surface-2 py-1 pl-4 pr-1">
        <LifeBuoy className="fi-icon text-ink-muted" aria-hidden />
        <div className="grid min-w-0 flex-1">
          <span className="fi-title-3">Asisten Bantuan</span>
          <span className="fi-small text-ink-muted">Menjawab dari daftar panduan, bukan AI</span>
        </div>
        <Button variant="icon" onClick={close} aria-label="Tutup chat"><X className="fi-icon" aria-hidden /></Button>
      </div>

      <div ref={listRef} role="log" aria-live="polite" aria-label="Percakapan bantuan" className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {messages.map((msg) => {
          const links = msg.links?.filter((link) => bolehBuka(link.href)) ?? [];
          return (
            <div key={msg.id} className={`flex gap-2 ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
              {msg.role === "bot" && (
                <div className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-2" aria-hidden>
                  <LifeBuoy size={14} className="text-ink-muted" />
                </div>
              )}
              <div
                className={`max-w-[80%] whitespace-pre-wrap rounded-[var(--r-lg)] border px-3 py-2 ${msg.role === "user" ? "border-transparent bg-primary text-on-primary" : "border-line bg-surface-2 text-ink"}`}
              >
                {msg.role === "user" ? <span className="sr-only">Anda: </span> : <span className="sr-only">Asisten: </span>}
                {msg.text}
                {links.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {links.map((link) => (
                      <Link key={link.href} href={link.href} prefetch={false} onClick={close} className="fi-btn fi-btn--secondary">
                        {link.label}
                      </Link>
                    ))}
                  </div>
                )}
              </div>
              {msg.role === "user" && (
                <div className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-2" aria-hidden>
                  <User size={14} className="text-ink-muted" />
                </div>
              )}
            </div>
          );
        })}
        {loading && (
          <p className="fi-small flex items-center gap-2 text-ink-muted">
            <LoaderCircle className="fi-icon fi-spin" aria-hidden />Menyiapkan jawaban
          </p>
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        className="flex gap-2 border-t border-line bg-surface-2 px-3 py-2"
      >
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Tulis pertanyaan"
          maxLength={500}
          disabled={loading}
          className="fi-input flex-1"
          aria-label="Pesan chatbot"
        />
        {/* Tombol utama berbentuk ikon: lebar = tinggi kontrol (44 px di layar sentuh). */}
        <Button type="submit" variant="primary" disabled={!input.trim() || loading} aria-label="Kirim pesan" style={{ width: "var(--ctl-h)", padding: 0 }}>
          <Send className="fi-icon" aria-hidden />
        </Button>
      </form>
    </div>
  );
}
