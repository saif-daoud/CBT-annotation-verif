import { TAXONOMY } from "./taxonomy.js";
import * as M from "./model.js";

const API = String(window.APP_CONFIG?.apiBase || "").replace(/\/+$/, "");
const TOKEN_KEY = "cbt-verif-token";
const MACRO_INFO = Object.fromEntries(TAXONOMY.macro_actions.map(m => [m.name, m]));
const MICRO_INFO = Object.fromEntries(TAXONOMY.macro_actions.flatMap(m => m.micro_actions.map(a => [a.name, { ...a, macro: m.name }])));
const PHASE_CLASSES = 6;

const $ = (selector, root = document) => root.querySelector(selector);
const app = $("#app");

// localStorage can be unavailable (private mode, blocked storage): every access is guarded.
const store = {
  get(key) { try { return window.localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { window.localStorage.setItem(key, value); } catch { /* unavailable */ } },
  remove(key) { try { window.localStorage.removeItem(key); } catch { /* unavailable */ } }
};

function emailFromToken(token) {
  try {
    const payload = token.split(".")[0].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(payload + "===".slice((payload.length + 3) % 4))).email || "";
  } catch {
    return "";
  }
}

const S = {
  token: store.get(TOKEN_KEY) || "",
  email: "",
  expert: null,
  sessions: [],
  view: "loading",
  loginError: "",
  profileError: "",
  session: null,
  turns: [],
  ann: null,
  sel: null,
  showIntro: false,
  conflict: false,
  save: { dirty: false, event: "", timer: null, chain: Promise.resolve(), status: "saved", error: "" },
  active: { unsent: 0, last: Date.now() }
};

// ------------------------------------------------------------------ helpers
function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function toast(message, ms = 3200) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add("hidden"), ms);
}

