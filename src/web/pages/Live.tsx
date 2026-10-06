import { useEffect, useRef, useState } from "react";
import { api, type ChatLog, type VerdictLog } from "../api";

interface BotStatus {
  connected: boolean;
  channel: string;
  paused: boolean;
  streamId: string | null;
  latestStreamId: string | null;
}

export function LivePage() {
  const [chat, setChat] = useState<ChatLog[]>([]);
  const [verdicts, setVerdicts] = useState<VerdictLog[]>([]);
  const [status, setStatus] = useState<BotStatus>({
    connected: false,
    channel: "",
    paused: false,
    streamId: null,
    latestStreamId: null,
  });
  const [streamId, setStreamId] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  // Dedup keys survive effect re-runs (StrictMode) so seed + SSE never double-render.
  const chatKeys = useRef<Set<string>>(new Set());
  const verdictKeys = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    // Hold SSE events that land mid-seed; flush after so the 200-cap keeps the
    // newest entries instead of evicting them behind the older seeded history.
    let seeding = true;
    const pendingChat: ChatLog[] = [];
    const pendingVerdict: VerdictLog[] = [];

    const addChat = (m: ChatLog) => {
      if (!m.msgId || chatKeys.current.has(m.msgId)) return;
      chatKeys.current.add(m.msgId);
      setChat((prev) => [...prev.slice(-199), m]);
    };
    const addVerdict = (v: VerdictLog) => {
      const key = `${v.msgId}:${v.ruleId}`;
      if (verdictKeys.current.has(key)) return;
      verdictKeys.current.add(key);
      setVerdicts((prev) => [...prev.slice(-199), v]);
    };

    // Subscribe first, then seed: events that land during the fetch are buffered
    // and deduped by msgId (chat) / msgId+ruleId (verdict) on flush.
    const es = new EventSource("/api/events");
    esRef.current = es;
    es.addEventListener("chat", (e) => {
      try {
        const m = JSON.parse((e as MessageEvent).data) as ChatLog;
        if (m.streamId) setStreamId(m.streamId);
        if (seeding) pendingChat.push(m);
        else addChat(m);
      } catch {
        // ignore malformed frames
      }
    });
    es.addEventListener("verdict", (e) => {
      try {
        const v = JSON.parse((e as MessageEvent).data) as VerdictLog;
        if (v.streamId) setStreamId(v.streamId);
        if (seeding) pendingVerdict.push(v);
        else addVerdict(v);
      } catch {
        // ignore malformed frames
      }
    });

    const flush = () => {
      if (cancelled) return;
      seeding = false;
      for (const m of pendingChat) addChat(m);
      for (const v of pendingVerdict) addVerdict(v);
      pendingChat.length = 0;
      pendingVerdict.length = 0;
    };

    void (async () => {
      let sid: string | null = null;
      try {
        const s = await api.getBotStatus();
        if (cancelled) return;
        setStatus(s);
        // Live id if connected, else the newest stream recorded in the log.
        sid = s.streamId ?? s.latestStreamId;
      } catch {
        // status is best-effort
      }
      try {
        if (sid && !cancelled) {
          setStreamId(sid);
          const entries = await api.getLogs({ limit: 2000, streamId: sid });
          if (cancelled) return;
          for (const entry of entries) {
            if (entry.kind === "chat") addChat(entry);
            else addVerdict(entry);
          }
        }
      } catch {
        // seeding is best-effort
      } finally {
        flush();
      }
    })();

    return () => {
      cancelled = true;
      es.close();
    };
  }, []);

  const shown = filter
    ? verdicts.filter((v) => v.ruleId.includes(filter) || v.actionsTaken.join(" ").includes(filter))
    : verdicts;

  const streamLabel = streamId
    ? `${status.connected ? "Live stream" : "Last session"} · ${streamId}`
    : "No stream history yet";

  // Serialize Start/Stop/Pause clicks — no concurrent bot-control requests.
  const runBotOp = (op: () => Promise<void>) => async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await op();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <h2>Live</h2>
      {error && <p className="error">{error}</p>}
      <p>
        {status.connected ? `Connected to #${status.channel}` : "Not connected"} —{" "}
        {status.paused ? "bot paused" : "bot active"}
      </p>
      <p className="meta">{streamLabel}</p>
      <div className="row">
        <button
          disabled={busy}
          onClick={runBotOp(async () => {
            const r = await api.startBot();
            setStatus((s) => ({ ...s, ...r }));
          })}
        >
          Start / join
        </button>
        <button
          disabled={busy}
          onClick={runBotOp(async () => {
            await api.stopBot();
            setStatus((s) => ({ ...s, connected: false, streamId: null }));
          })}
        >
          Stop
        </button>
        <button
          disabled={busy}
          onClick={runBotOp(async () => {
            const r = await api.pauseBot(!status.paused);
            setStatus((s) => ({ ...s, paused: r.paused }));
          })}
        >
          {status.paused ? "Resume bot" : "Pause bot"}
        </button>
        <input placeholder="filter verdicts by rule/action" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <div className="cols">
        <div>
          <h3>Chat</h3>
          <ul className="feed">
            {chat.map((m, i) => (
              <li key={`${m.msgId}-${i}`}>
                <strong>{m.user}</strong>: {m.text}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3>Verdicts / moderation log</h3>
          <ul className="feed">
            {shown.map((v, i) => (
              <li key={`${v.msgId}-${v.ruleId}-${i}`} className={v.matched ? "hit" : v.lowConfidence ? "low" : ""}>
                <strong>{v.user}</strong> [{v.ruleId}] → <code>{v.choice ?? "∅"}</code>{" "}
                {v.confidence !== null && <>({v.confidence.toFixed(2)})</>}{" "}
                {v.matched ? `⚡ ${v.actionsTaken.join(", ") || "no bindings"}` : v.lowConfidence ? "… low confidence, logged only" : v.invalid ? "⚠ invalid choice, logged only" : "— no match"}{" "}
                <span className="meta">{v.latencyMs}ms{v.dryRun ? " · dry-run" : ""}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
