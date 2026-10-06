// REST API + Twitch OAuth callback + SSE feed.
import type { Express, Request, Response } from "express";
import { executeActions, resolveActions } from "./actions";
import { ContextError, resolveContext, validateContext } from "./context";
import { broadcast, sseSubscribe } from "./events";
import { judgeAllRules } from "./judge";
import {
  appendLog,
  getActions,
  getBindings,
  getRules,
  getSecrets,
  getSettings,
  newId,
  patchSecrets,
  readLogs,
  saveActions,
  saveBindings,
  saveRules,
  saveSettings,
  type ActionDef,
  type Binding,
  type ContextConfig,
  type ContextField,
  type Rule,
} from "./store";
import {
  chatStatus,
  connectChat,
  disconnectChat,
  exchangeCode,
  getCurrentUser,
  loginUrl,
} from "./twitch";

function port(): number {
  return Number(process.env.PORT ?? 3000);
}

/**
 * Validate an untrusted `context` payload: shape first (mode/fields/text), then
 * token/key semantics via validateContext. Returns the config or an error list.
 */
function parseContext(raw: unknown): ContextConfig | { errors: string[] } {
  if (!raw || typeof raw !== "object") return { errors: ["context must be an object"] };
  const obj = raw as Record<string, unknown>;
  const errors: string[] = [];
  const mode = obj["mode"];
  if (mode !== "json" && mode !== "text") errors.push('context.mode must be "json" or "text"');
  const text = obj["text"];
  if (typeof text !== "string") errors.push("context.text must be a string");
  const fields: ContextField[] = [];
  const rawFields = obj["fields"];
  if (!Array.isArray(rawFields)) {
    errors.push("context.fields must be an array");
  } else {
    rawFields.forEach((f, i) => {
      if (!f || typeof f !== "object") {
        errors.push(`context.fields[${i}] must be an object`);
        return;
      }
      const rec = f as Record<string, unknown>;
      if (typeof rec["key"] !== "string") errors.push(`context.fields[${i}].key must be a string`);
      if (typeof rec["value"] !== "string")
        errors.push(`context.fields[${i}].value must be a string`);
      if (typeof rec["key"] === "string" && typeof rec["value"] === "string")
        fields.push({ key: rec["key"], value: rec["value"] });
    });
  }
  if (errors.length > 0) return { errors };
  const cfg: ContextConfig = { fields, mode: mode as ContextConfig["mode"], text: text as string };
  const semantic = validateContext(cfg);
  if (semantic.length > 0) return { errors: semantic };
  return cfg;
}

/** Server-side validation for Helix-enforced action params (mirrors the Actions UI). */
function actionError(a: Pick<ActionDef, "type" | "params">): string | null {
  const reason = a.params?.reason ?? "";
  if (a.type === "warn" && (reason.trim().length === 0 || reason.length > 500))
    return "warn reason must be 1..500 characters";
  const duration = a.params?.durationSec;
  if (a.type === "timeout" && duration !== undefined) {
    if (!Number.isFinite(duration) || duration < 1 || duration > 1209600)
      return "timeout durationSec must be 1..1209600";
  }
  return null;
}

function sanitizedSettings() {
  const s = getSettings();
  const secrets = getSecrets();
  return {
    channel: s.channel,
    context: s.context,
    dryRun: s.dryRun,
    judging: { batch: s.judging?.batch !== false },
    openrouter: { model: s.openrouter.model },
    twitch: s.twitch,
    twitchLoggedIn: Boolean(secrets.twitch?.accessToken),
    twitchLogin: secrets.twitch?.login ?? null,
  };
}

