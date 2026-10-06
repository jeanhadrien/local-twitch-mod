// Typed fetch helpers for the backend API.
export interface RuleChoice {
  value: string;
  description: string;
}
export interface Rule {
  id: string;
  name: string;
  instruction: string;
  choices: RuleChoice[];
  matchValues: string[];
  minConfidence: number;
  enabled: boolean;
}
export interface ActionDef {
  id: string;
  name: string;
  type: "delete" | "timeout" | "ban";
  enabled: boolean;
  params?: { durationSec?: number; reason?: string };
}
export interface Binding {
  ruleId: string;
  choiceValue: string;
  actionIds: string[];
}
export interface SettingsView {
  channel: string;
  dryRun: boolean;
  twitch: { clientId: string; broadcasterId: string; moderatorId: string };
  openrouter: { model: string };
  twitchLoggedIn: boolean;
  twitchLogin: string | null;
}
export interface TestVerdict {
  ruleId: string;
  choice: string | null;
  confidence: number | null;
  probabilities: Record<string, number> | null;
  matched: boolean;
  lowConfidence: boolean;
  invalid: boolean;
  latencyMs: number;
  costUsd: number | null;
  wouldExecute: Array<{ id: string; name: string; type: string }>;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status} ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export const api = {
  getActions: () => req<ActionDef[]>("/api/actions"),
  getBindings: () => req<Binding[]>("/api/bindings"),
  getBotStatus: () => req<{ connected: boolean; channel: string; paused: boolean }>("/api/bot/status"),
  getLogs: (limit = 200) => req<Record<string, unknown>[]>(`/api/logs?limit=${limit}`),
  getRules: () => req<Rule[]>("/api/rules"),
  getSettings: () => req<SettingsView>("/api/settings"),
  pauseBot: (paused: boolean) =>
    req<{ paused: boolean }>("/api/bot/pause", {
      body: JSON.stringify({ paused }),
      method: "POST",
    }),
  saveActions: (a: ActionDef) =>
    a.id.startsWith("new-")
      ? req<ActionDef>("/api/actions", { body: JSON.stringify({ ...a, id: undefined }), method: "POST" })
      : req<ActionDef>(`/api/actions/${a.id}`, { body: JSON.stringify(a), method: "PUT" }),
  saveBindings: (b: Binding[]) =>
    req<Binding[]>("/api/bindings", { body: JSON.stringify(b), method: "PUT" }),
  saveRule: (r: Rule) =>
    r.id.startsWith("new-")
      ? req<Rule>("/api/rules", { body: JSON.stringify({ ...r, id: undefined }), method: "POST" })
      : req<Rule>(`/api/rules/${r.id}`, { body: JSON.stringify(r), method: "PUT" }),
  saveSettings: (body: unknown) =>
    req<SettingsView>("/api/settings", { body: JSON.stringify(body), method: "PUT" }),
  startBot: () => req<{ connected: boolean }>("/api/bot/start", { method: "POST" }),
  stopBot: () => req<{ ok: boolean }>("/api/bot/stop", { method: "POST" }),
  test: (body: { user: string; message: string; ruleId?: string }) =>
    req<TestVerdict[]>("/api/test", { body: JSON.stringify(body), method: "POST" }),
  deleteAction: (id: string) => req<{ ok: boolean }>(`/api/actions/${id}`, { method: "DELETE" }),
  deleteRule: (id: string) => req<{ ok: boolean }>(`/api/rules/${id}`, { method: "DELETE" }),
};
