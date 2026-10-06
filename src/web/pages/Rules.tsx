import { useEffect, useState } from "react";
import { api, type ActionDef, type Binding, type Rule, type TestVerdict } from "../api";

export function RulesPage() {
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [actions, setActions] = useState<ActionDef[]>([]);
  const [bindings, setBindings] = useState<Binding[]>([]);
  const [error, setError] = useState("");
  const [testUser, setTestUser] = useState("someviewer");
  const [testMsg, setTestMsg] = useState("FREE FOLLOWERS at scam.example!!!");
  const [testRuleId, setTestRuleId] = useState("");
  const [verdicts, setVerdicts] = useState<TestVerdict[] | null>(null);
  const [testing, setTesting] = useState(false);

  async function load() {
    try {
      const [r, a, b] = await Promise.all([api.getRules(), api.getActions(), api.getBindings()]);
      setRules(r);
      setActions(a);
      setBindings(b);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  useEffect(() => {
    void load();
  }, []);
  if (rules === null) {
    return <p>Loading…</p>;
  }

  function boundActionIds(ruleId: string, choiceValue: string): string[] {
    return bindings.find((b) => b.ruleId === ruleId && b.choiceValue === choiceValue)?.actionIds ?? [];
  }

  async function persistBindings(next: Binding[]) {
    setBindings(next);
    try {
      await api.saveBindings(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function toggleBinding(ruleId: string, choiceValue: string, actionId: string) {
    const next = [...bindings];
    const i = next.findIndex((b) => b.ruleId === ruleId && b.choiceValue === choiceValue);
    if (i === -1) {
      next.push({ actionIds: [actionId], choiceValue, ruleId });
    } else {
      const ids = next[i].actionIds.includes(actionId)
        ? next[i].actionIds.filter((id) => id !== actionId)
        : [...next[i].actionIds, actionId];
      next[i] = { ...next[i], actionIds: ids };
    }
    void persistBindings(next);
  }

  async function save(r: Rule) {
    try {
      const saved = await api.saveRule(r);
      setRules((prev) => (prev ?? []).map((x) => (x.id === r.id ? saved : x)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function runTest() {
    setTesting(true);
    setError("");
    try {
      setVerdicts(await api.test({ message: testMsg, ruleId: testRuleId || undefined, user: testUser }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(false);
    }
  }

  return (
    <div>
      <h2>Rules</h2>
      {error && <p className="error">{error}</p>}
      <button
        onClick={() =>
          setRules([
            ...(rules ?? []),
            {
              choices: [
                { description: "Describe what this choice means for the judge.", value: "yes" },
                { description: "Describe what this choice means for the judge.", value: "no" },
              ],
              enabled: true,
              id: `new-${Date.now()}`,
              instruction: "Decide whether…",
              matchValues: ["yes"],
              minConfidence: 0.6,
              name: "New rule",
            },
          ])
        }
      >
        + New rule
      </button>
      {rules.map((r) => (
        <div className="card" key={r.id}>
          <div className="row">
            <input
              value={r.name}
              onChange={(e) => setRules(rules.map((x) => (x.id === r.id ? { ...x, name: e.target.value } : x)))}
            />
            <label className="row">
              <input
                type="checkbox"
                checked={r.enabled}
                onChange={(e) => setRules(rules.map((x) => (x.id === r.id ? { ...x, enabled: e.target.checked } : x)))}
              />
              enabled
            </label>
          </div>
          <label>
            Instruction (Jev question)
            <textarea
              rows={2}
              value={r.instruction}
              onChange={(e) => setRules(rules.map((x) => (x.id === r.id ? { ...x, instruction: e.target.value } : x)))}
            />
          </label>
          <label>
            Choices (each needs a criteria description — Jev reads these)
            {r.choices.map((c, ci) => (
              <div className="row" key={ci}>
                <input
                  style={{ maxWidth: 140 }}
                  value={c.value}
                  onChange={(e) =>
                    setRules(
                      rules.map((x) =>
                        x.id === r.id
                          ? { ...x, choices: x.choices.map((cc, j) => (j === ci ? { ...cc, value: e.target.value } : cc)) }
                          : x,
                      ),
                    )
                  }
                />
                <input
                  value={c.description}
                  placeholder="criteria description"
                  onChange={(e) =>
                    setRules(
                      rules.map((x) =>
                        x.id === r.id
                          ? {
                              ...x,
                              choices: x.choices.map((cc, j) =>
                                j === ci ? { ...cc, description: e.target.value } : cc,
                              ),
                            }
                          : x,
                      ),
                    )
                  }
                />
                <label className="row" title="Trigger actions on this choice">
                  <input
                    type="checkbox"
                    checked={r.matchValues.includes(c.value)}
                    onChange={(e) =>
                      setRules(
                        rules.map((x) =>
                          x.id === r.id
                            ? {
                                ...x,
                                matchValues: e.target.checked
                                  ? [...x.matchValues, c.value]
                                  : x.matchValues.filter((v) => v !== c.value),
                              }
                            : x,
                        ),
                      )
                    }
                  />
                  match
                </label>
                <button
                  onClick={() =>
                    setRules(rules.map((x) => (x.id === r.id ? { ...x, choices: x.choices.filter((_, j) => j !== ci) } : x)))
                  }
                >
                  ✕
                </button>
              </div>
            ))}
            <button
              onClick={() =>
                setRules(
                  rules.map((x) =>
                    x.id === r.id
                      ? { ...x, choices: [...x.choices, { description: "", value: `choice${x.choices.length + 1}` }] }
                      : x,
                  ),
                )
              }
            >
              + choice
            </button>
          </label>
          <label>
            Min confidence (match requires choice ∈ matchValues AND confidence ≥ this)
            <input
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={r.minConfidence}
              onChange={(e) =>
                setRules(rules.map((x) => (x.id === r.id ? { ...x, minConfidence: Number(e.target.value) } : x)))
              }
            />
          </label>
          <div>
            <strong>On match → actions</strong> (per choice value):
            {r.choices.map((c) => (
              <div className="row" key={c.value}>
                <code>{c.value || "(empty)"}</code>
                {actions.map((a) => (
                  <label className="row" key={a.id}>
                    <input
                      type="checkbox"
                      checked={boundActionIds(r.id, c.value).includes(a.id)}
                      onChange={() => toggleBinding(r.id, c.value, a.id)}
                    />
                    {a.name} ({a.type})
                  </label>
                ))}
              </div>
            ))}
          </div>
          <div className="row">
            <button onClick={() => void save(r)}>Save</button>
            <button
              onClick={() =>
                api.deleteRule(r.id).then(() => setRules(rules.filter((x) => x.id !== r.id))).catch((e) => setError(String(e)))
              }
            >
              Delete
            </button>
          </div>
        </div>
      ))}

      <h2>Test playground</h2>
      <p>Runs Jev judgment only — no actions are executed.</p>
      <div className="row">
        <input value={testUser} onChange={(e) => setTestUser(e.target.value)} placeholder="user" />
        <select value={testRuleId} onChange={(e) => setTestRuleId(e.target.value)}>
          <option value="">all enabled rules</option>
          {rules.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </div>
      <textarea rows={2} value={testMsg} onChange={(e) => setTestMsg(e.target.value)} />
      <button onClick={() => void runTest()} disabled={testing}>
        {testing ? "Judging…" : "Run judgment"}
      </button>
      {verdicts && (
        <pre className="verdict">{JSON.stringify(verdicts, null, 2)}</pre>
      )}
    </div>
  );
}
