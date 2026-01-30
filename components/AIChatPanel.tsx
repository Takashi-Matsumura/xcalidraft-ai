"use client";

import { useState, useRef, useCallback, useEffect } from "react";

interface Message {
  role: "user" | "assistant" | "error";
  content: string;
  retryable?: boolean;
  originalPrompt?: string;
}

interface LLMResponse {
  action?: "add" | "replace" | "modify";
  elements?: unknown[];
}

interface ProviderConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
}

interface LLMSettings {
  activeProvider: string;
  providers: Record<string, ProviderConfig>;
}

const PROVIDERS: Record<string, { label: string; defaultUrl: string; defaultModel: string }> = {
  "ollama": { label: "Ollama", defaultUrl: "http://localhost:11434/v1", defaultModel: "llama3" },
  "llama-cpp": { label: "llama.cpp", defaultUrl: "http://localhost:8080/v1", defaultModel: "default" },
  "lm-studio": { label: "LM Studio", defaultUrl: "http://localhost:1234/v1", defaultModel: "default" },
  "openai": { label: "OpenAI", defaultUrl: "https://api.openai.com/v1", defaultModel: "gpt-4o" },
  "anthropic-openai": { label: "Anthropic (OpenAI互換)", defaultUrl: "https://api.anthropic.com/v1", defaultModel: "claude-sonnet-4-20250514" },
  "custom": { label: "Custom", defaultUrl: "http://localhost:8080/v1", defaultModel: "" },
};

function getProviderConfig(settings: LLMSettings): ProviderConfig {
  const key = settings.activeProvider;
  return settings.providers[key] || getDefaultProviderConfig(key);
}

function getDefaultProviderConfig(providerKey: string): ProviderConfig {
  const p = PROVIDERS[providerKey] || PROVIDERS.ollama;
  return { baseUrl: p.defaultUrl, model: p.defaultModel, apiKey: "" };
}

const DEFAULT_SETTINGS: LLMSettings = {
  activeProvider: "ollama",
  providers: Object.fromEntries(
    Object.entries(PROVIDERS).map(([key, p]) => [
      key,
      { baseUrl: p.defaultUrl, model: p.defaultModel, apiKey: "" },
    ]),
  ),
};

interface Props {
  onElementsGenerated: (elements: unknown[], action: string) => void;
  getCanvasContext?: () => string;
  onClearCanvas?: () => void;
}

const STORAGE_KEY = "excalidraft-chat-history";
const SETTINGS_STORAGE_KEY = "excalidraft-llm-settings";

const EXAMPLE_PROMPTS = [
  "Draw a login flow chart",
  "Create a microservice architecture diagram",
  "Design a mind map for project planning",
  "Draw a database ER diagram",
];

