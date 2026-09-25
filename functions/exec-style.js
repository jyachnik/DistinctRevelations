'use strict';
/* ============================================================================
   exec-style.js — the two wordings of every AI result.

   "detail"    the current, technical version (PM vocabulary, task-level names, IDs).
   "executive" a C-level version: the bottom line first, business outcomes (delivery
               date, cost, exposure, decisions needed) instead of project mechanics.

   Which one a person gets is set per role in Settings > Permissions ("AI wording —
   Executive version" / "— Detail version"; stored as reportPermissions.<id>[role]).
   A role with neither ticked keeps the detailed wording, so nothing changes for
   existing roles. The owner has both. resolveStyle() applies that rule on the server
   (the browser mirrors it in dr-access-control.js: canRoleUseVersion).
   ============================================================================ */

const EXEC_ID = 'aiExecutiveVersionAction';
const DETAIL_ID = 'aiDetailVersionAction';

// -> { allowExecutive, allowDetail, style }   requested: 'executive' | 'detail' | anything else (= the person's default)
function resolveStyle({ isOwner, role, perms, requested }) {
  perms = perms || {};
  let allowExecutive = true, allowDetail = true;
  if (!isOwner) {
    allowExecutive = !!(perms[EXEC_ID] && perms[EXEC_ID][role] === true);
    allowDetail = !!(perms[DETAIL_ID] && perms[DETAIL_ID][role] === true);
    if (!allowExecutive && !allowDetail) allowDetail = true;      // nothing ticked: the current wording
  }
  let style;
  if (requested === 'executive' && allowExecutive) style = 'executive';
  else if (requested === 'detail' && allowDetail) style = 'detail';
  else style = allowDetail ? 'detail' : 'executive';               // not allowed what was asked (or nothing asked): the version they have
  if (!requested && allowExecutive && allowDetail) style = 'detail';
  return { allowExecutive, allowDetail, style };
}

// What "executive" means, shared by the analysis and the Ask prompts.
const EXEC_VOICE =
  'Write for a C-suite reader (CEO/CFO/COO/sponsor) who has two minutes: lead with the bottom line, then only what changes a decision. ' +
  'Use business language — delivery confidence, exposure, variance to plan, run-rate, runway, headroom, critical dependency, escalation, ' +
  'mitigation, decision point, value at stake — rather than project-management mechanics. Translate methodology terms: say "schedule efficiency" ' +
  'or "cost efficiency" (you may quote the index value in brackets), "the sequence of work that sets the finish date" for critical path, ' +
  '"on plan / at risk / off track" for status. Frame every point as an outcome (finish date, spend, revenue or reputation at risk, compliance) ' +
  'and, where it applies, the decision or support needed from leadership. Do not list task names, WBS numbers or record IDs (R-004, D-012), ' +
  'unless the reader needs one to act. Dates are MM/DD/YYYY.\n' +
  'GROUNDING (strict): every number, name and date must come from the data given. Do not compute new durations (for example "30 days overdue" or "three months") ' +
  'unless the data states them, and do not describe a trend as monthly, weekly or consecutive unless the data does. Do not say that an action, protocol, escalation or ' +
  'mitigation exists or is under way unless the data says so — a response you cannot support is simply left empty. Report what the data shows; do not speculate about ' +
  'causes, culture or control gaps, and do not recommend anything the data does not point to. A "decision needed" must be something the data shows is pending.';