function minutes(seconds) {
  const m = Math.round((seconds || 0) / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

async function api(path, { method = "GET", body } = {}) {
  let response;
  try {
    response = await fetch(API + path, {
      method,
      headers: { "Content-Type": "application/json", ...(S.token ? { Authorization: `Bearer ${S.token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch {
    const error = new Error("Cannot reach the server. Check your connection.");
    error.status = 0;
    throw error;
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status}).`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function signOut(message = "") {
  S.token = "";
  S.expert = null;
  S.session = null;
  S.ann = null;
  store.remove(TOKEN_KEY);
  S.loginError = message;
  S.view = "login";
  if (location.hash !== "#/") history.replaceState(null, "", "#/");
  render();
}

function handleAuthError(error) {
  if (error.status === 401) { signOut(error.message); return true; }
  if (error.status === 403 && error.data?.needs_profile) { S.view = "profile"; render(); return true; }
  return false;
}

const doc = () => S.ann?.data;
const backupKey = () => `cbt-verif:${S.email}:${S.session?.id}`;
const flagOf = turnIndex => doc().flags[String(turnIndex)] || { macro: false, micro: false, note: "" };
const therapistTurns = () => S.turns.filter(t => t.speaker === "therapist");
const labelText = micro => (micro === "None" ? "None (no specific move)" : micro);

// ------------------------------------------------------------------ saving
function changed(event = "") {
  if (!S.ann || S.ann.status === "submitted") return;
  S.save.dirty = true;
  if (event) S.save.event = event;
  store.set(backupKey(), JSON.stringify({ revision: S.ann.revision, data: S.ann.data, at: Date.now() }));
  setSaveStatus("pending");
  clearTimeout(S.save.timer);
  S.save.timer = setTimeout(flushSave, event ? 0 : 700);
}

function flushSave() {
  clearTimeout(S.save.timer);
  S.save.timer = null;
  S.save.chain = S.save.chain.then(doSave).catch(() => {});
  return S.save.chain;
}

async function doSave() {
  const ann = S.ann;
  const session = S.session;
  if (!ann || !session || !S.save.dirty || ann.status === "submitted" || S.conflict) return;
  S.save.dirty = false;
  const event = S.save.event;
  S.save.event = "";
  const delta = S.active.unsent;
  S.active.unsent = 0;
  setSaveStatus("saving");
  try {
    const result = await api(`/api/sessions/${session.id}/annotation`, {
      method: "PUT",
      body: { data: ann.data, revision: ann.revision, stage: "review", event, active_seconds_delta: delta }
    });
    ann.revision = result.annotation.revision;
    ann.active_seconds = result.annotation.active_seconds;
    if (S.ann === ann && !S.save.dirty) store.remove(backupKey());
    setSaveStatus(S.save.dirty ? "pending" : "saved");
  } catch (error) {
    S.active.unsent += delta;
    if (event && !S.save.event) S.save.event = event;
    if (handleAuthError(error)) return;
    if (error.status === 409) { showConflict(); return; }
    S.save.dirty = true;
    setSaveStatus("error", error.message);
    clearTimeout(S.save.timer);
    S.save.timer = setTimeout(flushSave, 5000);
  }
}

function setSaveStatus(status, message = "") {
  S.save.status = status;
  S.save.error = message;
  const el = $("#save-status");
  if (!el) return;
  el.textContent = { saved: "All changes saved", pending: "Saving…", saving: "Saving…", error: "Not saved – retrying" }[status] || "";
  el.title = message;
  el.className = `save-status ${status}`;
}

function showConflict() {
  S.conflict = true;
  if (window.confirm("This session was changed in another tab or window. Reload it to continue with the latest saved version?")) {
    S.conflict = false;
    store.remove(backupKey());
    openSession(S.session.id);
  } else {
    setSaveStatus("error", "Changes are not being saved because the session was modified elsewhere. Reload the page.");
  }
}

window.addEventListener("beforeunload", event => {
  if (S.save.dirty || S.save.status === "saving") {
    flushSave();
    event.preventDefault();
    event.returnValue = "";
  }
});

["pointerdown", "keydown", "wheel", "scroll", "mousemove"].forEach(type =>
  window.addEventListener(type, () => { S.active.last = Date.now(); }, { passive: true, capture: true }));
setInterval(() => {
  if (S.view !== "session" || !S.ann || S.ann.status === "submitted") return;
  if (document.visibilityState !== "visible" || Date.now() - S.active.last > 90000) return;
  S.active.unsent += 1;
  if (S.active.unsent >= 60 && !S.save.dirty && S.save.status !== "saving") {
    S.save.dirty = true;
    flushSave();
  }
}, 1000);

// ------------------------------------------------------------------ navigation
async function boot() {
  window.addEventListener("hashchange", route);
  S.email = emailFromToken(S.token);
  if (!S.token) { S.view = "login"; render(); return; }
  await route();
}

async function route() {
  if (!S.token) { S.view = "login"; render(); return; }
  if (S.view === "session" && S.session) await flushSave();
  const match = location.hash.match(/^#\/session\/([A-Za-z0-9_-]+)/);
  if (match) await openSession(match[1]);
  else await openDashboard();
}

async function openDashboard() {
  S.session = null;
  S.ann = null;
  try {
    const data = await api("/api/sessions");
    S.expert = data.expert;
    S.email = data.expert.email;
    S.sessions = data.sessions;
    S.view = "dashboard";
  } catch (error) {
    if (handleAuthError(error)) return;
    S.view = "error";
    S.errorMessage = error.message;
  }
  render();
}

async function openSession(sessionId) {
  S.view = "loading";
  render();
  try {
    const data = await api(`/api/sessions/${encodeURIComponent(sessionId)}`);
    if (!S.expert) {
      const list = await api("/api/sessions");
      S.expert = list.expert;
      S.email = list.expert.email;
      S.sessions = list.sessions;
    }
    S.session = data.session;
    S.turns = data.session.turns;
    S.ann = data.annotation || { data: M.emptyDocument(), revision: 0, status: "in_progress", stage: "review", active_seconds: 0 };
    S.ann.data = M.sanitizeDocument(S.ann.data, S.turns);
    S.save = { dirty: false, event: "", timer: null, chain: Promise.resolve(), status: "saved", error: "" };
    S.conflict = false;
    S.sel = null;
    S.showIntro = false;
    S.active.unsent = 0;
    let backup = null;
    try { backup = JSON.parse(store.get(backupKey()) || "null"); } catch { backup = null; }
    if (backup && S.ann.status !== "submitted" && backup.revision === S.ann.revision) {
      S.ann.data = M.sanitizeDocument(backup.data, S.turns);
      changed();
      toast("Restored changes that had not been saved yet.");
    } else {
      store.remove(backupKey());
    }
    S.view = "session";
  } catch (error) {
    if (handleAuthError(error)) return;
    S.view = "error";
    S.errorMessage = error.message;
  }
  render();
}

// ------------------------------------------------------------------ rendering
function render() {
  renderHeader();
  if (S.view === "loading") app.innerHTML = '<p class="loading">Loading…</p>';
  else if (S.view === "login") app.innerHTML = loginHtml();
  else if (S.view === "profile") app.innerHTML = profileHtml();
  else if (S.view === "dashboard") app.innerHTML = dashboardHtml();
  else if (S.view === "session") renderSession();
  else app.innerHTML = `<div class="center-wrap"><div class="card login-card"><h2>Something went wrong</h2><p class="error">${esc(S.errorMessage || "")}</p><a class="btn" href="#/">Back to sessions</a></div></div>`;
}

function renderHeader() {
  const right = $("#header-right");
  if (!S.token || !S.expert || ["login", "profile"].includes(S.view)) {
    right.innerHTML = "";
    return;
  }
  right.innerHTML = `
    <span class="who-am-i">${esc(S.expert.name)} · ${esc(S.expert.email)}</span>
    <button class="btn ghost small" type="button" data-action="guide">Guide</button>
    <button class="btn ghost small" type="button" data-action="sign-out">Sign out</button>`;
}

function loginHtml() {
  return `
  <section class="center-wrap">
    <div class="card login-card">
      <h1>CBT annotation check</h1>
      <form id="login-form" class="form-grid" novalidate>
        <label class="field">Email address<input id="login-email" type="email" autocomplete="email" maxlength="254" required value="${esc(S.email)}" /></label>
        <label class="field">Study access code<input id="login-code" type="password" autocomplete="current-password" required /></label>
        ${S.loginError ? `<p class="error" role="alert">${esc(S.loginError)}</p>` : ""}
        <button class="btn primary" type="submit">Sign in</button>
      </form>
    </div>
  </section>`;
}

function profileHtml() {
  const e = S.expert || {};
  return `
  <section class="center-wrap">
    <div class="card login-card" style="width:min(620px,100%)">
      <h1>Complete your profile</h1>
      <p class="lead">Asked only on your first sign-in.</p>
      <form id="profile-form" class="form-grid two" novalidate>
        <label class="field full">Email address<input type="email" value="${esc(S.email)}" disabled /></label>
        <label class="field">Full name<input name="name" autocomplete="name" maxlength="160" required value="${esc(e.name || "")}" /></label>
        <label class="field">Role or specialty<input name="role" maxlength="200" required value="${esc(e.role || "")}" /></label>
        <label class="field">Institution<input name="institution" maxlength="260" required value="${esc(e.institution || "")}" /></label>
        <label class="field">Latest degree<input name="latest_degree" maxlength="160" required value="${esc(e.latest_degree || "")}" /></label>
        <label class="field full">Years of clinical experience<input name="years_experience" type="number" min="0" max="80" step="1" required value="${esc(e.years_experience ?? "")}" /></label>
        ${S.profileError ? `<p class="error full" role="alert">${esc(S.profileError)}</p>` : ""}
        <div class="form-actions full">
          <button class="btn ghost" type="button" data-action="sign-out">Back</button>
          <button class="btn primary" type="submit">Continue</button>
        </div>
      </form>
    </div>
  </section>`;
}

function statusOf(session) {
  if (session.status === "submitted") return { cls: "submitted", text: "Submitted ✓" };
  if (session.status === "not_started") return { cls: "not_started", text: "Not started" };
  const n = session.progress?.flagged_turns || 0;
  return { cls: "in_progress", text: `In progress · ${n} turn${n === 1 ? "" : "s"} marked` };
}

function dashboardHtml() {
  const submitted = S.sessions.filter(s => s.status === "submitted").length;
  const first = String(S.expert?.name || "").split(/\s+/)[0];
  const rows = S.sessions.map(s => {
    const st = statusOf(s);
    const action = s.status === "submitted" ? "View" : s.status === "not_started" ? "Start" : "Continue";
    return `
    <div class="card session-row ${st.cls}">
      <span class="num">${s.display_order}</span>
      <div>
        <div class="patient">Patient “${esc(s.patient)}”</div>
        <div class="summary" title="${esc(s.summary)}">${esc(s.summary)}</div>
        <div class="chips">${s.conditions.map(c => `<span class="chip">${esc(c)}</span>`).join("")}</div>
      </div>
      <div class="len">${s.therapist_turns} therapist turns<br><span class="muted">about ${Math.max(5, Math.round(s.word_count / 230))} min to read</span></div>
      <div><span class="status ${st.cls}">${esc(st.text)}</span>
        ${s.active_seconds >= 60 ? `<br><span class="muted small">${minutes(s.active_seconds)} spent</span>` : ""}</div>
      <a class="btn ${s.status === "submitted" ? "" : "primary"}" href="#/session/${esc(s.id)}">${action}</a>
    </div>`;
  }).join("");
  return `
  <section class="page">
    <div class="page-head">
      <div><h1>Welcome${first ? `, ${esc(first)}` : ""}</h1><p class="muted">${submitted} of ${S.sessions.length} sessions submitted</p></div>
      <button class="btn" type="button" data-action="guide">Guide</button>
    </div>
    <div class="card howto">
      <ol>
        <li><b>Read the session</b>Each therapist turn shows two labels that were assigned automatically: its macro action and its micro action.</li>
        <li><b>Mark the wrong labels</b>Tick “Macro action is wrong” and/or “Micro action is wrong” on the turns you disagree with.</li>
        <li><b>Submit</b>Turns you leave unmarked count as correct.</li>
      </ol>
    </div>
    <div class="session-list">${rows || '<p class="muted">No sessions are available yet.</p>'}</div>
  </section>`;
}

// ---------- session
function introVisible() {
  return S.ann.status !== "submitted" && (S.showIntro || !doc().ui.seen);
}

function renderSession() {
  const mode = S.ann.status === "submitted" ? "done" : introVisible() ? "intro" : "review";
  const key = `${S.session.id}:${mode}`;
  if (app.dataset.sessionKey !== key || !$("#session-body")) {
    app.dataset.sessionKey = key;
    app.innerHTML = `<div class="session-shell"><div class="session-bar" id="session-bar"></div><div class="session-body" id="session-body"></div></div>`;
    const body = $("#session-body");
    if (mode === "done") body.innerHTML = `<div class="pane" style="flex:1">${doneHtml()}</div>`;
    else if (mode === "intro") body.innerHTML = `<div class="pane intro-pane" id="intro-pane">${introHtml()}</div>`;
    else body.innerHTML = `<div class="split"><div class="pane pane-main" id="pane-main"></div><aside class="pane pane-side" id="pane-side"></aside></div>`;
  }
  paintBar();
  if (mode === "review") { paintMain(); paintSide(); }
}

function paintBar() {
  $("#session-bar").innerHTML = `
    <a class="back" href="#/">← Sessions</a>
    <span class="sb-title">Session ${S.session.display_order} · Patient “${esc(S.session.patient)}”</span>
    <span style="flex:1"></span>
    <div class="sb-right">
      <span id="save-status" class="save-status"></span>
      ${S.ann.status !== "submitted" && !introVisible() ? '<button class="btn small" type="button" data-action="intro">Instructions</button>' : ""}
      <button class="btn small" type="button" data-action="info">Session info</button>
    </div>`;
  setSaveStatus(S.save.status, S.save.error);
}

function introHtml() {
  const s = S.session;
  const label = doc().ui.seen ? "Back to the session" : "Start checking";
  return `<div class="intro">
    <p class="intro-kicker">Session ${s.display_order} · Patient “${esc(s.patient)}”</p>
    <h1>Check the automatic labels</h1>
    <p class="intro-lead">Every therapist turn in this session has been labelled automatically. Your task is to mark the labels you think are wrong.</p>
    <div class="intro-session"><b>About this session</b><p>${esc(s.summary)}</p>
      <div class="chips">${s.conditions.map(c => `<span class="chip">${esc(c)}</span>`).join("")}</div>
      <span class="muted small">${s.therapist_turns} therapist turns · about ${Math.max(5, Math.round(s.word_count / 230))} minutes of reading</span></div>
    <ol class="intro-steps">
      <li><b>Read the session</b><span>Each therapist turn shows its two labels under the text. Patient turns are shown for context only.</span></li>
      <li><b>Check both labels on every therapist turn</b><span>Click a turn to see the definitions of its labels next to the transcript.</span></li>
      <li><b>Mark what is wrong</b><span>Tick <b>Macro action is wrong</b> and/or <b>Micro action is wrong</b>. You can add a short note, for example the label you would choose. Leave correct turns unmarked.</span></li>
      <li><b>Submit</b><span>When you have checked the whole session, submit it. Unmarked turns count as correct.</span></li>
    </ol>
    <div class="intro-defs">
      <div><h3>Macro action</h3><p>The therapist's <b>overall strategy</b> in that part of the session, for example assessment and case formulation, or cognitive restructuring. Consecutive turns in the same part of the session share it; it is also shown at the start of each part.</p></div>
      <div><h3>Micro action</h3><p>The <b>specific therapeutic move</b> in that turn, for example a validating reflection or a Socratic question. <b>None</b> means that no specific move applies, for example a minimal response such as “Mm-hmm”.</p></div>
    </div>
    <div class="intro-actions"><button class="btn primary big" type="button" data-action="start">${label} →</button></div>
  </div>`;
}

function preserveScroll(selector, fn) {
  const el = $(selector);
  const top = el ? el.scrollTop : 0;
  fn();
  const after = $(selector);
  if (after) after.scrollTop = top;
}

function turnHtml(t) {
  if (t.speaker !== "therapist") {
    return `<div class="turn patient" id="turn-${t.turn_index}"><div class="who">Patient <span class="tn">#${t.turn_index + 1}</span></div><div class="text">${esc(t.text)}</div></div>`;
  }
  const f = flagOf(t.turn_index);
  const flagged = f.macro || f.micro;
  const macroInfo = MACRO_INFO[t.macro_action];
  const microInfo = MICRO_INFO[t.micro_action];
  return `<div class="turn therapist clickable ${flagged ? "flagged" : ""} ${S.sel === t.turn_index ? "selected" : ""}" id="turn-${t.turn_index}" data-action="select-turn" data-turn="${t.turn_index}">
    <div class="who">Therapist <span class="tn">#${t.turn_index + 1}</span></div>
    <div class="text">${esc(t.text)}</div>
    <div class="labels">
      <span class="lab macro ${f.macro ? "wrong" : ""}" title="${esc(macroInfo?.description || "")}"><span class="lab-kind">Macro</span>${esc(t.macro_action)}</span>
      <span class="lab micro ${f.micro ? "wrong" : ""}" title="${esc(microInfo?.description || (t.micro_action === "None" ? "No specific therapeutic move." : ""))}"><span class="lab-kind">Micro</span>${esc(labelText(t.micro_action))}</span>
    </div>
    <div class="verdict">
      <label class="vbox ${f.macro ? "on" : ""}"><input type="checkbox" data-flag="macro" data-turn="${t.turn_index}" ${f.macro ? "checked" : ""} /> Macro action is wrong</label>
      <label class="vbox ${f.micro ? "on" : ""}"><input type="checkbox" data-flag="micro" data-turn="${t.turn_index}" ${f.micro ? "checked" : ""} /> Micro action is wrong</label>
    </div>
    ${flagged ? `<input class="note-input" type="text" maxlength="500" data-field="note" data-turn="${t.turn_index}" placeholder="Note (optional): the label you would choose, or why" value="${esc(f.note)}" />` : ""}
  </div>`;
}

function paintMain() {
  preserveScroll("#pane-main", () => {
    const groups = [];
    for (const t of S.turns) {
      if (!groups.length || groups[groups.length - 1].phase !== t.phase_index) groups.push({ phase: t.phase_index, macro: t.macro_action, turns: [] });
      groups[groups.length - 1].turns.push(t);
    }
    $("#pane-main").innerHTML = `<div class="transcript">${groups.map((g, i) => `
      <section class="phase-block c${i % PHASE_CLASSES}">
        <div class="phase-head"><span class="phase-num">Macro action: ${esc(g.macro)}</span><span class="muted small">turns ${g.turns[0].turn_index + 1}–${g.turns[g.turns.length - 1].turn_index + 1}</span></div>
        ${g.turns.map(turnHtml).join("")}
      </section>`).join("")}</div>`;
  });
}

function paintSide() {
  preserveScroll("#pane-side .side-scroll", () => {
    const progress = M.documentProgress(doc(), S.turns);
    const t = S.sel !== null ? S.turns.find(x => x.turn_index === S.sel) : null;
    const macroInfo = t ? MACRO_INFO[t.macro_action] : null;
    const microInfo = t ? MICRO_INFO[t.micro_action] : null;
    $("#pane-side").innerHTML = `<div class="side-scroll">
      <div class="side-section">
        <h2>Check the labels</h2>
        <ol class="task-list">
          <li>Read each therapist turn and its two labels.</li>
          <li>Tick <b>Macro action is wrong</b> and/or <b>Micro action is wrong</b> where you disagree.</li>
          <li>Leave correct turns unmarked, then submit.</li>
        </ol>
      </div>
      <div class="side-section"><div class="tally">
        <div><b>${progress.macro_flags}</b>macro actions marked wrong</div>
        <div><b>${progress.micro_flags}</b>micro actions marked wrong</div>
      </div><p class="muted small" style="margin:6px 0 0">${progress.flagged_turns} of ${progress.therapist_turns} therapist turns marked.</p></div>
      <div class="side-section">
        <h3>${t ? `Labels of therapist turn #${t.turn_index + 1}` : "Label definitions"}</h3>
        ${t ? `<div class="def"><span class="lab macro"><span class="lab-kind">Macro</span>${esc(t.macro_action)}</span><p>${esc(macroInfo?.description || "")}</p></div>
               <div class="def"><span class="lab micro"><span class="lab-kind">Micro</span>${esc(labelText(t.micro_action))}</span><p>${esc(microInfo?.description || (t.micro_action === "None" ? "No specific therapeutic move applies to this turn." : ""))}</p></div>`
            : '<p class="muted small">Click a therapist turn to see the definitions of its two labels here.</p>'}
      </div>
      <div class="side-section">
        <label class="field">Comments about this session (optional)<textarea data-field="comments" rows="3" maxlength="4000">${esc(doc().comments)}</textarea></label>
      </div>
    </div>
    <div class="side-footer"><button class="btn primary" type="button" data-action="submit">Submit session</button></div>`;
  });
}

function doneHtml() {
  const p = M.documentProgress(doc(), S.turns);
  return `<div class="card done-card">
    <div class="done-check">✓</div>
    <h1>Session submitted</h1>
    <p class="muted">Thank you. Your check of session ${S.session.display_order} (patient “${esc(S.session.patient)}”) has been saved.</p>
    <div class="done-stats">
      <div><b>${p.macro_flags}</b>macro actions marked wrong</div>
      <div><b>${p.micro_flags}</b>micro actions marked wrong</div>
      <div><b>${p.therapist_turns}</b>therapist turns checked</div>
      <div><b>${minutes(S.ann.active_seconds)}</b>active time</div>
    </div>
    <div class="done-actions">
      <a class="btn primary" href="#/">Back to sessions</a>
      <button class="btn" type="button" data-action="reopen">Reopen to make changes</button>
    </div>
  </div>`;
}

function openInfo() {
  const s = S.session;
  $("#info-body").innerHTML = `<dl class="meta">
    <dt>Patient</dt><dd>“${esc(s.patient)}”</dd>
    <dt>Presenting conditions</dt><dd><div class="chips">${s.conditions.map(c => `<span class="chip">${esc(c)}</span>`).join("")}</div></dd>
    <dt>Summary</dt><dd>${esc(s.summary)}</dd>
    <dt>Title</dt><dd>${esc(s.title)}</dd>
    <dt>Length</dt><dd>${s.therapist_turns} therapist turns, ${s.patient_turns} patient turns, ${s.word_count.toLocaleString()} words</dd>
  </dl>`;
  $("#info-dialog").showModal();
}

// ------------------------------------------------------------------ actions
function setFlag(turnIndex, kind, value) {
  const f = { ...flagOf(turnIndex), [kind]: value };
  if (f.macro || f.micro || f.note.trim()) doc().flags[String(turnIndex)] = f;
  else delete doc().flags[String(turnIndex)];
  S.sel = turnIndex;
  changed();
  paintMain();
  paintSide();
}

async function submitSession() {
  const p = M.documentProgress(doc(), S.turns);
  const message = p.flagged_turns
    ? `Submit this session? You marked ${p.macro_flags} macro and ${p.micro_flags} micro action(s) as wrong; all other turns will count as correct.`
    : "Submit this session without marking any label as wrong? All turns will count as correct.";
  if (!window.confirm(message)) return;
  await flushSave();
  if (S.conflict) return;
  const delta = S.active.unsent;
  S.active.unsent = 0;
  try {
    const result = await api(`/api/sessions/${S.session.id}/submit`, {
      method: "POST", body: { data: doc(), revision: S.ann.revision, active_seconds_delta: delta }
    });
    Object.assign(S.ann, { status: "submitted", stage: "done", revision: result.annotation.revision, active_seconds: result.annotation.active_seconds });
    S.save.dirty = false;
    store.remove(backupKey());
    render();
    window.scrollTo(0, 0);
  } catch (error) {
    S.active.unsent += delta;
    if (handleAuthError(error)) return;
    if (error.status === 409) { showConflict(); return; }
    toast(error.message);
  }
}

async function reopenSession() {
  try {
    const result = await api(`/api/sessions/${S.session.id}/reopen`, { method: "POST", body: { revision: S.ann.revision } });
    Object.assign(S.ann, { status: "in_progress", stage: "review", revision: result.annotation.revision });
    render();
  } catch (error) {
    if (handleAuthError(error)) return;
    if (error.status === 409) { showConflict(); return; }
    toast(error.message);
  }
}

document.addEventListener("click", event => {
  const close = event.target.closest("[data-close]");
  if (close) { close.closest("dialog").close(); return; }
  if (event.target.matches("dialog")) { event.target.close(); return; }
  if (event.target.closest("input, textarea, label.vbox")) return;
  const el = event.target.closest("[data-action]");
  if (!el) return;
  switch (el.dataset.action) {
    case "guide": $("#guide-dialog").showModal(); break;
    case "info": openInfo(); break;
    case "sign-out": flushSave().finally(() => signOut()); break;
    case "intro": S.showIntro = true; render(); window.scrollTo(0, 0); break;
    case "start":
      if (!doc().ui.seen) { doc().ui.seen = true; changed(); }
      S.showIntro = false;
      render();
      break;
    case "select-turn":
      S.sel = Number(el.dataset.turn);
      paintMain();
      paintSide();
      break;
    case "submit": submitSession(); break;
    case "reopen": reopenSession(); break;
    default: break;
  }
});

document.addEventListener("change", event => {
  const el = event.target;
  if (el.matches("input[data-flag]")) setFlag(Number(el.dataset.turn), el.dataset.flag, el.checked);
});

document.addEventListener("input", event => {
  const el = event.target;
  if (S.view !== "session" || !el.dataset?.field) return;
  if (el.dataset.field === "note") {
    const turnIndex = Number(el.dataset.turn);
    doc().flags[String(turnIndex)] = { ...flagOf(turnIndex), note: el.value };
    changed();
  } else if (el.dataset.field === "comments") {
    doc().comments = el.value;
    changed();
  }
});

document.addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.target;
  if (form.id === "login-form") {
    const email = $("#login-email").value.trim();
    const code = $("#login-code").value;
    S.email = email;
    form.querySelector("button[type=submit]").disabled = true;
    try {
      const data = await api("/api/login", { method: "POST", body: { email, access_code: code } });
      S.token = data.token;
      S.email = data.email;
      S.expert = data.expert;
      store.set(TOKEN_KEY, data.token);
      S.loginError = "";
      if (data.needs_profile) { S.view = "profile"; render(); } else await route();
    } catch (error) {
      S.loginError = error.message;
      render();
    }
  } else if (form.id === "profile-form") {
    const values = Object.fromEntries(new FormData(form).entries());
    values.years_experience = Number(values.years_experience);
    try {
      const data = await api("/api/profile", { method: "POST", body: values });
      S.expert = data.expert;
      S.profileError = "";
      await route();
    } catch (error) {
      if (error.status === 401) { signOut(error.message); return; }
      S.profileError = error.message;
      render();
    }
  }
});

boot();
