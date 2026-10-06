import { useEffect, useState } from "react";
import { api, type ActionDef } from "../api";

export function ActionsPage() {
  const [actions, setActions] = useState<ActionDef[] | null>(null);
  const [error, setError] = useState("");
  const [saveError, setSaveError] = useState<Record<string, string>>({});

  async function load() {
    try {
      setActions(await api.getActions());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  useEffect(() => {
    void load();
  }, []);
  if (actions === null) {
    return <p>Loading…</p>;
  }

  async function save(a: ActionDef) {
    const reason = a.params?.reason ?? "";
    if (a.type === "warn" && (reason.trim().length === 0 || reason.length > 500)) {
      setSaveError((prev) => ({ ...prev, [a.id]: "Warn reason is required (1–500 characters)." }));
      return;
    }
    try {
      const saved = await api.saveActions(a);
      setActions((prev) => (prev ?? []).map((x) => (x.id === a.id ? saved : x)));
      setSaveError((prev) => {
        const next = { ...prev };
        delete next[a.id];
        return next;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  async function remove(id: string) {
    try {
      await api.deleteAction(id);
      setActions((prev) => (prev ?? []).filter((x) => x.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div>
      <h2>Actions</h2>
      {error && <p className="error">{error}</p>}
      <p>
        All four action types execute via Helix. <code>warn</code> needs the{" "}
        <code>moderator:manage:warnings</code> scope — re-login from Setup to grant it.
      </p>
      <button
        onClick={() =>
          setActions([
            ...(actions ?? []),
            {
              enabled: true,
              id: `new-${Date.now()}`,
              name: "New action",
              params: { reason: "" },
              type: "delete",
            },
          ])
        }
      >
        + New action
      </button>
      {actions.map((a) => (
        <div className="card" key={a.id}>
          <input value={a.name} onChange={(e) => setActions(actions.map((x) => (x.id === a.id ? { ...x, name: e.target.value } : x)))} />
          <div className="row">
            <select
              value={a.type}
              onChange={(e) => {
                setSaveError((prev) => {
                  const next = { ...prev };
                  delete next[a.id];
                  return next;
                });
                setActions(
                  actions.map((x) =>
                    x.id === a.id ? { ...x, type: e.target.value as ActionDef["type"] } : x,
                  ),
                );
              }}
            >
              <option value="delete">delete</option>
              <option value="timeout">timeout</option>
              <option value="ban">ban</option>
              <option value="warn">warn</option>
            </select>
            <label className="row">
              <input
                type="checkbox"
                checked={a.enabled}
                onChange={(e) =>
                  setActions(actions.map((x) => (x.id === a.id ? { ...x, enabled: e.target.checked } : x)))
                }
              />
              enabled
            </label>
          </div>
          {a.type !== "delete" && (
            <div className="row">
              <input
                placeholder="reason"
                value={a.params?.reason ?? ""}
                onChange={(e) =>
                  setActions(
                    actions.map((x) =>
                      x.id === a.id ? { ...x, params: { ...x.params, reason: e.target.value } } : x,
                    ),
                  )
                }
              />
              {a.type === "timeout" && (
                <input
                  type="number"
                  placeholder="duration (sec, default 600)"
                  value={a.params?.durationSec ?? ""}
                  onChange={(e) =>
                    setActions(
                      actions.map((x) =>
                        x.id === a.id
                          ? {
                              ...x,
                              params: {
                                ...x.params,
                                durationSec:
                                  e.target.value === "" ? undefined : Number(e.target.value),
                              },
                            }
                          : x,
                      ),
                    )
                  }
                />
              )}
            </div>
          )}
          {saveError[a.id] && <p className="error">{saveError[a.id]}</p>}
          <div className="row">
            <button onClick={() => void save(a)}>Save</button>
            <button onClick={() => void remove(a.id)}>Delete</button>
          </div>
        </div>
      ))}
    </div>
  );
}
