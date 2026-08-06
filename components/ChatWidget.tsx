"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { MessageCircle, X, Send, Bot, User, ExternalLink } from "lucide-react";
import type { ChatMessage } from "@/lib/chatbot/types";

const WELCOME: ChatMessage = {
  id: "welcome",
  role: "bot",
  text: "Halo! Saya AI Assistant. Ketik 'menu' untuk panduan, atau tanya langsung.",
  timestamp: Date.now(),
  links: [
    { label: "Dashboard", href: "/" },
    { label: "OPC", href: "/off-program-control" },
    { label: "Claim", href: "/claim-workflow" },
    { label: "Pembayaran", href: "/payments" },
    { label: "Insentif Sales", href: "/insentif-sales" },
    { label: "Form Kontrol", href: "/form-kontrol" },
    { label: "Finance", href: "/finance" },
  ],
};

export default function ChatWidget() {
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

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

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
          { id: crypto.randomUUID(), role: "bot", text: "Anda belum login. Silakan login terlebih dahulu untuk menggunakan chatbot.", timestamp: Date.now(), links: [{ label: "Login", href: "/login" }] },
        ]);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { reply } = await res.json();
      const botMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: "bot",
        text: reply.text ?? "Maaf, terjadi kesalahan.",
        timestamp: Date.now(),
        links: reply.links,
      };
      setMessages((prev) => [...prev, botMsg]);
    } catch {
      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: "bot", text: "Gagal menghubungi server. Coba lagi.", timestamp: Date.now() },
      ]);
    } finally {
      setLoading(false);
    }
  }, [input, loading]);

  return (
    <>
      {/* Floating button */}
      <button
        onClick={() => setOpen(!open)}
        className="fixed bottom-6 right-6 z-[100] flex h-14 w-14 items-center justify-center rounded-full bg-indigo-600 text-white shadow-lg transition-all hover:bg-indigo-500 hover:scale-105 active:scale-95"
        aria-label={open ? "Tutup chat" : "Buka chat"}
        aria-expanded={open}
      >
        {open ? <X size={24} /> : <MessageCircle size={24} />}
      </button>

      {/* Chat window */}
      {open && (
        <div
          role="dialog"
          aria-label="AI Assistant"
          aria-modal="false"
          className="fixed bottom-24 right-4 z-[100] flex w-[360px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-2xl border border-white/20 bg-[#111318] shadow-2xl sm:right-6"
          style={{ height: "min(500px, calc(100dvh - 140px))" }}
        >
          {/* Header */}
          <div className="flex items-center gap-2 border-b border-white/5 bg-indigo-600/20 px-4 py-3">
            <Bot size={18} className="text-indigo-400" />
            <span className="text-sm font-semibold text-white">AI Assistant</span>
            <span className="ml-auto text-[10px] text-slate-500">Rule-Based</span>
          </div>

          {/* Messages */}
          <div ref={listRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-3 scrollbar-thin">
            {messages.map((msg) => (
              <div key={msg.id} className={`flex gap-2 ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                {msg.role === "bot" && (
                  <div className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-indigo-500/20">
                    <Bot size={14} className="text-indigo-400" />
                  </div>
                )}
                <div
                  className={`max-w-[80%] rounded-xl px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap ${
                    msg.role === "user"
                      ? "bg-indigo-600 text-white"
                      : "bg-white/10 text-slate-100"
                  }`}
                >
                  {msg.text}
                  {msg.links && msg.links.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {msg.links.map((link) => (
                        <a
                          key={link.href}
                          href={link.href}
                          className="inline-flex items-center gap-1 rounded-md bg-indigo-500/20 px-2 py-1 text-xs text-indigo-300 transition-colors hover:bg-indigo-500/30"
                        >
                          {link.label}
                          <ExternalLink size={10} />
                        </a>
                      ))}
                    </div>
                  )}
                </div>
                {msg.role === "user" && (
                  <div className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-600/50">
                    <User size={14} className="text-slate-400" />
                  </div>
                )}
              </div>
            ))}
            {loading && (
              <div className="flex gap-2">
                <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-indigo-500/20">
                  <Bot size={14} className="text-indigo-400" />
                </div>
                <div className="rounded-xl bg-white/10 px-3 py-2">
                  <div className="flex gap-1">
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-500 [animation-delay:0ms]" />
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-500 [animation-delay:150ms]" />
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-500 [animation-delay:300ms]" />
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Input */}
          <div className="border-t border-white/5 px-3 py-2">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                send();
              }}
              className="flex gap-2"
            >
              <input
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Ketik pesan..."
                maxLength={500}
                disabled={loading}
                className="flex-1 rounded-lg bg-white/5 px-3 py-2 text-sm text-white placeholder-slate-500 outline-none transition-colors focus:bg-white/10 disabled:opacity-50"
                aria-label="Pesan chatbot"
              />
              <button
                type="submit"
                disabled={!input.trim() || loading}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-600 text-white transition-all hover:bg-indigo-500 disabled:opacity-30 disabled:hover:bg-indigo-600"
                aria-label="Kirim pesan"
              >
                <Send size={16} />
              </button>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
