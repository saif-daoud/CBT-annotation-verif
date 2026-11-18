// Verification document model, shared by the browser (app.js) and the Cloudflare Worker.
// An expert marks therapist turns whose automatic macro and/or micro label is wrong; unmarked turns count as correct.

export const STAGES = ["review", "done"];
export const MAX_DOC_BYTES = 200000;

export function emptyDocument() {
  return { version: 1, flags: {}, comments: "", ui: { seen: false } };
}

const text = (value, max) => String(value ?? "").slice(0, max);

// Normalise an untrusted document. `turns` are the session turns (with speaker and turn_index).
export function sanitizeDocument(input, turns) {
  const doc = emptyDocument();
  if (!input || typeof input !== "object") return doc;
  const therapist = new Set(turns.filter(t => t.speaker === "therapist").map(t => t.turn_index));
  for (const [key, raw] of Object.entries(input.flags || {})) {
    const turnIndex = Number(key);
    if (!therapist.has(turnIndex) || !raw || typeof raw !== "object") continue;
    const flag = { macro: raw.macro === true, micro: raw.micro === true, note: text(raw.note, 500) };
    if (flag.macro || flag.micro || flag.note.trim()) doc.flags[String(turnIndex)] = flag;
  }
  doc.comments = text(input.comments, 4000);
  doc.ui = { seen: input.ui?.seen === true };
  return doc;
}

export function documentProgress(doc, turns) {
  const flags = Object.values(doc.flags || {});
  return {
    therapist_turns: turns.filter(t => t.speaker === "therapist").length,
    flagged_turns: flags.filter(f => f.macro || f.micro).length,
    macro_flags: flags.filter(f => f.macro).length,
    micro_flags: flags.filter(f => f.micro).length
  };
}

// Analysis-ready view: one row per therapist turn with the automatic labels and the expert's verdicts.
export function flattenDocument(doc, turns) {
  const rows = turns.filter(t => t.speaker === "therapist").map(t => {
    const flag = doc.flags?.[String(t.turn_index)] || {};
    return {
      turn_index: t.turn_index,
      utterance_id: t.utterance_id,
      phase_index: t.phase_index,
      macro_action: t.macro_action,
      micro_action: t.micro_action,
      macro_wrong: flag.macro === true,
      micro_wrong: flag.micro === true,
      note: flag.note || ""
    };
  });
  const n = rows.length || 1;
  const macroWrong = rows.filter(r => r.macro_wrong).length;
  const microWrong = rows.filter(r => r.micro_wrong).length;
  const sameMacro = rows.filter(r => !r.macro_wrong);
  return {
    turns: rows,
    summary: {
      therapist_turns: rows.length,
      macro_marked_wrong: macroWrong,
      micro_marked_wrong: microWrong,
      macro_accuracy: Number((1 - macroWrong / n).toFixed(4)),
      micro_accuracy: Number((1 - microWrong / n).toFixed(4)),
      micro_accuracy_when_macro_correct: sameMacro.length
        ? Number((sameMacro.filter(r => !r.micro_wrong).length / sameMacro.length).toFixed(4))
        : null
    },
    comments: doc.comments || ""
  };
}
