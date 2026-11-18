// End-to-end API test: real Worker router + D1 migrations on in-memory SQLite.
import assert from "node:assert/strict";
import test from "node:test";

import worker from "../src/index.js";
import { Database } from "../node_sqlite.mjs";
import * as M from "../../frontend/model.js";

const ORIGIN = "https://saif-daoud.github.io";
const env = { DB: new Database(":memory:"), ALLOWED_ORIGINS: ORIGIN, ACCESS_CODE: "TEST-CODE", TOKEN_SECRET: "test-secret", ADMIN_TOKEN: "admin" };

// t0 P, t1 T, t2 P, t3 T, t4 P, t5 T  (two TOPAS phases: turns 0-2 and 3-5)
const turns = Array.from({ length: 6 }, (_, i) => ({
  turn_index: i,
  speaker: i % 2 ? "therapist" : "patient",
  utterance_id: `${i % 2 ? "therapist" : "patient"}_${Math.floor(i / 2)}`,
  text: `Utterance ${i}`,
  phase_index: i < 3 ? 0 : 1,
  macro_action: i < 3 ? "Therapeutic Alliance and Engagement" : "Psychoeducation and Therapy Orientation",
  micro_action: i % 2 ? (i === 5 ? "None" : "Validate and Reflect Patient Experience") : null
}));

async function call(path, { method = "GET", body, token, origin = ORIGIN } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (origin) headers.Origin = origin;
  const response = await worker.fetch(new Request(`https://api.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  return { status: response.status, data: await response.json().catch(() => ({})) };
}

test("verification flow", async () => {
  await env.DB.prepare(
    `INSERT INTO sessions (id, display_order, user_idx, session_idx, patient, title, summary, conditions_json, therapist_turns, patient_turns, word_count)
     VALUES ('S01', 1, 6, 16, 'SZ', 't', 's', '["Anxiety"]', 3, 3, 12)`
  ).run();
  for (const t of turns) {
    await env.DB.prepare("INSERT INTO session_turns (session_id, turn_index, speaker, utterance_id, text, phase_index, macro_action, micro_action) VALUES ('S01', ?, ?, ?, ?, ?, ?, ?)")
      .bind(t.turn_index, t.speaker, t.utterance_id, t.text, t.phase_index, t.macro_action, t.micro_action).run();
  }
  await env.DB.prepare(
    `INSERT INTO experts (email, name, role, institution, latest_degree, years_experience, created_at, updated_at, last_seen_at, source)
     VALUES ('pre@clinic.org', 'Dr P', 'Psychiatrist', 'Clinic', 'MD', 12, 'x', 'x', 'x', 'cbt-live-interaction')`
  ).run();

  assert.equal((await call("/api/login", { method: "POST", body: { email: "pre@clinic.org", access_code: "no" } })).status, 401);
  const login = await call("/api/login", { method: "POST", body: { email: "Pre@Clinic.org", access_code: "TEST-CODE" } });
  assert.equal(login.data.needs_profile, false, "pre-registered experts skip the profile");
  const token = login.data.token;

  const detail = await call("/api/sessions/S01", { token });
  assert.equal(detail.data.session.turns[1].macro_action, "Therapeutic Alliance and Engagement");
  assert.equal(detail.data.session.turns[5].micro_action, "None");

  // Mark turn 1 macro wrong, turn 5 micro wrong with a note; flags on patient turns are ignored.
  const doc = M.emptyDocument();
  doc.flags = { 1: { macro: true, micro: false, note: "" }, 5: { macro: false, micro: true, note: "Socratic question" }, 2: { macro: true } };
  doc.ui.seen = true;
  let save = await call("/api/sessions/S01/annotation", { method: "PUT", token, body: { data: doc, revision: 0, active_seconds_delta: 20 } });
  assert.equal(save.status, 200);
  assert.equal((await call("/api/sessions/S01/annotation", { method: "PUT", token, body: { data: doc, revision: 0 } })).status, 409, "stale revision rejected");
  const list = await call("/api/sessions", { token });
  assert.deepEqual(list.data.sessions[0].progress, { therapist_turns: 3, flagged_turns: 2, macro_flags: 1, micro_flags: 1 });

  const submit = await call("/api/sessions/S01/submit", { method: "POST", token, body: { data: doc, revision: 1 } });
  assert.equal(submit.status, 200);
  assert.equal((await call("/api/sessions/S01/annotation", { method: "PUT", token, body: { data: doc, revision: 2 } })).status, 409, "submitted sessions are locked");
  const reopened = await call("/api/sessions/S01/reopen", { method: "POST", token, body: { revision: 2 } });
  assert.equal(reopened.data.annotation.status, "in_progress");
  assert.equal(reopened.data.annotation.stage, "review");

  const exported = await call("/api/admin/export", { method: "POST", body: { admin_token: "admin" } });
  const v = exported.data.annotations[0].verification;
  assert.equal(v.turns.length, 3);
  assert.deepEqual(v.turns.map(r => [r.utterance_id, r.macro_wrong, r.micro_wrong]), [["therapist_0", true, false], ["therapist_1", false, false], ["therapist_2", false, true]]);
  assert.equal(v.turns[2].note, "Socratic question");
  assert.equal(v.summary.macro_accuracy, 0.6667);
  assert.equal(v.summary.micro_accuracy_when_macro_correct, 0.5);
  assert.equal(exported.data.experts[0].source, "cbt-live-interaction");
});
