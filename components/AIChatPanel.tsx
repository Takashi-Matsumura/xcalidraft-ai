"use client";

import { useState, useRef, useCallback } from "react";

interface Message {
  role: "user" | "assistant" | "error";
  content: string;
}

interface Props {
  onElementsGenerated: (elements: unknown[]) => void;
}

export default function AIChatPanel({ onElementsGenerated }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    setTimeout(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, 50);
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const prompt = input.trim();
    if (!prompt || loading) return;

    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: prompt }]);
    setLoading(true);
    scrollToBottom();

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: prompt }),
      });

      const data = await res.json();

      if (!res.ok) {
        setMessages((prev) => [
          ...prev,
          { role: "error", content: data.error || "Unknown error" },
        ]);
      } else if (data.elements) {
        onElementsGenerated(data.elements);
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: `Generated ${data.elements.length} elements on the canvas.`,
          },
        ]);
      }
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          role: "error",
          content: `Network error: ${err instanceof Error ? err.message : String(err)}`,
        },
      ]);
    } finally {
      setLoading(false);
      scrollToBottom();
    }
  };

  return (
    <div className="flex h-full w-80 flex-col border-l border-gray-300 bg-white">
      <div className="border-b border-gray-300 px-4 py-3 font-semibold text-gray-800">
        AI Diagram Generator
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {messages.length === 0 && (
          <p className="text-sm text-gray-400">
            Describe a diagram to generate. e.g. &quot;Draw a login flow
            chart&quot;
          </p>
        )}
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`rounded-lg px-3 py-2 text-sm ${
              msg.role === "user"
                ? "ml-4 bg-blue-100 text-blue-900"
                : msg.role === "error"
                  ? "bg-red-100 text-red-800"
                  : "mr-4 bg-gray-100 text-gray-800"
            }`}
          >
            {msg.content}
          </div>
        ))}
        {loading && (
          <div className="mr-4 rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-500">
            Generating diagram...
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <form onSubmit={handleSubmit} className="border-t border-gray-300 p-3">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Describe a diagram..."
            disabled={loading}
            className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-800 placeholder-gray-400 focus:border-blue-500 focus:outline-none disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            Send
          </button>
        </div>
      </form>
    </div>
  );
}
