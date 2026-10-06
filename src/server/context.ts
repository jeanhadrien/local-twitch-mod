// User-defined Jev `state` context. The user supplies either a JSON object
// (flat key/value rows, structurally built — never parsed from text) or a plain
// string; both embed bare tokens {{message}} / {{username}} that the backend
// substitutes per incoming chat message. Pure module: no Express, no fs.
import type { ContextConfig } from "./store";

/** Token names the user may embed. Anything else blocks saving. */
export const TOKENS = ["message", "username"] as const;

export interface ContextVars {
  message: string;
  username: string;
}

// Matches {{name}} (whitespace inside the braces tolerated and trimmed).
const TOKEN_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;

export class ContextError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(errors.join("; "));
    this.name = "ContextError";
    this.errors = errors;
  }
}

/** Names referenced by every token occurrence in the config, deduped. */
function referencedTokenNames(cfg: ContextConfig): string[] {
  const names = new Set<string>();
  const scan = (s: string): void => {
    for (const m of s.matchAll(TOKEN_RE)) names.add(m[1]);
  };
  if (cfg.mode === "text") scan(cfg.text ?? "");
  else for (const f of cfg.fields ?? []) scan(f.value ?? "");
  return [...names];
}

/**
 * Human-readable validation errors, empty when valid. Rules: unknown tokens
 * anywhere; in JSON mode empty keys and duplicate keys.
 */
export function validateContext(cfg: ContextConfig): string[] {
  const errors: string[] = [];
  const known: readonly string[] = TOKENS;
  for (const name of referencedTokenNames(cfg)) {
    if (!known.includes(name))
      errors.push(`Unknown token {{${name}}} (allowed: {{message}}, {{username}})`);
  }
  if (cfg.mode === "json") {
    const seen = new Set<string>();
    (cfg.fields ?? []).forEach((f, i) => {
      if (!f.key.trim()) errors.push(`Field ${i + 1}: key must not be empty`);
      else if (seen.has(f.key)) errors.push(`Duplicate key "${f.key}"`);
      else seen.add(f.key);
    });
  }
  return errors;
}

/**
 * Build the Jev state for one message: a string in text mode, a
 * Record<string,string> in JSON mode. Missing vars resolve to "". Throws
 * ContextError when the config is invalid (validate first to surface errors).
 */
export function resolveContext(cfg: ContextConfig, vars: ContextVars): unknown {
  const errors = validateContext(cfg);
  if (errors.length > 0) throw new ContextError(errors);
  const lookup: Record<string, string> = {
    message: vars.message,
    username: vars.username,
  };
  const subst = (s: string): string =>
    s.replace(TOKEN_RE, (_m, name: string) => lookup[name] ?? "");
  if (cfg.mode === "text") return subst(cfg.text ?? "");
  const out: Record<string, string> = {};
  for (const f of cfg.fields ?? []) out[f.key] = subst(f.value ?? "");
  return out;
}