export default function AIChatPanel({
  onElementsGenerated,
  getCanvasContext,
  onClearCanvas,
}: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<LLMSettings>(DEFAULT_SETTINGS);
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "ok" | "error">("idle");
  const [testMessage, setTestMessage] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Restore chat history and settings from localStorage on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          setMessages(parsed);
        }
      }
    } catch {
      // Ignore corrupt data
    }
    try {
      const savedSettings = localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (savedSettings) {
        const parsed = JSON.parse(savedSettings);
        // Migrate from old format (flat) to new format (per-provider)
        if (parsed.providers) {
          setSettings({
            activeProvider: parsed.activeProvider || "ollama",
            providers: { ...DEFAULT_SETTINGS.providers, ...parsed.providers },
          });
        } else if (parsed.provider) {
          // Old format migration
          const migrated = { ...DEFAULT_SETTINGS };
          migrated.activeProvider = parsed.provider;
          migrated.providers[parsed.provider] = {
            baseUrl: parsed.baseUrl || getDefaultProviderConfig(parsed.provider).baseUrl,
            model: parsed.model || getDefaultProviderConfig(parsed.provider).model,
            apiKey: parsed.apiKey || "",
          };
          setSettings(migrated);
          localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(migrated));
        }
      }
    } catch {
      // Ignore
    }
  }, []);

  // Save chat history to localStorage whenever messages change
  useEffect(() => {
    if (messages.length > 0) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
      } catch {
        // Ignore storage errors
      }
    }
  }, [messages]);

  const scrollToBottom = useCallback(() => {
    setTimeout(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, 50);
  }, []);

  const cancelRequest = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  }, []);

  const sendMessage = useCallback(
    async (prompt: string) => {
      if (!prompt.trim() || loading) return;

      // Cancel any in-flight request
      cancelRequest();

      const userMessage: Message = { role: "user", content: prompt };
      setMessages((prev) => [...prev, userMessage]);
      setInput("");
      setLoading(true);
      setStreamingContent("");
      scrollToBottom();

      const controller = new AbortController();
      abortControllerRef.current = controller;

      // Build conversation history for the API
      const apiMessages = [...messages, userMessage]
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({ role: m.role, content: m.content }));

      // Get canvas context
      const canvasContext = getCanvasContext?.() || undefined;

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: apiMessages,
            canvasContext,
            llmSettings: {
              baseUrl: getProviderConfig(settings).baseUrl,
              model: getProviderConfig(settings).model,
              apiKey: getProviderConfig(settings).apiKey || undefined,
            },
          }),
          signal: controller.signal,
        });

        // Handle non-streaming JSON response (fallback)
        const contentType = res.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
          const data = await res.json();
          if (!res.ok) {
            setMessages((prev) => [
              ...prev,
              {
                role: "error",
                content: data.error || "Unknown error",
                retryable: true,
                originalPrompt: prompt,
              },
            ]);
          } else if (data.content) {
            // Non-streaming LLM response
            processLLMResponse(data.content, prompt);
          }
          return;
        }

        // Handle streaming SSE response
        if (!res.ok || !res.body) {
          setMessages((prev) => [
            ...prev,
            {
              role: "error",
              content: `Server error: ${res.status}`,
              retryable: true,
              originalPrompt: prompt,
            },
          ]);
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let accumulated = "";
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("data: ")) continue;

            const payload = trimmed.slice(6);
            if (payload === "[DONE]") continue;

            try {
              const data = JSON.parse(payload);
              if (data.error) {
                setMessages((prev) => [
                  ...prev,
                  {
                    role: "error",
                    content: data.error,
                    retryable: true,
                    originalPrompt: prompt,
                  },
                ]);
                return;
              }
              if (data.token) {
                accumulated += data.token;
                setStreamingContent(accumulated);
                scrollToBottom();
              }
            } catch {
              // Skip malformed SSE data
            }
          }
        }

        // Stream complete - process the full response
        if (accumulated) {
          processLLMResponse(accumulated, prompt);
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          setMessages((prev) => [
            ...prev,
            { role: "assistant", content: "Request cancelled." },
          ]);
        } else {
          const errorMsg =
            err instanceof Error ? err.message : String(err);
          let displayMsg = `Network error: ${errorMsg}`;
          if (errorMsg.includes("Failed to fetch")) {
            displayMsg = "Could not connect to server. Is it running?";
          }
          setMessages((prev) => [
            ...prev,
            {
              role: "error",
              content: displayMsg,
              retryable: true,
              originalPrompt: prompt,
            },
          ]);
        }
      } finally {
        setLoading(false);
        setStreamingContent("");
        abortControllerRef.current = null;
        scrollToBottom();
      }
    },
    [loading, messages, cancelRequest, scrollToBottom, getCanvasContext, settings],
  );

  const processLLMResponse = useCallback(
    (content: string, prompt: string) => {
      let parsed: LLMResponse;
      try {
        parsed = JSON.parse(content);
      } catch {
        // Try to extract JSON from the response
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            parsed = JSON.parse(jsonMatch[0]);
          } catch {
            setMessages((prev) => [
              ...prev,
              {
                role: "error",
                content:
                  "AI returned invalid JSON. Try rephrasing your request.",
                retryable: true,
                originalPrompt: prompt,
              },
            ]);
            return;
          }
        } else {
          setMessages((prev) => [
            ...prev,
            {
              role: "error",
              content:
                "AI returned invalid JSON. Try rephrasing your request.",
              retryable: true,
              originalPrompt: prompt,
            },
          ]);
          return;
        }
      }

      if (
        !Array.isArray(parsed.elements) ||
        parsed.elements.length === 0
      ) {
        setMessages((prev) => [
          ...prev,
          {
            role: "error",
            content: "AI response missing elements. Try again.",
            retryable: true,
            originalPrompt: prompt,
          },
        ]);
        return;
      }

      const action = parsed.action || "add";
      onElementsGenerated(parsed.elements, action);

      const actionLabels: Record<string, string> = {
        add: "Added",
        replace: "Replaced canvas with",
        modify: "Modified",
      };
      const label = actionLabels[action] || "Generated";

      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: `${label} ${parsed.elements!.length} elements on the canvas.`,
        },
      ]);
    },
    [onElementsGenerated],
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    sendMessage(input);
  };

  const handleRetry = (prompt: string) => {
    sendMessage(prompt);
  };

  const handleClearChat = () => {
    setMessages([]);
    localStorage.removeItem(STORAGE_KEY);
    onClearCanvas?.();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      sendMessage(input);
    }
    // Enter without modifier sends (Shift+Enter for newline)
    if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height =
        Math.min(textareaRef.current.scrollHeight, 120) + "px";
    }
  }, [input]);

  return (
    <div className="flex h-full w-80 flex-col border-l border-gray-300 bg-white">
      <div className="flex items-center justify-between border-b border-gray-300 px-4 py-3">
        <span className="font-semibold text-gray-800">
          AI Diagram Generator
        </span>
        <div className="flex items-center gap-2">
          {messages.length > 0 && (
            <button
              onClick={handleClearChat}
              className="text-xs text-gray-400 hover:text-gray-600"
              title="Clear chat history"
            >
              Clear
            </button>
          )}
          <button
            onClick={() => setShowSettings((v) => !v)}
            className="text-gray-400 hover:text-gray-600"
            title="LLM Settings"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
              <circle cx="12" cy="12" r="3"/>
            </svg>
          </button>
        </div>
      </div>

      {showSettings && (() => {
        const activeKey = settings.activeProvider;
        const current = getProviderConfig(settings);

        const updateProvider = (field: keyof ProviderConfig, value: string) => {
          const newSettings: LLMSettings = {
            ...settings,
            providers: {
              ...settings.providers,
              [activeKey]: { ...current, [field]: value },
            },
          };
          setSettings(newSettings);
          localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(newSettings));
        };

        return (
          <div className="border-b border-gray-300 bg-gray-50 px-4 py-3 space-y-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Provider</label>
              <select
                value={activeKey}
                onChange={(e) => {
                  const newSettings: LLMSettings = {
                    ...settings,
                    activeProvider: e.target.value,
                  };
                  setSettings(newSettings);
                  setTestStatus("idle");
                  setTestMessage("");
                  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(newSettings));
                }}
                className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm text-gray-800 focus:border-blue-500 focus:outline-none"
              >
                {Object.entries(PROVIDERS).map(([key, { label }]) => (
                  <option key={key} value={key}>{label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Base URL</label>
              <input
                type="text"
                value={current.baseUrl}
                onChange={(e) => updateProvider("baseUrl", e.target.value)}
                className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm text-gray-800 focus:border-blue-500 focus:outline-none"
                placeholder="http://localhost:11434/v1"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Model</label>
              <input
                type="text"
                value={current.model}
                onChange={(e) => updateProvider("model", e.target.value)}
                className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm text-gray-800 focus:border-blue-500 focus:outline-none"
                placeholder="llama3"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">API Key (optional)</label>
              <input
                type="password"
                value={current.apiKey}
                onChange={(e) => updateProvider("apiKey", e.target.value)}
                className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm text-gray-800 focus:border-blue-500 focus:outline-none"
                placeholder="Not required for local LLMs"
              />
            </div>
            <button
              type="button"
              onClick={async () => {
                setTestStatus("testing");
                try {
                  const res = await fetch("/api/chat/test", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      baseUrl: current.baseUrl,
                      model: current.model,
                      apiKey: current.apiKey || undefined,
                    }),
                  });
                  const data = await res.json();
                  setTestStatus(data.ok ? "ok" : "error");
                  setTestMessage(data.ok ? data.message : data.error);
                } catch (err) {
                  setTestStatus("error");
                  setTestMessage(err instanceof Error ? err.message : "Connection failed");
                }
              }}
              disabled={testStatus === "testing"}
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50"
            >
              {testStatus === "testing" ? "Testing..." : "Test Connection"}
            </button>
            {testStatus === "ok" && (
              <p className="text-xs text-green-600">{testMessage}</p>
            )}
            {testStatus === "error" && (
              <p className="text-xs text-red-600">{testMessage}</p>
            )}
            <p className="text-xs text-gray-400">Settings are saved per provider automatically.</p>
          </div>
        );
      })()}

      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {messages.length === 0 && !loading && (
          <div className="space-y-2">
            <p className="text-sm text-gray-400">
              Describe a diagram to generate:
            </p>
            <div className="space-y-1.5">
              {EXAMPLE_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  onClick={() => sendMessage(prompt)}
                  className="block w-full rounded-lg border border-gray-200 px-3 py-2 text-left text-sm text-gray-600 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 transition-colors"
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i}>
            <div
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
            {msg.role === "error" && msg.retryable && msg.originalPrompt && (
              <button
                onClick={() => handleRetry(msg.originalPrompt!)}
                disabled={loading}
                className="mt-1 text-xs text-red-600 hover:text-red-800 underline disabled:opacity-50"
              >
                Retry
              </button>
            )}
          </div>
        ))}
        {loading && (
          <div className="mr-4 rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-500">
            {streamingContent ? (
              <div>
                <div className="mb-1 text-xs text-gray-400">
                  Streaming... ({streamingContent.length} chars)
                </div>
                <div className="max-h-32 overflow-y-auto font-mono text-xs text-gray-600 whitespace-pre-wrap break-all">
                  {streamingContent.slice(-200)}
                </div>
              </div>
            ) : (
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-gray-400" />
                Waiting for AI response...
              </span>
            )}
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <form onSubmit={handleSubmit} className="border-t border-gray-300 p-3">
        <div className="flex gap-2">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Describe a diagram... (Enter to send)"
            disabled={loading}
            rows={1}
            className="flex-1 resize-none rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-800 placeholder-gray-400 focus:border-blue-500 focus:outline-none disabled:opacity-50"
          />
          {loading ? (
            <button
              type="button"
              onClick={cancelRequest}
              className="rounded-lg bg-red-500 px-4 py-2 text-sm font-medium text-white hover:bg-red-600"
            >
              Cancel
            </button>
          ) : (
            <button
              type="submit"
              disabled={!input.trim()}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              Send
            </button>
          )}
        </div>
        <div className="mt-1 text-right text-xs text-gray-400">
          {loading ? "Press Cancel to stop" : "Shift+Enter for newline"}
        </div>
      </form>
    </div>
  );
}
