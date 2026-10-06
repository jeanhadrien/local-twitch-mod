import { useEffect, useState } from "react";
import { api, type ContextConfig, type ContextField } from "../api";

const TOKENS = ["message", "username"] as const;
const TOKEN_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;
const SAMPLE_VARS = { message: "FREE FOLLOWERS at scam.example", username: "someviewer" };

/** Client-side mirror of server/context.ts: unknown tokens, empty/duplicate JSON keys. */
function validate(cfg: ContextConfig): string[] {
  const known: readonly string[] = TOKENS;
  const errors: string[] = [];
  const scan = (s: string) => {
    for (const m of s.matchAll(TOKEN_RE)) {
      const name = m[1];
      if (!known.includes(name))
        errors.push(`Unknown token {{${name}}} (allowed: {{message}}, {{username}})`);
    }
  };
  if (cfg.mode === "text") {
    scan(cfg.text);
  } else {
    const seen = new Set<string>();
    cfg.fields.forEach((f, i) => {
      if (!f.key.trim()) errors.push(`Field ${i + 1}: key must not be empty`);
      else if (seen.has(f.key)) errors.push(`Duplicate key "${f.key}"`);
      else seen.add(f.key);
      scan(f.value);
    });
  }
  return errors;
}

export function ContextPage() {
  const [cfg, setCfg] = useState<ContextConfig | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");

  useEffect(() => {
    api
      .getSettings()
      .then((s) => setCfg(s.context))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  // Re-validate and refresh the sample preview whenever the config changes.
  useEffect(() => {
    if (!cfg) return;
    const found = validate(cfg);
    setErrors(found);
    setPreviewError("");
    if (found.length > 0) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .previewContext(cfg, SAMPLE_VARS)
        .then((r) => {
          if (!cancelled) setPreview(JSON.stringify(r.state, null, 2));
        })
        .catch((e) => {
          if (!cancelled) setPreviewError(e instanceof Error ? e.message : String(e));
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [cfg]);

  if (cfg === null) {
    return <p>Loading…</p>;
  }

  function patch(p: Partial<ContextConfig>) {
    setCfg((c) => (c ? { ...c, ...p } : c));
  }
  function updateField(i: number, p: Partial<ContextField>) {
    setCfg((c) =>
      c ? { ...c, fields: c.fields.map((f, j) => (j === i ? { ...f, ...p } : f)) } : c,
    );
  }

  async function save() {
    setError("");
    setSaved("");
    if (errors.length > 0) return;
    try {
      await api.saveSettings({ context: cfg });
      setSaved("Saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div>
      <h2>Context</h2>
      {error && <p className="error">{error}</p>}
      {saved && <p className="ok">{saved}</p>}
      <p>
        This is the Jev <code>state</code> sent with every judgment. Embed{" "}
        <code>{"{{message}}"}</code> (incoming chat text) and <code>{"{{username}}"}</code>{" "}
        (author) — the backend substitutes them per message.
      </p>
      <div className="row">
        <button aria-pressed={cfg.mode === "json"} onClick={() => patch({ mode: "json" })}>
          JSON object
        </button>
        <button aria-pressed={cfg.mode === "text"} onClick={() => patch({ mode: "text" })}>
          String
        </button>
      </div>
      {cfg.mode === "json" ? (
        <div>
          <p className="meta">Each row becomes a top-level key of the state object.</p>
          {cfg.fields.map((f, i) => (
            <div className="row" key={i}>
              <input
                style={{ maxWidth: 180 }}
                value={f.key}
                placeholder="key"
                onChange={(e) => updateField(i, { key: e.target.value })}
              />
              <input
                value={f.value}
                placeholder="value (may contain {{message}} / {{username}})"
                onChange={(e) => updateField(i, { value: e.target.value })}
              />
              <button
                onClick={() => patch({ fields: cfg.fields.filter((_, j) => j !== i) })}
              >
                ✕
              </button>
            </div>
          ))}
          <button onClick={() => patch({ fields: [...cfg.fields, { key: "", value: "" }] })}>
            + field
          </button>
        </div>
      ) : (
        <label>
          String state
          <textarea
            rows={3}
            value={cfg.text}
            placeholder="{{username}}: {{message}}"
            onChange={(e) => patch({ text: e.target.value })}
          />
        </label>
      )}

      <h3>Token reference</h3>
      <ul>
        <li>
          <code>{"{{message}}"}</code> — the incoming chat message text
        </li>
        <li>
          <code>{"{{username}}"}</code> — the chat author's login
        </li>
      </ul>

      {errors.length > 0 && (
        <div>
          <p className="error">Fix these before saving:</p>
          <ul className="error">
            {errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      <h3>Preview</h3>
      <p className="meta">
        Resolved with sample username "{SAMPLE_VARS.username}" and message "{SAMPLE_VARS.message}".
      </p>
      {previewError && <p className="error">{previewError}</p>}
      {preview !== null && <pre className="verdict">{preview}</pre>}

      <div className="row">
        <button onClick={() => void save()} disabled={errors.length > 0}>
          Save
        </button>
      </div>
    </div>
  );
}
