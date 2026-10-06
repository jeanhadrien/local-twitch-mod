import { useState } from "react";
import { api, type ActionDef } from "../api";

export function ActionsPage() {
  const [actions, setActions] = useState<ActionDef[] | null>(null);
  const [error, setError] = useState("");

  async function load() {
    try {
      setActions(await api.getActions());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  if (actions === null) {
    void load();
    return <p>Loading…</p>;
  }

  async function save(a: ActionDef) {
    try {
      const saved = await api.saveActions(a);
      setActions((prev) => (prev ?? []).map((x) => (x.id === a.id ? saved : x)));
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
        MVP enforces <code>delete</code> via Helix. <code>timeout</code> / <code>ban</code> are
        stubbed (fields plumbed, never executed).
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
              onChange={(e) =>
                setActions(
                  actions.map((x) =>
                    x.id === a.id ? { ...x, type: e.target.value as ActionDef["type"] } : x,
                  ),
                )
              }
            >
              <option value="delete">delete (live)</option>
              <option value="timeout">timeout (stubbed)</option>
              <option value="ban">ban (stubbed)</option>
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
            {(a.type === "timeout" || a.type === "ban") && (
              <input
                type="number"
                placeholder="duration (sec)"
                value={a.params?.durationSec ?? ""}
                onChange={(e) =>
                  setActions(
                    actions.map((x) =>
                      x.id === a.id
                        ? { ...x, params: { ...x.params, durationSec: Number(e.target.value) } }
                        : x,
                    ),
                  )
                }
              />
            )}
          </div>
          <div className="row">
            <button onClick={() => void save(a)}>Save</button>
            <button onClick={() => void remove(a.id)}>Delete</button>
          </div>
        </div>
      ))}
    </div>
  );
}
