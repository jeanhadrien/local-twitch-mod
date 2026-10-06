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

  console.log("All judge checks passed.");
}

main().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
