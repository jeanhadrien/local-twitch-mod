// Verifies the judge module against a mocked Decisions API (no network).
// Cases: valid matching choice, low-confidence match (log only), invalid choice,
// plus log-store parsing/filtering (mixed kinds, legacy tolerance, backward scan).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Isolate persistence checks from the real ./data dir. Must be set before
// dist-server/store.js first loads (it snapshots DATA_DIR at module load).
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "klawz-verify-"));

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

  // 12b-12g. Helix timeout / ban / warn via the same stubbed global fetch.
  const userCtx = { ...ctx, userId: "42" };
  const banAction = [{ enabled: true, id: "act-ban", name: "Ban", params: { reason: "bye" }, type: "ban" }];
  const timeoutAction = [{ enabled: true, id: "act-timeout", name: "Timeout", params: {}, type: "timeout" }];
  const warnAction = [{ enabled: true, id: "act-warn", name: "Warn", params: { reason: "be nice" }, type: "warn" }];
  const realFetch2 = global.fetch;
  try {
    // 12b. ban: POST /moderation/bans, body carries NO duration
    let banSeen;
    global.fetch = async (url, init) => {
      banSeen = { body: JSON.parse(init.body), init, url };
      return { ok: true, status: 200 };
    };
    const banOut = await actions.executeActions(banAction, userCtx, { retryDelaysMs: [5, 5, 5] });
    assert.equal(banOut[0].ok, true);
    assert.equal(
      banSeen.url,
      "https://api.twitch.tv/helix/moderation/bans?broadcaster_id=b&moderator_id=mod",
    );
    assert.equal(banSeen.init.method, "POST");
    assert.equal(banSeen.init.headers["Content-Type"], "application/json");
    assert.equal(banSeen.body.data.user_id, "42");
    assert.equal(banSeen.body.data.duration, undefined);
    console.log("PASS Helix ban POST (no duration)");

    // 12c. timeout: unset duration defaults to 600
    let timeoutSeen;
    global.fetch = async (url, init) => {
      timeoutSeen = { body: JSON.parse(init.body), url };
      return { ok: true, status: 200 };
    };
    const timeoutOut = await actions.executeActions(timeoutAction, userCtx, { retryDelaysMs: [5, 5, 5] });
    assert.equal(timeoutOut[0].ok, true);
    assert.equal(timeoutSeen.body.data.duration, 600);
    console.log("PASS Helix timeout POST (duration defaults to 600)");

    // 12d. warn: dedicated URL + body shape
    let warnSeen;
    global.fetch = async (url, init) => {
      warnSeen = { body: JSON.parse(init.body), url };
      return { ok: true, status: 200 };
    };
    const warnOut = await actions.executeActions(warnAction, userCtx, { retryDelaysMs: [5, 5, 5] });
    assert.equal(warnOut[0].ok, true);
    assert.equal(
      warnSeen.url,
      "https://api.twitch.tv/helix/moderation/warnings?broadcaster_id=b&moderator_id=mod",
    );
    assert.deepEqual(warnSeen.body, { data: { reason: "be nice", user_id: "42" } });
    console.log("PASS Helix warn POST (URL + body shape)");

    // 12e. one 429 then success → ok
    let r12e = 0;
    global.fetch = async () => {
      r12e++;
      return r12e === 1 ? { ok: false, status: 429 } : { ok: true, status: 200 };
    };
    const retried = await actions.executeActions(banAction, userCtx, { retryDelaysMs: [5, 5, 5] });
    assert.equal(r12e, 2);
    assert.equal(retried[0].ok, true);
    console.log("PASS Helix ban retry recovers after 429");

    // 12f. 400 fails fast → single attempt, FAILED outcome
    let r12f = 0;
    global.fetch = async () => {
      r12f++;
      return { ok: false, status: 400, text: async () => "bad request" };
    };
    const failed = await actions.executeActions(banAction, userCtx, { retryDelaysMs: [5, 5, 5] });
    assert.equal(r12f, 1);
    assert.equal(failed[0].ok, false);
    console.log("PASS Helix ban 400 fails fast → FAILED outcome");

    // 12g. empty userId → no Helix call, FAILED outcomes for user-targeted actions
    let r12g = 0;
    global.fetch = async () => {
      r12g++;
      return { ok: true, status: 200 };
    };
    const noUser = await actions.executeActions(
      [...timeoutAction, ...banAction, ...warnAction],
      { ...ctx, userId: "" },
      { retryDelaysMs: [5, 5, 5] },
    );
    assert.equal(r12g, 0);
    assert.equal(noUser.length, 3);
    assert.equal(noUser.every((o) => o.ok === false), true);
    console.log("PASS Helix user-targeted actions skip when userId missing");
  } finally {
    global.fetch = realFetch2;
  }

  // 13b. expired access token: Helix 401 → refresh once → retry; ctx + secrets updated.
  {
    const st = require("../dist-server/store.js");
    st.saveSettings({
      ...st.getSettings(),
      twitch: { ...st.getSettings().twitch, clientId: "cid" },
    });
    st.saveSecrets({
      twitch: {
        accessToken: "old",
        clientSecret: "sec",
        login: "u",
        refreshToken: "rt1",
        userId: "1",
      },
    });
    const realFetch3 = global.fetch;
    let refreshCalls = 0;
    let helixCalls = 0;
    try {
      global.fetch = async (url, init) => {
        if (String(url).includes("id.twitch.tv/oauth2/token")) {
          refreshCalls++;
          return {
            json: async () => ({ access_token: "fresh", expires_in: 14000, refresh_token: "rt2" }),
            ok: true,
            status: 200,
          };
        }
        helixCalls++;
        const auth = init && init.headers && init.headers.Authorization;
        if (auth === "Bearer old")
          return { ok: false, status: 401, text: async () => "unauthorized" };
        return { ok: true, status: 204 };
      };
      const ctxExp = { ...ctx, moderatorToken: "old" };
      const outExp = await actions.executeActions(deleteAction, ctxExp, { retryDelaysMs: [5, 5, 5] });
      assert.equal(refreshCalls, 1);
      assert.equal(helixCalls, 2); // old token (401) then refreshed token (204)
      assert.equal(outExp[0].ok, true);
      assert.equal(ctxExp.moderatorToken, "fresh"); // cached for the rest of the batch
      assert.equal(st.getSecrets().twitch.refreshToken, "rt2"); // rotated token persisted
      console.log("PASS Helix 401 → token refresh + retry (rotated token persisted)");
    } finally {
      global.fetch = realFetch3;
    }
  }

  // 14-18. noul rules: request shape, threshold match/no-match, invalid answer.
  const noulRule = {
    choices: [],
    criteria: { false: "Ordinary chat.", true: "Unsolicited links or promo spam." },
    enabled: true,
    id: "rule-noul",
    instruction: "Is this message spam?",
    matchValues: [],
    minConfidence: 0.6,
    name: "Spam (noul)",
    type: "noul",
  };
  const noulAnswer = (answer) => async () => ({
    json: async () => ({ answers: { "rule-noul": answer }, usage: { cost: 0.0001 } }),
    ok: true,
  });

  // 14. request shape: type "noul" + criteria map
  let noulSeen;
  await judge.judgeRule(noulRule, state, {
    apiKey: "k",
    fetchFn: async (url, init) => {
      noulSeen = { body: JSON.parse(init.body), url };
      return { json: async () => ({ answers: {}, usage: {} }), ok: true };
    },
  });
  assert.equal(noulSeen.body.questions["rule-noul"].type, "noul");
  assert.deepEqual(noulSeen.body.questions["rule-noul"].criteria, {
    false: "Ordinary chat.",
    true: "Unsolicited links or promo spam.",
  });
  console.log("PASS noul request shape (type noul + criteria map)");

  // 15. request shape: empty criteria omitted
  let noCriteriaSeen;
  await judge.judgeRule({ ...noulRule, criteria: {} }, state, {
    apiKey: "k",
    fetchFn: async (url, init) => {
      noCriteriaSeen = JSON.parse(init.body);
      return { json: async () => ({ answers: {}, usage: {} }), ok: true };
    },
  });
  assert.equal(noCriteriaSeen.questions["rule-noul"].type, "noul");
  assert.equal(noCriteriaSeen.questions["rule-noul"].criteria, undefined);
  console.log("PASS noul empty criteria omitted");

  // 16. noul >= threshold → matched, choice "true"
  const noulHit = await judge.judgeRule(noulRule, state, {
    apiKey: "test",
    fetchFn: noulAnswer({ noul: 0.91, type: "noul" }),
  });
  assert.equal(noulHit.matched, true);
  assert.equal(noulHit.invalid, false);
  assert.equal(noulHit.choice, "true");
  assert.equal(noulHit.confidence, 0.91);
  assert.equal(noulHit.probabilities, null);
  console.log("PASS noul ≥ threshold → matched (choice true)");

  // 17. noul < threshold → no match, choice "false"
  const noulMiss = await judge.judgeRule(noulRule, state, {
    apiKey: "test",
    fetchFn: noulAnswer({ noul: 0.2, type: "noul" }),
  });
  assert.equal(noulMiss.matched, false);
  assert.equal(noulMiss.invalid, false);
  assert.equal(noulMiss.choice, "false");
  assert.equal(noulMiss.confidence, 0.2);
  console.log("PASS noul < threshold → no match (choice false)");

  // 18. noul missing/non-finite → invalid
  const noulBad = await judge.judgeRule(noulRule, state, {
    apiKey: "test",
    fetchFn: noulAnswer({ type: "noul" }),
  });
  assert.equal(noulBad.matched, false);
  assert.equal(noulBad.invalid, true);
  assert.equal(noulBad.choice, null);
  assert.equal(noulBad.confidence, null);
  console.log("PASS noul missing value → invalid");

  // 19+. log store: discriminated union, legacy tolerance, filters, backward scan.
  const store = require("../dist-server/store.js");
  const logsPath = path.join(store.DATA_DIR, "logs.jsonl");
  const writeLines = (entries) =>
    fs.writeFileSync(logsPath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");

  // 19. mixed chat/verdict lines parse into their kinds, oldest first.
  writeLines([
    { kind: "chat", msgId: "m1", streamId: "s1", text: "hi", ts: "t1", user: "a" },
    { kind: "verdict", msgId: "m1", ruleId: "r1", streamId: "s1", ts: "t2", user: "a" },
  ]);
  const mixed = store.readLogs({});
  assert.equal(mixed.length, 2);
  assert.equal(mixed[0].kind, "chat");
  assert.equal(mixed[1].kind, "verdict");
  console.log("PASS logs: mixed-kind parse");

  // 20. legacy lines (no kind) parse as verdicts; malformed lines are skipped.
  writeLines([
    { ts: "t1", user: "a", msgId: "m1", msgText: "hi", ruleId: "r1", choice: "ok" },
    { kind: "chat", msgId: "m2", streamId: "s1", text: "yo", ts: "t2", user: "b" },
  ]);
  fs.appendFileSync(logsPath, "not json\n");
  const legacy = store.readLogs({});
  assert.equal(legacy.length, 2);
  assert.equal(legacy[0].kind, "verdict");
  assert.equal(legacy[0].streamId, "");
  assert.equal(legacy[1].kind, "chat");
  console.log("PASS logs: legacy + malformed line tolerance");

  // 21. streamId and kind filters.
  writeLines([
    { kind: "chat", msgId: "a1", streamId: "s1", text: "x", ts: "1", user: "u" },
    { kind: "chat", msgId: "b1", streamId: "s2", text: "y", ts: "2", user: "u" },
    { kind: "verdict", msgId: "a1", ruleId: "r", streamId: "s1", ts: "3", user: "u" },
    { kind: "verdict", msgId: "b1", ruleId: "r", streamId: "s2", ts: "4", user: "u" },
  ]);
  const onlyS2 = store.readLogs({ streamId: "s2" });
  assert.equal(onlyS2.length, 2);
  assert.equal(onlyS2.every((e) => e.streamId === "s2"), true);
  const onlyChats = store.readLogs({ kind: "chat" });
  assert.equal(onlyChats.length, 2);
  assert.equal(onlyChats.every((e) => e.kind === "chat"), true);
  console.log("PASS logs: streamId + kind filters");

  // 22. backward scan fills to `limit` (a naive tail-then-filter returns fewer).
  const many = [];
  for (let i = 0; i < 300; i++)
    many.push({ kind: "chat", msgId: `a${i}`, streamId: "old", text: "x", ts: String(i), user: "u" });
  for (let i = 0; i < 100; i++)
    many.push({ kind: "chat", msgId: `b${i}`, streamId: "new", text: "y", ts: `n${i}`, user: "u" });
  writeLines(many);
  const filled = store.readLogs({ limit: 200, streamId: "old" });
  assert.equal(filled.length, 200);
  assert.equal(filled[0].msgId, "a100");
  assert.equal(filled[199].msgId, "a299");
  console.log("PASS logs: backward scan fills to limit");

  // 23. latestStreamId returns the most recent entry's id, skipping legacy lines.
  writeLines([
    { kind: "chat", msgId: "z1", streamId: "s-old", text: "x", ts: "1", user: "u" },
    { ts: "2", user: "u", msgId: "z2", msgText: "y", ruleId: "r", choice: "ok" },
    { kind: "chat", msgId: "z3", streamId: "s-new", text: "z", ts: "3", user: "u" },
  ]);
  assert.equal(store.latestStreamId(), "s-new");
  console.log("PASS logs: latestStreamId scans tail");

  console.log("All judge checks passed.");
}

main().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