// Extra keys asked of runProjectAnalysis (appended to its prompt).
const EXEC_ANALYSIS_SPEC =
  '\n\nALSO produce these two keys (in the same JSON object) for the executive audience. ' + EXEC_VOICE + '\n' +
  '"executive": an object with exactly these keys:\n' +
  '  "headline": ONE sentence (max 25 words) — the overall verdict on delivering the agreed outcome on time and on budget, and the single biggest reason. No record IDs.\n' +
  '  "assessment": 2 to 3 sentences on where the project stands against its commitments (schedule, budget, scope/quality) in business terms.\n' +
  '  "keyMessages": an array of 3 to 4 strings (max 25 words each) — what leadership should take away.\n' +
  '  "risksToObjectives": an array of up to 3 objects {"risk","businessImpact","response"} (each max 25 words) — the exposures that could cost time, money or credibility, and the response ONLY if the data names one (an owner counts: "Owner: Marcus"), otherwise an empty string. Empty array if the data shows none.\n' +
  '  "decisionsNeeded": an array of up to 3 objects {"decision","by","consequence"} — what leadership must decide, approve or unblock, by when, and what happens if it is not. "by" is a MM/DD/YYYY date from the data, or at most five words such as "Next review", or an empty string. Empty array if nothing genuinely needs leadership.\n' +
  '  "outlook": 1 to 2 sentences on the forward look — forecast finish date and confidence in budget.\n' +
  '"cardTextExec": an object mapping each CARD_FACTS key to ONE sentence (max 25 words) in the executive voice: the "so what" for the business, opening with the consequence, not the metric. No task names or record IDs.';

// The executive layer is its own model call (a stronger model than the technical analysis, and isolated:
// if it fails the technical analysis is still saved). It sees the same facts and records, plus the
// technical analysis' findings, and is held to the same grounding rules.
const EXEC_MODEL = 'claude-sonnet-5';
function buildExecPrompt({ cardFactsStr, recordsStr, analysis }) {
  return 'You write the executive briefing layer of a project dashboard. Below are (1) CARD_FACTS — sentences already shown on the dashboard, computed ' +
    'deterministically and correct; (2) RAW_RECORDS — the underlying project data; (3) ANALYST_NOTES — what the technical analysis found (useful pointers, but any ' +
    'claim you make must still be supported by CARD_FACTS or RAW_RECORDS).' + EXEC_ANALYSIS_SPEC.replace('ALSO produce these two keys (in the same JSON object)', 'Produce a JSON object with exactly these two keys') +
    '\n\nReturn ONLY the JSON object, no preamble or code fences.\n\nCARD_FACTS:\n' + cardFactsStr +
    '\n\nANALYST_NOTES:\n' + JSON.stringify(analysis) + '\n\nRAW_RECORDS:\n' + recordsStr;
}

const str = (v, max) => (v == null ? '' : String(v)).replace(/\s+/g, ' ').trim().slice(0, max);
const arr = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);

// Keeps only what the card/report expect, whatever the model returned.
function sanitizeExecutive(x) {
  if (!x || typeof x !== 'object' || !str(x.headline, 300)) return null;
  return {
    headline: str(x.headline, 300),
    assessment: str(x.assessment, 900),
    keyMessages: arr(x.keyMessages, 5).map((m) => str(m, 300)).filter(Boolean),
    risksToObjectives: arr(x.risksToObjectives, 3).map((r) => ({ risk: str(r && r.risk, 300), businessImpact: str(r && r.businessImpact, 300), response: str(r && r.response, 300) })).filter((r) => r.risk),
    decisionsNeeded: arr(x.decisionsNeeded, 3).map((d) => ({ decision: str(d && d.decision, 300), by: str(d && d.by, 80), consequence: str(d && d.consequence, 300) })).filter((d) => d.decision),
    outlook: str(x.outlook, 600)
  };
}
function sanitizeCardTextExec(o) {
  const out = {};
  if (o && typeof o === 'object') Object.keys(o).forEach((k) => { const t = str(o[k], 400); if (t) out[k] = t; });
  return out;
}

// Ask the Project: appended to the system prompt for the executive wording.
const ASK_EXEC_RULES =
  'ANSWER STYLE — EXECUTIVE. ' + EXEC_VOICE + ' Keep the whole answer to 100 words at most (count them): one bottom-line sentence, then at most three short one-line bullets ' +
  '(business impact, exposure, decision or support needed). Keep the [n] citations on the facts you use. Add no recommendation or instruction the context does not contain. If the question needs task-level detail ' +
  'the context contains, summarise it and say a detailed answer is available.';

module.exports = { EXEC_MODEL, buildExecPrompt, EXEC_ID, DETAIL_ID, resolveStyle, EXEC_VOICE, EXEC_ANALYSIS_SPEC, sanitizeExecutive, sanitizeCardTextExec, ASK_EXEC_RULES };
