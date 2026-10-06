// JSON file persistence: config / rules / actions / bindings / logs + secrets.
// Secrets live in data/.secrets.json (gitignored). Everything else is plain JSON.
import * as fs from "fs";
import * as path from "path";

export interface RuleChoice {
  value: string;
  description: string;
}

export interface NoulCriteria {
  true?: string;
  false?: string;
}

export interface Rule {
  id: string;
  name: string;
  type: "choice" | "noul";
  instruction: string;
  choices: RuleChoice[];
  criteria?: NoulCriteria;
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

/** One key/value row of the user-defined JSON Jev state. */
export interface ContextField {
  key: string;
  value: string;
}

/**
 * User-defined Jev `state` context. `json` mode builds a flat object from
 * `fields`; `text` mode sends `text` as-is. Both embed {{message}}/{{username}}
 * tokens replaced per chat message (see server/context.ts).
 */
export interface ContextConfig {
  mode: "json" | "text";
  fields: ContextField[];
  text: string;
}

export interface Settings {
  channel: string;
  dryRun: boolean;
  judging: { batch: boolean };
  twitch: { clientId: string; broadcasterId: string; moderatorId: string };
  openrouter: { model: string };
  context: ContextConfig;
}

export interface Secrets {
  twitch?: {
    clientSecret?: string;
    accessToken?: string;
    refreshToken?: string;
    login?: string;
    userId?: string;
  };
  openrouter?: { apiKey?: string };
}

export interface VerdictLog {
  ts: string;
  user: string;
  msgId: string;
  msgText: string;
  ruleId: string;
  choice: string | null;
  confidence: number | null;
  probabilities: Record<string, number> | null;
  matched: boolean;
  lowConfidence: boolean;
  invalid: boolean;
  latencyMs: number;
  costUsd: number | null;
  actionsTaken: string[];
  dryRun: boolean;
  note?: string;
}

export const DATA_DIR =
  process.env.DATA_DIR ?? path.join(process.cwd(), "data");

const FILES = {
  config: "config.json",
  rules: "rules.json",
  actions: "actions.json",
  bindings: "bindings.json",
  secrets: ".secrets.json",
  logs: "logs.jsonl",
};

function filePath(name: string): string {
  return path.join(DATA_DIR, name);
}

function readJson<T>(name: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath(name))) return fallback;
    const raw = fs.readFileSync(filePath(name), "utf8");
    if (!raw.trim()) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(name: string, value: unknown): void {
  ensureDataDir();
  fs.writeFileSync(filePath(name), JSON.stringify(value, null, 2) + "\n");
}

export function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function defaultSettings(): Settings {
  return {
    channel: "",
    context: {
      fields: [
        { key: "message", value: "{{message}}" },
        { key: "username", value: "{{username}}" },
        { key: "context", value: "This message is sent on a Twitch chat." },
      ],
      mode: "json",
      text: "{{username}}: {{message}}",
    },
    dryRun: true,
    judging: { batch: true },
    twitch: { clientId: "", broadcasterId: "", moderatorId: "" },
    openrouter: { model: "typesafe/jev-1.13" },
  };
}

function defaultActions(): ActionDef[] {
  return [
    {
      enabled: true,
      id: "act-delete",
      name: "Delete message",
      params: { reason: "Removed by chat moderator bot" },
      type: "delete",
    },
  ];
}

function defaultRules(): Rule[] {
  return [
    {
      choices: [
        {
          description:
            "Unsolicited links, repeated copy-paste, follow-for-follow or promo spam.",
          value: "spam",
        },
        {
          description:
            "Ordinary chat: questions, reactions, emotes, conversation.",
          value: "ok",
        },
      ],
      enabled: true,
      id: "rule-spam",
      instruction:
        "Decide whether this Twitch chat message is spam that should be removed.",
      matchValues: ["spam"],
      minConfidence: 0.6,
      name: "Spam / links",
      type: "choice",
    },
  ];
}

function defaultBindings(): Binding[] {
  return [{ actionIds: ["act-delete"], choiceValue: "spam", ruleId: "rule-spam" }];
}

export function seedIfMissing(): void {
  ensureDataDir();
  if (!fs.existsSync(filePath(FILES.config)))
    writeJson(FILES.config, defaultSettings());
  if (!fs.existsSync(filePath(FILES.rules)))
    writeJson(FILES.rules, defaultRules());
  if (!fs.existsSync(filePath(FILES.actions)))
    writeJson(FILES.actions, defaultActions());
  if (!fs.existsSync(filePath(FILES.bindings)))
    writeJson(FILES.bindings, defaultBindings());
  if (!fs.existsSync(filePath(FILES.secrets)))
    writeJson(FILES.secrets, {});
  if (!fs.existsSync(filePath(FILES.logs))) fs.writeFileSync(filePath(FILES.logs), "");
}

export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

// Settings (non-secret part of config.json)
export function getSettings(): Settings {
  return { ...defaultSettings(), ...readJson<Partial<Settings>>(FILES.config, {}) };
}

export function saveSettings(s: Settings): Settings {
  writeJson(FILES.config, s);
  return s;
}

// Secrets
export function getSecrets(): Secrets {
  return readJson<Secrets>(FILES.secrets, {});
}

export function saveSecrets(s: Secrets): void {
  ensureDataDir();
  fs.writeFileSync(filePath(FILES.secrets), JSON.stringify(s, null, 2) + "\n", {
    mode: 0o600,
  });
}

export function patchSecrets(patch: Secrets): Secrets {
  const cur = getSecrets();
  const next: Secrets = {
    openrouter: { ...cur.openrouter, ...patch.openrouter },
    twitch: { ...cur.twitch, ...patch.twitch },
  };
  saveSecrets(next);
  return next;
}

// Rules / actions / bindings
export function getRules(): Rule[] {
  // Legacy rules predate the noul type and have no `type` — normalize to "choice".
  return readJson<Rule[]>(FILES.rules, defaultRules()).map((r) => ({
    ...r,
    type: r.type === "noul" ? "noul" : "choice",
  }));
}
export function saveRules(r: Rule[]): void {
  writeJson(FILES.rules, r);
}

export function getActions(): ActionDef[] {
  return readJson<ActionDef[]>(FILES.actions, defaultActions());
}
export function saveActions(a: ActionDef[]): void {
  writeJson(FILES.actions, a);
}

export function getBindings(): Binding[] {
  return readJson<Binding[]>(FILES.bindings, defaultBindings());
}
export function saveBindings(b: Binding[]): void {
  writeJson(FILES.bindings, b);
}

// Append-only verdict log
export function appendLog(entry: VerdictLog): void {
  ensureDataDir();
  fs.appendFileSync(filePath(FILES.logs), JSON.stringify(entry) + "\n");
}

export function readLogs(limit = 200): VerdictLog[] {
  try {
    const raw = fs.readFileSync(filePath(FILES.logs), "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    const tail = lines.slice(Math.max(0, lines.length - limit));
    return tail
      .map((l) => {
        try {
          return JSON.parse(l) as VerdictLog;
        } catch {
          return null;
        }
      })
      .filter((x): x is VerdictLog => x !== null);
  } catch {
    return [];
  }
}
