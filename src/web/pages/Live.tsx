import { useEffect, useRef, useState } from "react";
import { api } from "../api";

interface ChatEvent {
  msgId: string;
  text: string;
  ts: string;
  user: string;
}
interface VerdictEvent {
  ruleId: string;
  user: string;
  msgText: string;
  choice: string | null;
  confidence: number | null;
  matched: boolean;
  lowConfidence: boolean;
  invalid: boolean;
  actionsTaken: string[];
  dryRun: boolean;
  latencyMs: number;
  costUsd: number | null;
  ts: string;
}

export function LivePage() {
  const [chat, setChat] = useState<ChatEvent[]>([]);
  const [verdicts, setVerdicts] = useState<VerdictEvent[]>([]);
  const [status, setStatus] = useState({ connected: false, channel: "", paused: false });
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    void api.getBotStatus().then(setStatus).catch(() => undefined);
    const es = new EventSource("/api/events");
    esRef.current = es;
    es.addEventListener("chat", (e) => {
      try {
        const m = JSON.parse((e as MessageEvent).data) as ChatEvent;
        setChat((prev) => [...prev.slice(-199), m]);
      } catch {
        // ignore malformed frames
      }
    });
    es.addEventListener("verdict", (e) => {
      try {
        const v = JSON.parse((e as MessageEvent).data) as VerdictEvent;
        setVerdicts((prev) => [...prev.slice(-199), v]);
      } catch {
        // ignore malformed frames
      }
    });
    return () => es.close();
  }, []);

  const shown = filter
    ? verdicts.filter((v) => v.ruleId.includes(filter) || v.actionsTaken.join(" ").includes(filter))
    : verdicts;

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
            setStatus((s) => ({ ...s, connected: false }));
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
              <li key={i} className={v.matched ? "hit" : v.lowConfidence ? "low" : ""}>
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
