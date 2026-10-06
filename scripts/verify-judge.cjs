// Verifies the judge module against a mocked Decisions API (no network).
// Cases: valid matching choice, low-confidence match (log only), invalid choice.
const assert = require("node:assert/strict");

async function main() {
  const judge = require("../dist-server/judge.js");
  const rule = {
    choices: [
      { description: "Unsolicited links or promo spam.", value: "spam" },
      { description: "Ordinary chat.", value: "ok" },
    ],
    enabled: true,
    id: "rule-spam",
    instruction: "Decide whether this message is spam.",
    matchValues: ["spam"],
    minConfidence: 0.6,
    name: "Spam",
  };
  const state = { message: "FREE FOLLOWERS at scam.example", user: "someviewer" };

  const decisionsResponse = (answer) => async () => ({
    ok: true,
    json: async () => ({ answers: { "rule-spam": answer }, usage: { cost: 0.0001 } }),
  });

  // 1. valid choice, high confidence → matched
  const hit = await judge.judgeRule(rule, state, {
    apiKey: "test",
    fetchFn: decisionsResponse({ choice: "spam", confidence: 0.92, probabilities: { ok: 0.08, spam: 0.92 }, type: "choice" }),
  });
  assert.equal(hit.matched, true);
  assert.equal(hit.lowConfidence, false);
  assert.equal(hit.invalid, false);
  assert.equal(hit.choice, "spam");
  console.log("PASS valid choice → matched");

  // 2. matching choice, low confidence → log only
  const low = await judge.judgeRule(rule, state, {
    apiKey: "test",
    fetchFn: decisionsResponse({ choice: "spam", confidence: 0.3, probabilities: { ok: 0.7, spam: 0.3 }, type: "choice" }),
  });
  assert.equal(low.matched, false);
  assert.equal(low.lowConfidence, true);
  assert.equal(low.invalid, false);
  console.log("PASS low-confidence match → log only");

  // 3. invalid choice (not in rule.choices) → invalid, no action
  const bad = await judge.judgeRule(rule, state, {
    apiKey: "test",
    fetchFn: decisionsResponse({ choice: "maybe", confidence: 0.99, probabilities: { maybe: 0.99 }, type: "choice" }),
  });
  assert.equal(bad.matched, false);
  assert.equal(bad.invalid, true);
  console.log("PASS invalid choice → logged only");

  // 4. non-match choice → no action
  const ok = await judge.judgeRule(rule, state, {
    apiKey: "test",
    fetchFn: decisionsResponse({ choice: "ok", confidence: 0.95, probabilities: { ok: 0.95, spam: 0.05 }, type: "choice" }),
  });
  assert.equal(ok.matched, false);
  assert.equal(ok.invalid, false);
  console.log("PASS non-match choice → no action");

  // 5. request shape: criteria map + state + pinned model
  let seen;
  await judge.judgeRule(rule, state, {
    apiKey: "k",
    fetchFn: async (url, init) => {
      seen = { body: JSON.parse(init.body), url };
      return { json: async () => ({ answers: {}, usage: {} }), ok: true };
    },
  });
  assert.equal(seen.url, "https://openrouter.ai/api/alpha/decisions");
  assert.equal(seen.body.model, "typesafe/jev-1.13");
  assert.deepEqual(seen.body.state, { message: state.message, user: state.user });
  assert.equal(seen.body.questions["rule-spam"].type, "choice");
  assert.deepEqual(seen.body.questions["rule-spam"].criteria, {
    ok: "Ordinary chat.",
    spam: "Unsolicited links or promo spam.",
  });
  console.log("PASS request shape (Decisions API, criteria map, pinned model)");

  const rule2 = {
    ...rule,
    choices: [
      { description: "Contains a suspicious link.", value: "link" },
      { description: "Ordinary chat.", value: "ok" },
    ],
    id: "rule-links",
    instruction: "Decide whether this message contains a suspicious link.",
    matchValues: ["link"],
  };
  const twoRules = [rule, rule2];

  // 6. batch: two rules, ONE fetch call, per-rule verdicts, cost split evenly
  let batchCalls = 0;
  const batched = await judge.judgeAllRules(twoRules, state, {
    apiKey: "test",
    fetchFn: async (url, init) => {
      batchCalls++;
      const body = JSON.parse(init.body);
      assert.deepEqual(Object.keys(body.questions).sort(), ["rule-links", "rule-spam"]);
      assert.deepEqual(Object.keys(body.state).sort(), ["message", "user"]);
      return {
        json: async () => ({
          answers: {
            "rule-links": { choice: "spam", confidence: 0.9, probabilities: { spam: 0.9 }, type: "choice" },
            "rule-spam": { choice: "spam", confidence: 0.8, probabilities: { ok: 0.2, spam: 0.8 }, type: "choice" },
          },
          usage: { cost: 0.0002 },
        }),
        ok: true,
      };
    },
  });
  assert.equal(batchCalls, 1);
  assert.equal(batched.length, 2);
  assert.equal(batched[0].matched, true);
  assert.equal(batched[1].invalid, true); // "spam" not in rule-links choices
  assert.equal(batched[0].costUsd, 0.0001); // aggregate cost split evenly
  console.log("PASS batch judging (one call, per-rule verdicts, split cost)");

  // 7. batch failure → sequential fallback (4 batch attempts + 2 single calls)
  let fallbackCalls = 0;
  const fellBack = await judge.judgeAllRules(twoRules, state, {
    apiKey: "test",
    retryDelaysMs: [1, 1, 1],
    fetchFn: async (url, init) => {
      fallbackCalls++;
      const body = JSON.parse(init.body);
      if (Object.keys(body.questions).length > 1) {
        return { ok: false, status: 500, json: async () => ({}) };
      }
      const id = Object.keys(body.questions)[0];
      return {
        json: async () => ({
          answers: { [id]: { choice: "spam", confidence: 0.9, probabilities: { spam: 0.9 }, type: "choice" } },
          usage: { cost: 0.0001 },
        }),
        ok: true,
      };
    },
  });
  assert.equal(fallbackCalls, 6);
  assert.equal(fellBack.length, 2);
  assert.equal(fellBack[0].matched, true);
  console.log("PASS batch failure → sequential fallback");

  // 8. batch disabled → sequential from the start
  let seqCalls = 0;
  await judge.judgeAllRules(twoRules, state, {
    apiKey: "test",
    batch: false,
    fetchFn: async () => {
      seqCalls++;
      return { json: async () => ({ answers: {}, usage: {} }), ok: true };
    },
  });
  assert.equal(seqCalls, 2);
  console.log("PASS batch disabled → sequential calls");

  // 9. judge retry: two 500s then success → recovered on 3rd attempt
  let r9 = 0;
  const recovered = await judge.judgeRule(rule, state, {
    apiKey: "test",
    retryDelaysMs: [5, 5, 5],
    fetchFn: async () => {
      r9++;
      if (r9 < 3) return { json: async () => ({}), ok: false, status: 500 };
      return {
        json: async () => ({
          answers: { "rule-spam": { choice: "spam", confidence: 0.9, probabilities: { spam: 0.9 }, type: "choice" } },
          usage: { cost: 0.0001 },
        }),
        ok: true,
      };
    },
  });
  assert.equal(r9, 3);
  assert.equal(recovered.matched, true);
  console.log("PASS judge retry recovers after 500s");

  // 10. judge: 400 fails fast with a single attempt
  let r10 = 0;
  const badRequest = await judge.judgeRule(rule, state, {
    apiKey: "test",
    retryDelaysMs: [5, 5, 5],
    fetchFn: async () => {
      r10++;
      return { json: async () => ({}), ok: false, status: 400 };
    },
  });
  assert.equal(r10, 1);
  assert.equal(badRequest.invalid, true);
  console.log("PASS judge 400 fails fast (no retry)");

  // 11. judge: persistent 500 exhausts all 4 attempts → invalid
  let r11 = 0;
  const dead = await judge.judgeRule(rule, state, {
    apiKey: "test",
    retryDelaysMs: [5, 5, 5],
    fetchFn: async () => {
      r11++;
      return { json: async () => ({}), ok: false, status: 500 };
    },
  });
  assert.equal(r11, 4);
  assert.equal(dead.invalid, true);
  console.log("PASS judge retries exhausted → invalid");

  // 12-13. Helix delete retry via stubbed global fetch.
  const actions = require("../dist-server/actions.js");
  const deleteAction = [{ enabled: true, id: "act-delete", name: "Delete", type: "delete" }];
  const ctx = { broadcasterId: "b", clientId: "c", dryRun: false, messageId: "m", moderatorId: "mod", moderatorToken: "t" };
  const realFetch = global.fetch;
  try {
    // 12. one 429 then success → ok
    let d12 = 0;
    global.fetch = async () => {
      d12++;
      return d12 === 1 ? { ok: false, status: 429 } : { ok: true, status: 204 };
    };
    const out12 = await actions.executeActions(deleteAction, ctx, { retryDelaysMs: [5, 5, 5] });
    assert.equal(d12, 2);
    assert.equal(out12[0].ok, true);
    console.log("PASS Helix delete retry recovers after 429");

    // 13. persistent 500 → 4 attempts, FAILED outcome
    let d13 = 0;
    global.fetch = async () => {
      d13++;
      return { ok: false, status: 500, text: async () => "boom" };
    };
    const out13 = await actions.executeActions(deleteAction, ctx, { retryDelaysMs: [5, 5, 5] });
    assert.equal(d13, 4);
    assert.equal(out13[0].ok, false);
    console.log("PASS Helix delete retries exhausted → FAILED outcome");
  } finally {
    global.fetch = realFetch;
  }

  console.log("All judge checks passed.");
}

main().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