export function registerRoutes(app: Express): void {
  // --- settings ---
  app.get("/api/settings", (_req, res) => res.json(sanitizedSettings()));

  app.put("/api/settings", (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const cur = getSettings();
    let context = cur.context;
    if (body["context"] !== undefined) {
      const parsed = parseContext(body["context"]);
      if ("errors" in parsed) return res.status(400).json({ errors: parsed.errors });
      context = parsed;
    }
    const channel =
      typeof body["channel"] === "string" ? (body["channel"] as string) : cur.channel;
    const dryRun = typeof body["dryRun"] === "boolean" ? body["dryRun"] : cur.dryRun;
    const tw = (body["twitch"] ?? {}) as Record<string, unknown>;
    const or = (body["openrouter"] ?? {}) as Record<string, unknown>;
    const judgingBody = (body["judging"] ?? {}) as Record<string, unknown>;
    const next = {
      ...cur,
      channel: channel.trim().replace(/^#/, ""),
      context,
      dryRun,
      judging: {
        batch:
          typeof judgingBody["batch"] === "boolean"
            ? (judgingBody["batch"] as boolean)
            : (cur.judging?.batch ?? true),
      },
      openrouter: {
        model:
          typeof or["model"] === "string" && or["model"] ? (or["model"] as string) : cur.openrouter.model,
      },
      twitch: {
        broadcasterId:
          typeof tw["broadcasterId"] === "string" ? (tw["broadcasterId"] as string) : cur.twitch.broadcasterId,
        clientId: typeof tw["clientId"] === "string" ? (tw["clientId"] as string) : cur.twitch.clientId,
        moderatorId:
          typeof tw["moderatorId"] === "string" ? (tw["moderatorId"] as string) : cur.twitch.moderatorId,
      },
    };
    saveSettings(next);
    const sec = (body["secrets"] ?? {}) as Record<string, unknown>;
    const patch: Parameters<typeof patchSecrets>[0] = {};
    const twSec = (sec["twitch"] ?? {}) as Record<string, unknown>;
    if (typeof twSec["clientSecret"] === "string" && twSec["clientSecret"])
      patch.twitch = { ...patch.twitch, clientSecret: twSec["clientSecret"] as string };
    const orSec = (sec["openrouter"] ?? {}) as Record<string, unknown>;
    if (typeof orSec["apiKey"] === "string" && orSec["apiKey"])
      patch.openrouter = { apiKey: orSec["apiKey"] as string };
    if (patch.twitch || patch.openrouter) patchSecrets(patch);
    res.json(sanitizedSettings());
  });

  // --- rules CRUD ---
  app.get("/api/rules", (_req, res) => res.json(getRules()));

  app.post("/api/rules", (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Partial<Rule>;
    const rules = getRules();
    const rule: Rule = {
      choices: Array.isArray(body.choices) ? body.choices : [],
      criteria:
        body.criteria && typeof body.criteria === "object"
          ? {
              ...(typeof body.criteria.true === "string" ? { true: body.criteria.true } : {}),
              ...(typeof body.criteria.false === "string" ? { false: body.criteria.false } : {}),
            }
          : undefined,
      enabled: body.enabled ?? true,
      id: newId("rule"),
      instruction: body.instruction ?? "",
      matchValues: Array.isArray(body.matchValues) ? body.matchValues : [],
      minConfidence: typeof body.minConfidence === "number" ? body.minConfidence : 0.6,
      name: body.name ?? "Untitled rule",
      type: body.type === "noul" ? "noul" : "choice",
    };
    rules.push(rule);
    saveRules(rules);
    res.status(201).json(rule);
  });

  app.put("/api/rules/:id", (req: Request, res: Response) => {
    const rules = getRules();
    const i = rules.findIndex((r) => r.id === req.params.id);
    if (i === -1) return res.status(404).json({ error: "rule not found" });
    const merged = { ...rules[i], ...req.body, id: rules[i].id };
    rules[i] = { ...merged, type: merged.type === "noul" ? "noul" : "choice" };
    saveRules(rules);
    return res.json(rules[i]);
  });

  app.delete("/api/rules/:id", (req: Request, res: Response) => {
    saveRules(getRules().filter((r) => r.id !== req.params.id));
    saveBindings(getBindings().filter((b) => b.ruleId !== req.params.id));
    res.json({ ok: true });
  });

  // --- actions CRUD ---
  app.get("/api/actions", (_req, res) => res.json(getActions()));

  app.post("/api/actions", (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Partial<ActionDef>;
    const actions = getActions();
    const action: ActionDef = {
      enabled: body.enabled ?? true,
      id: newId("act"),
      name: body.name ?? "Untitled action",
      params: body.params ?? {},
      type:
        body.type === "timeout" || body.type === "ban" || body.type === "warn"
          ? body.type
          : "delete",
    };
    const invalid = actionError(action);
    if (invalid) return res.status(400).json({ error: invalid });
    actions.push(action);
    saveActions(actions);
    res.status(201).json(action);
  });

  app.put("/api/actions/:id", (req: Request, res: Response) => {
    const actions = getActions();
    const i = actions.findIndex((a) => a.id === req.params.id);
    if (i === -1) return res.status(404).json({ error: "action not found" });
    const merged: ActionDef = {
      ...actions[i],
      ...(req.body as Partial<ActionDef>),
      id: actions[i].id,
    };
    const invalid = actionError(merged);
    if (invalid) return res.status(400).json({ error: invalid });
    actions[i] = merged;
    saveActions(actions);
    return res.json(actions[i]);
  });

  app.delete("/api/actions/:id", (req: Request, res: Response) => {
    saveActions(getActions().filter((a) => a.id !== req.params.id));
    saveBindings(
      getBindings().map((b) => ({
        ...b,
        actionIds: b.actionIds.filter((id) => id !== req.params.id),
      })),
    );
    res.json({ ok: true });
  });

  // --- bindings (ruleId + choiceValue → actionIds) ---
  app.get("/api/bindings", (_req, res) => res.json(getBindings()));

  app.put("/api/bindings", (req: Request, res: Response) => {
    const body = req.body as Binding[] | { bindings: Binding[] };
    const list = Array.isArray(body) ? body : body.bindings;
    if (!Array.isArray(list)) return res.status(400).json({ error: "expected array" });
    saveBindings(list);
    return res.json(list);
  });

  // --- test playground: judge without enforcing ---
  app.post("/api/test", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      user?: string;
      message?: string;
      ruleId?: string;
    };
    const secrets = getSecrets();
    const apiKey = secrets.openrouter?.apiKey ?? "";
    if (!apiKey) return res.status(400).json({ error: "OpenRouter API key not set (Setup page)" });
    if (!body.message) return res.status(400).json({ error: "message required" });
    const settings = getSettings();
    let rules = getRules().filter((r) => r.enabled);
    if (body.ruleId) rules = rules.filter((r) => r.id === body.ruleId);
    let state: unknown;
    try {
      state = resolveContext(settings.context, {
        message: body.message,
        username: body.user ?? "tester",
      });
    } catch (err) {
      if (err instanceof ContextError)
        return res.status(400).json({ errors: err.errors });
      throw err;
    }
    const results = await judgeAllRules(
      rules,
      state,
      { apiKey, batch: settings.judging?.batch !== false, model: settings.openrouter.model },
    );
    const bindings = getBindings();
    const actions = getActions();
    res.json(
      results.map((r) => ({
        ...r,
        matched: r.matched,
        wouldExecute: r.matched
          ? resolveActions(r.ruleId, r.choice, bindings, actions).map((a) => ({
              id: a.id,
              name: a.name,
              type: a.type,
            }))
          : [],
      })),
    );
  });

  // --- context preview: resolve state for sample/custom vars (parity with pipeline) ---
  app.post("/api/context/preview", (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { context?: unknown; vars?: Record<string, unknown> };
    const parsed = parseContext(body.context);
    if ("errors" in parsed) return res.status(400).json({ errors: parsed.errors });
    const vars = body.vars ?? {};
    const state = resolveContext(parsed, {
      message:
        typeof vars["message"] === "string"
          ? vars["message"]
          : "FREE FOLLOWERS at scam.example",
      username: typeof vars["username"] === "string" ? vars["username"] : "someviewer",
    });
    return res.json({ state });
  });

  // --- logs ---
  app.get("/api/logs", (req: Request, res: Response) => {
    const limit = Math.min(Number(req.query.limit ?? 200) || 200, 2000);
    res.json(readLogs(limit));
  });

  // --- SSE live feed ---
  app.get("/api/events", (req: Request, res: Response) => {
    res.writeHead(200, {
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
    });
    res.write(": connected\n\n");
    const unsub = sseSubscribe(res);
    req.on("close", unsub);
  });

  // --- bot controls ---
  app.get("/api/bot/status", (_req, res) => {
    res.json({ ...chatStatus(), paused: isPaused(), settings: sanitizedSettings() });
  });

  app.post("/api/bot/start", async (_req, res: Response) => {
    try {
      const settings = getSettings();
      const secrets = getSecrets();
      if (!settings.channel) return res.status(400).json({ error: "channel not set" });
      if (!secrets.twitch?.accessToken || !secrets.twitch?.login)
        return res.status(400).json({ error: "Twitch login required (Setup page)" });
      setPaused(false);
      await connectChat({
        channel: settings.channel,
        onMessage: (msg) => void handleLiveMessage(msg.user, msg.text, msg.msgId, msg.userId),
        token: secrets.twitch.accessToken,
        username: secrets.twitch.login,
      });
      res.json({ ok: true, ...chatStatus() });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/bot/stop", async (_req, res: Response) => {
    await disconnectChat();
    res.json({ ok: true });
  });

  app.post("/api/bot/pause", (req: Request, res: Response) => {
    setPaused(Boolean((req.body as { paused?: boolean } | undefined)?.paused ?? true));
    res.json({ ok: true, paused: isPaused() });
  });

  // --- Twitch OAuth ---
  app.get("/auth/login", (_req, res) => {
    const { clientId } = getSettings().twitch;
    if (!clientId) return res.status(400).json({ error: "Twitch Client ID not set (Setup page)" });
    res.redirect(loginUrl(clientId, port()));
  });

  app.get("/auth/callback", async (req: Request, res: Response) => {
    const code = req.query.code as string | undefined;
    if (!code) return res.status(400).send("Missing ?code=");
    try {
      const settings = getSettings();
      const secrets = getSecrets();
      const clientSecret = secrets.twitch?.clientSecret ?? "";
      if (!settings.twitch.clientId || !clientSecret)
        return res.status(400).send("Client ID/Secret not set — see Setup page");
      const tokens = await exchangeCode(
        settings.twitch.clientId,
        clientSecret,
        code,
        port(),
      );
      const me = await getCurrentUser(tokens.access_token, settings.twitch.clientId);
      patchSecrets({
        twitch: {
          accessToken: tokens.access_token,
          login: me.login,
          refreshToken: tokens.refresh_token,
          userId: me.id,
        },
      });
      // Default broadcaster/moderator to the logged-in mod account; user can override.
      const cur = getSettings();
      saveSettings({
        ...cur,
        twitch: {
          ...cur.twitch,
          broadcasterId: cur.twitch.broadcasterId || me.id,
          moderatorId: cur.twitch.moderatorId || me.id,
        },
      });
      res.redirect("/?twitch=ok");
    } catch (err) {
      res.status(500).send(`Twitch auth failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

// --- live pipeline (imported by index via shared paused flag) ---

let paused = false;
export function isPaused(): boolean {
  return paused;
}
export function setPaused(v: boolean): void {
  paused = v;
}

/** Judge one live message against every enabled rule, enforce bindings, log + broadcast. */
export async function handleLiveMessage(
  user: string,
  text: string,
  msgId: string,
  userId: string,
): Promise<void> {
  broadcast("chat", { msgId, text, ts: new Date().toISOString(), user });
  if (paused) return;
  const settings = getSettings();
  const secrets = getSecrets();
  const apiKey = secrets.openrouter?.apiKey ?? "";
  const rules = getRules().filter((r) => r.enabled);
  if (!apiKey || rules.length === 0) return;
  const bindings = getBindings();
  const actions = getActions();
  // resolveContext throws on a hand-edited invalid config — skip judging this
  // message instead of crashing on an unhandled rejection (void-invoked caller).
  let state: unknown;
  try {
    state = resolveContext(settings.context, { message: text, username: user });
  } catch (err) {
    console.warn(
      "Skipping judgment: invalid context config:",
      err instanceof Error ? err.message : err,
    );
    return;
  }
  const results = await judgeAllRules(
    rules,
    state,
    { apiKey, batch: settings.judging?.batch !== false, model: settings.openrouter.model },
  );
  for (const r of results) {
    const resolved = r.matched
      ? resolveActions(r.ruleId, r.choice, bindings, actions)
      : [];
    let outcomes: Awaited<ReturnType<typeof executeActions>> = [];
    if (resolved.length > 0) {
      outcomes = await executeActions(resolved, {
        broadcasterId: settings.twitch.broadcasterId,
        clientId: settings.twitch.clientId,
        dryRun: settings.dryRun,
        messageId: msgId,
        moderatorId: settings.twitch.moderatorId,
        moderatorToken: secrets.twitch?.accessToken ?? "",
        userId,
      });
      for (const o of outcomes) {
        if (!o.ok)
          console.error(
            `[action] ${o.type}:${o.actionId} FAILED for ${user} (${msgId}): ${o.error ?? "unknown error"}`,
          );
      }
    }
    const entry = {
      actionsTaken: outcomes.map((o) =>
        o.ok
          ? `${o.type}:${o.actionId}${o.skipped ? ` (${o.skipped})` : ""}`
          : `${o.type}:${o.actionId} FAILED${o.error ? `: ${o.error}` : ""}`,
      ),
      choice: r.choice,
      confidence: r.confidence,
      costUsd: r.costUsd,
      dryRun: settings.dryRun,
      invalid: r.invalid,
      latencyMs: r.latencyMs,
      lowConfidence: r.lowConfidence,
      matched: r.matched,
      msgId,
      msgText: text,
      note: r.invalid
        ? "invalid choice from Jev — logged only"
        : r.lowConfidence
          ? "low confidence — logged only"
          : undefined,
      probabilities: r.probabilities,
      ruleId: r.ruleId,
      ts: new Date().toISOString(),
      user,
    };
    appendLog(entry);
    broadcast("verdict", entry);
  }
}
