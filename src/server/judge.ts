// Judge engine — TypeSafe Jev 1.13 via the OpenRouter Decisions API.
// Jev is NOT an LLM: do NOT use /api/v1/chat/completions. By default all enabled
// rules are judged in ONE POST to https://openrouter.ai/api/alpha/decisions
// with { state, questions } (one question per rule); any batch-level failure
// falls back to sequential per-rule calls. Disable via settings.judging.batch.
// Transport retries 429/5xx/network/timeout with fixed backoff [500,1000,2000]ms
// (4 attempts); 400/401/403 fail fast.
import type { Rule } from "./store";
import { HttpStatusError, withRetry } from "./retry";

export const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
export const DEFAULT_MODEL = "typesafe/jev-1.13";

export interface ChatState {
  user: string;
  message: string;
}

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface JudgeResult {
  ruleId: string;
  choice: string | null;
  confidence: number | null;
  probabilities: Record<string, number> | null;
  /** choice ∈ matchValues AND confidence >= minConfidence */
  matched: boolean;
  /** choice ∈ matchValues but confidence below threshold → log only, no action */
  lowConfidence: boolean;
  /** answer missing or choice not in rule.choices → log only, no action */
  invalid: boolean;
  latencyMs: number;
  costUsd: number | null;
}

type FetchFn = typeof fetch;

export interface JudgeOpts {
  apiKey: string;
  model?: string;
  fetchFn?: FetchFn;
  timeoutMs?: number;
  /** false = sequential per-rule calls. Default true (batch + sequential fallback). */
  batch?: boolean;
  /** Fixed backoff delays between retries. Default [500, 1000, 2000] (4 attempts). */
  retryDelaysMs?: number[];
}

