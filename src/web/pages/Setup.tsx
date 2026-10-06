import { useState } from "react";
import { api } from "../api";

export function SetupPage() {
  const [settings, setSettings] = useState<unknown>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [form, setForm] = useState({
    apiKey: "",
    broadcasterId: "",
    channel: "",
    clientId: "",
    clientSecret: "",
    dryRun: true,
    model: "typesafe/jev-1.13",
    moderatorId: "",
  });

  async function load() {
    setError("");
    try {
      const s = await api.getSettings();
      setSettings(s);
      setForm((f) => ({
        ...f,
        broadcasterId: s.twitch.broadcasterId,
        channel: s.channel,
        clientId: s.twitch.clientId,
        dryRun: s.dryRun,
        model: s.openrouter.model,
        moderatorId: s.twitch.moderatorId,
      }));
      setLoaded(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  if (!loaded) {
    void load();
    return <p>Loading…</p>;
  }

  async function save() {
    setError("");
    setSaved("");
    try {
      const s = await api.saveSettings({
        channel: form.channel,
        dryRun: form.dryRun,
        openrouter: { model: form.model },
        secrets: {
          openrouter: form.apiKey ? { apiKey: form.apiKey } : {},
          twitch: form.clientSecret ? { clientSecret: form.clientSecret } : {},
        },
        twitch: {
          broadcasterId: form.broadcasterId,
          clientId: form.clientId,
          moderatorId: form.moderatorId,
        },
      });
      setSettings(s);
      setForm((f) => ({ ...f, apiKey: "", clientSecret: "" }));
      setSaved("Saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const s = settings as unknown as {
    twitchLoggedIn: boolean;
    twitchLogin: string | null;
  };

  return (
    <div>
      <h2>Setup</h2>
      {error && <p className="error">{error}</p>}
      {saved && <p className="ok">{saved}</p>}
      <label>
        Twitch channel (without #)
        <input value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value })} placeholder="somechannel" />
      </label>
      <label>
        Twitch Client ID
        <input value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })} />
      </label>
      <label>
        Twitch Client Secret (stored locally only)
        <input type="password" value={form.clientSecret} onChange={(e) => setForm({ ...form, clientSecret: e.target.value })} placeholder="(unchanged)" />
      </label>
      <label>
        Broadcaster ID (defaults to your login after OAuth)
        <input value={form.broadcasterId} onChange={(e) => setForm({ ...form, broadcasterId: e.target.value })} />
      </label>
      <label>
        Moderator ID (defaults to your login after OAuth)
        <input value={form.moderatorId} onChange={(e) => setForm({ ...form, moderatorId: e.target.value })} />
      </label>
      <label>
        OpenRouter API key (stored locally only)
        <input type="password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} placeholder="(unchanged)" />
      </label>
      <label>
        Jev model
        <select value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })}>
          <option value="typesafe/jev-1.13">typesafe/jev-1.13 (pinned)</option>
          <option value="typesafe/jev-latest">typesafe/jev-latest (auto-upgrade)</option>
        </select>
      </label>
      <label className="row">
        <input type="checkbox" checked={form.dryRun} onChange={(e) => setForm({ ...form, dryRun: e.target.checked })} />
        Dry-run mode (judge + log, never delete)
      </label>
      <div className="row">
        <button onClick={() => void save()}>Save</button>
        <button onClick={() => (window.location.href = "/auth/login")}>Twitch login</button>
      </div>
      <p>
        Twitch status: {s.twitchLoggedIn ? `logged in as ${s.twitchLogin}` : "not logged in"}.
        The login account must be a moderator of the channel for deletes to work.
      </p>
    </div>
  );
}
