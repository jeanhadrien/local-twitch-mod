// Judge engine — TypeSafe Jev 1.13 via the OpenRouter Decisions API.
// Jev is NOT an LLM: do NOT use /api/v1/chat/completions. One POST per rule to
// POST https://openrouter.ai/api/alpha/decisions with { state, questions } and
// a typed choice answer (choice + confidence + probabilities) per rule.
import type { Rule } from "./store";

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

/** Build the per-rule Decisions API request body (criteria map required). */
export function buildDecisionsBody(
  rule: Rule,
  state: ChatState,
  model: string,
): Record<string, unknown> {
  const criteria: Record<string, string> = {};
  for (const c of rule.choices) criteria[c.value] = c.description;
  return {
    model,
    questions: {
      [rule.id]: {
        criteria,
        instructions: rule.instruction,
        type: "choice",
      },
    },
    state: { message: state.message, user: state.user },
  };
}

/** One Jev call for one rule. Never throws — transport errors become invalid results. */
export async function judgeRule(
  rule: Rule,
  state: ChatState,
  opts: { apiKey: string; model?: string; fetchFn?: FetchFn; timeoutMs?: number },
): Promise<JudgeResult> {
  const model = opts.model || DEFAULT_MODEL;
  const fetchFn: FetchFn = opts.fetchFn ?? fetch;
  const started = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20000);
    let res: Response;
    try {
      res = (await fetchFn(DECISIONS_URL, {
        body: JSON.stringify(buildDecisionsBody(rule, state, model)),
        headers: {
          Authorization: `Bearer ${opts.apiKey}`,
          "Content-Type": "application/json",
          "X-Title": "klawz-chat-ai moderator",
        },
        method: "POST",
        signal: ctrl.signal,
      })) as Response;
    } finally {
      clearTimeout(timer);
    }
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      return {
        choice: null,
        confidence: null,
        costUsd: null,
        invalid: true,
        latencyMs,
        lowConfidence: false,
        matched: false,
        probabilities: null,
        ruleId: rule.id,
      };
    }
    const json = (await res.json()) as {
      answers?: Record<string, unknown>;
      usage?: { cost?: number };
    };
    const answer = json.answers?.[rule.id];
    const cost =
      json.usage && typeof json.usage.cost === "number" ? json.usage.cost : null;
    return evaluateAnswer(rule, answer, latencyMs, cost);
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

/** Sequential per-rule judging (locked decision: isolation over latency). */
export async function judgeAllRules(
  rules: Rule[],
  state: ChatState,
  opts: { apiKey: string; model?: string; fetchFn?: FetchFn; timeoutMs?: number },
): Promise<JudgeResult[]> {
  const out: JudgeResult[] = [];
  for (const rule of rules) {
    if (!rule.enabled) continue;
    out.push(await judgeRule(rule, state, opts));
  }
  return out;
}