function toNumber(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Pure match evaluation shared by live judging, the test playground, and verification. */
export function evaluateAnswer(
  rule: Rule,
  answer: unknown,
  latencyMs = 0,
  costUsd: number | null = null,
): JudgeResult {
  const base = {
    choice: null as string | null,
    confidence: null as number | null,
    costUsd,
    invalid: false,
    latencyMs,
    lowConfidence: false,
    matched: false,
    probabilities: null as Record<string, number> | null,
    ruleId: rule.id,
  };
  const rec =
    answer && typeof answer === "object" ? (answer as Record<string, unknown>) : null;
  const choice = rec && typeof rec["choice"] === "string" ? (rec["choice"] as string) : null;
  const knownValues = new Set(rule.choices.map((c) => c.value));

  if (!rec || choice === null || !knownValues.has(choice)) {
    return { ...base, invalid: true, matched: false };
  }

  const probs =
    rec["probabilities"] && typeof rec["probabilities"] === "object"
      ? (rec["probabilities"] as Record<string, number>)
      : null;
  // PLAN: (confidence ?? 1) >= minConfidence.
  const confidence =
    rec["confidence"] === undefined || rec["confidence"] === null
      ? 1
      : toNumber(rec["confidence"], 1);
  const threshold =
    rule.minConfidence === undefined || rule.minConfidence === null
      ? 0.6
      : toNumber(rule.minConfidence, 0.6);
  const inMatch = rule.matchValues.includes(choice);

  if (inMatch && confidence < threshold) {
    return {
      ...base,
      choice,
      confidence,
      lowConfidence: true,
      matched: false,
      probabilities: probs,
    };
  }
  return {
    ...base,
    choice,
    confidence,
    matched: inMatch,
    probabilities: probs,
  };
}

/** Build the Decisions API request body for a set of rules (one question per rule). */
export function buildDecisionsBody(
  rules: Rule[],
  state: ChatState,
  model: string,
): Record<string, unknown> {
  const questions: Record<string, unknown> = {};
  for (const rule of rules) {
    const criteria: Record<string, string> = {};
    for (const c of rule.choices) criteria[c.value] = c.description;
    questions[rule.id] = {
      criteria,
      instructions: rule.instruction,
      type: "choice",
    };
  }
  return {
    model,
    questions,
    state: { message: state.message, user: state.user },
  };
}

/** POST one Decisions request. Throws on transport or API errors. */
async function postDecisions(
  body: Record<string, unknown>,
  opts: { apiKey: string; fetchFn: FetchFn; timeoutMs: number },
): Promise<{ answers: Record<string, unknown>; cost: number | null }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
  try {
    const res = (await opts.fetchFn(DECISIONS_URL, {
      body: JSON.stringify(body),
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "Content-Type": "application/json",
        "X-Title": "klawz-chat-ai moderator",
      },
      method: "POST",
      signal: ctrl.signal,
    })) as Response;
    if (!res.ok)
      throw new HttpStatusError(res.status, `Decisions API error (${res.status})`);
    const json = (await res.json()) as {
      answers?: Record<string, unknown>;
      usage?: { cost?: number };
    };
    return {
      answers: json.answers ?? {},
      cost:
        json.usage && typeof json.usage.cost === "number" ? json.usage.cost : null,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** One Jev call for one rule. Never throws — transport errors become invalid results. */
export async function judgeRule(
  rule: Rule,
  state: ChatState,
  opts: JudgeOpts,
): Promise<JudgeResult> {
  const model = opts.model || DEFAULT_MODEL;
  const fetchFn: FetchFn = opts.fetchFn ?? fetch;
  const started = Date.now();
  try {
    const { answers, cost } = await withRetry(
      () =>
        postDecisions(buildDecisionsBody([rule], state, model), {
          apiKey: opts.apiKey,
          fetchFn,
          timeoutMs: opts.timeoutMs ?? 20000,
        }),
      opts.retryDelaysMs,
    );
    return evaluateAnswer(rule, answers[rule.id], Date.now() - started, cost);
  } catch {
    return {
      choice: null,
      confidence: null,
      costUsd: null,
      invalid: true,
      latencyMs: Date.now() - started,
      lowConfidence: false,
      matched: false,
      probabilities: null,
      ruleId: rule.id,
    };
  }
}

/**
 * Judge all rules in a single Decisions call (state sent once, one question
 * per rule). Aggregate cost is split evenly across rules for per-verdict
 * attribution. Throws on batch-level failure so the caller can fall back to
 * sequential per-rule calls; a missing answer for one rule only marks that
 * rule invalid (no retry — avoids double-billing a provider quirk).
 */
export async function judgeRulesBatched(
  rules: Rule[],
  state: ChatState,
  opts: JudgeOpts,
): Promise<JudgeResult[]> {
  const model = opts.model || DEFAULT_MODEL;
  const fetchFn: FetchFn = opts.fetchFn ?? fetch;
  const started = Date.now();
  const { answers, cost } = await withRetry(
    () =>
      postDecisions(buildDecisionsBody(rules, state, model), {
        apiKey: opts.apiKey,
        fetchFn,
        timeoutMs: opts.timeoutMs ?? 20000,
      }),
    opts.retryDelaysMs,
  );
  const latencyMs = Date.now() - started;
  const perRuleCost = cost === null ? null : cost / rules.length;
  return rules.map((rule) =>
    evaluateAnswer(rule, answers[rule.id], latencyMs, perRuleCost),
  );
}

/** Batch by default (single call + sequential fallback); sequential if batch === false. */
export async function judgeAllRules(
  rules: Rule[],
  state: ChatState,
  opts: JudgeOpts,
): Promise<JudgeResult[]> {
  const enabled = rules.filter((r) => r.enabled);
  if (opts.batch !== false && enabled.length > 1) {
    try {
      return await judgeRulesBatched(enabled, state, opts);
    } catch {
      // Batch failed (one bad rule must not blind the rest) — retry sequentially.
    }
  }
  const out: JudgeResult[] = [];
  for (const rule of enabled) {
    out.push(await judgeRule(rule, state, opts));
  }
  return out;
}
