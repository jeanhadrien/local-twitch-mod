// Action resolution + Helix enforcement. MVP enforces `delete`;
// `timeout` / `ban` are stubbed in the datamodel + UI only.
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

/** Execute resolved actions in order. Dry-run and timeout/ban stubs never touch Helix. */
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
    if (a.type === "delete") {
      try {
        await helixDeleteMessage(ctx, opts?.retryDelaysMs);
        outcomes.push({ actionId: a.id, ok: true, type: a.type });
      } catch (err) {
        outcomes.push({
          actionId: a.id,
          error: err instanceof Error ? err.message : String(err),
          ok: false,
          type: a.type,
        });
      }
    } else {
      // timeout / ban: stubbed for MVP (params plumbed, not wired).
      outcomes.push({
        actionId: a.id,
        ok: true,
        skipped: `${a.type}-not-wired-in-mvp`,
        type: a.type,
      });
    }
  }
  return outcomes;
}
