// Action resolution + Helix enforcement for delete / timeout / ban / warn.
import type { ActionDef, Binding } from "./store";
import { HttpStatusError, withRetry } from "./retry";

/** Resolve bindings for (ruleId, choiceValue) → enabled actions, in binding order. */
export function resolveActions(
  ruleId: string,
  choiceValue: string | null,
  bindings: Binding[],
  actions: ActionDef[],
): ActionDef[] {
  if (!choiceValue) return [];
  const byId = new Map(actions.map((a) => [a.id, a]));
  const out: ActionDef[] = [];
  for (const b of bindings) {
    if (b.ruleId !== ruleId || b.choiceValue !== choiceValue) continue;
    for (const id of b.actionIds) {
      const a = byId.get(id);
      if (a && a.enabled && !out.some((x) => x.id === a.id)) out.push(a);
    }
  }
  return out;
}

export interface EnforceCtx {
  broadcasterId: string;
  moderatorId: string;
  moderatorToken: string;
  clientId: string;
  messageId: string;
  /** Twitch user id of the message author (empty when tmi.js omitted it). */
  userId: string;
  dryRun: boolean;
}

export interface ActionOutcome {
  actionId: string;
  type: string;
  ok: boolean;
  skipped?: string;
  error?: string;
}

async function helixDeleteMessage(
  ctx: EnforceCtx,
  retryDelaysMs?: number[],
): Promise<void> {
  await withRetry(async () => {
    const q = new URLSearchParams({
      broadcaster_id: ctx.broadcasterId,
      message_id: ctx.messageId,
      moderator_id: ctx.moderatorId,
    });
    const res = await fetch(`https://api.twitch.tv/helix/moderation/chat?${q}`, {
      headers: {
        Authorization: `Bearer ${ctx.moderatorToken}`,
        "Client-Id": ctx.clientId,
      },
      method: "DELETE",
    });
    if (!res.ok && res.status !== 204) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 200);
      } catch {
        // empty body or stubbed response — status is enough
      }
      throw new HttpStatusError(
        res.status,
        `Helix delete failed (${res.status})${detail ? `: ${detail}` : ""}`,
      );
    }
  }, retryDelaysMs);
}

const MAX_TIMEOUT_SEC = 1209600;

/** Clamp a timeout duration into Twitch's 1..1209600s range; unset/invalid → 600. */
function normalizeTimeoutSec(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 600;
  return Math.min(MAX_TIMEOUT_SEC, Math.max(1, Math.floor(n)));
}

/** POST /helix/moderation/bans — timeout with a duration, permanent ban without one. */
async function helixBanUser(
  ctx: EnforceCtx,
  action: ActionDef,
  retryDelaysMs?: number[],
): Promise<void> {
  await withRetry(async () => {
    const q = new URLSearchParams({
      broadcaster_id: ctx.broadcasterId,
      moderator_id: ctx.moderatorId,
    });
    const data: Record<string, unknown> = { user_id: ctx.userId };
    if (action.type === "timeout")
      data["duration"] = normalizeTimeoutSec(action.params?.durationSec);
    data["reason"] = action.params?.reason ?? "";
    const res = await fetch(`https://api.twitch.tv/helix/moderation/bans?${q}`, {
      body: JSON.stringify({ data }),
      headers: {
        Authorization: `Bearer ${ctx.moderatorToken}`,
        "Client-Id": ctx.clientId,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 200);
      } catch {
        // empty body or stubbed response — status is enough
      }
      throw new HttpStatusError(
        res.status,
        `Helix ban failed (${res.status})${detail ? `: ${detail}` : ""}`,
      );
    }
  }, retryDelaysMs);
}

/** POST /helix/moderation/warnings — reason is required by Twitch (1..500 chars). */
async function helixWarnUser(
  ctx: EnforceCtx,
  action: ActionDef,
  retryDelaysMs?: number[],
): Promise<void> {
  await withRetry(async () => {
    const q = new URLSearchParams({
      broadcaster_id: ctx.broadcasterId,
      moderator_id: ctx.moderatorId,
    });
    const res = await fetch(`https://api.twitch.tv/helix/moderation/warnings?${q}`, {
      body: JSON.stringify({
        data: { reason: action.params?.reason ?? "", user_id: ctx.userId },
      }),
      headers: {
        Authorization: `Bearer ${ctx.moderatorToken}`,
        "Client-Id": ctx.clientId,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 200);
      } catch {
        // empty body or stubbed response — status is enough
      }
      throw new HttpStatusError(
        res.status,
        `Helix warn failed (${res.status})${detail ? `: ${detail}` : ""}`,
      );
    }
  }, retryDelaysMs);
}

/** Execute resolved actions in order. Dry-run short-circuits first; banning/warning needs a userId. */
export async function executeActions(
  resolved: ActionDef[],
  ctx: EnforceCtx,
  opts?: { retryDelaysMs?: number[] },
): Promise<ActionOutcome[]> {
  const outcomes: ActionOutcome[] = [];
  for (const a of resolved) {
    if (ctx.dryRun) {
      outcomes.push({
        actionId: a.id,
        ok: true,
        skipped: "dry-run",
        type: a.type,
      });
      continue;
    }
    try {
      if (a.type === "delete") {
        await helixDeleteMessage(ctx, opts?.retryDelaysMs);
      } else if (a.type === "timeout" || a.type === "ban") {
        if (!ctx.userId) throw new Error(`missing user id — cannot ${a.type}`);
        await helixBanUser(ctx, a, opts?.retryDelaysMs);
      } else if (a.type === "warn") {
        if (!ctx.userId) throw new Error("missing user id — cannot warn");
        await helixWarnUser(ctx, a, opts?.retryDelaysMs);
      } else {
        outcomes.push({
          actionId: a.id,
          ok: true,
          skipped: `${String(a.type)}-not-wired`,
          type: String(a.type),
        });
        continue;
      }
      outcomes.push({ actionId: a.id, ok: true, type: a.type });
    } catch (err) {
      outcomes.push({
        actionId: a.id,
        error: err instanceof Error ? err.message : String(err),
        ok: false,
        type: a.type,
      });
    }
  }
  return outcomes;
}
