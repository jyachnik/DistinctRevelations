'use strict';
/* ============================================================================
   report-analysis.js — the "Analysis" line under each executive section of the
   Status Report, with a machine check that nothing in it is made up.

   How it stays honest:
     1. The browser computes each section's FACTS from the project data the
        person's role may see (counts, dates, dollar amounts, owners) and sends only
        those. The model never sees anything else.
     2. The model may only interpret those facts: every number, date and record ID
        must be copied exactly as written; it may not compute, round or convert
        anything, and may not state causes, plans or actions the facts don't state.
     3. verifyAnalysis() then checks the reply mechanically: every number, date and
        record ID in each sentence must appear in that section's facts, and a
        sentence that spells out a quantity in words is dropped. A sentence that fails
        is removed. If nothing survives, the report simply shows no analysis for that
        section — it never shows an unchecked one.
   (Causal wording can't be checked by machine; the prompt forbids it and the facts
   contain no causes to borrow.)
   ============================================================================ */

const { resolveStyle } = require('./exec-style');

const MODEL = 'claude-sonnet-5';
const SECTION_IDS = ['bottom', 'changed', 'schedule', 'budget', 'scope', 'risks', 'decisions', 'vendors', 'next'];
// Every executive section can now ask for suggested next steps, not just the four chart-bearing ones —
// the whitelist is the same nine section ids used for the checked "analysis" sentence.
const CHART_IDS = SECTION_IDS;
const MAX_SECTIONS = 12, MAX_FACTS = 80, MAX_FACT_CHARS = 500;
const NUMBER_WORDS = /\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|dozen|half|double|triple|percent)\b/i;

// Opinion, prediction and evaluation words. The checker cannot judge whether such a claim is true, so a sentence may
// use one only if the facts themselves use that very word (e.g. "2 critical dependencies"). Anything else is dropped.
const OPINION_WORDS = /\b(affect\w*|caus\w*|because|driv\w*|result\w*|contribut\w*|lead(?:s|ing)? to|due to|will|would|could|may|might|should|must|likely|unlikely|probably|possibly|perhaps|expect\w*|anticipat\w*|predict\w*|forecasts?|suggest\w*|indicat\w*|impl(?:y|ies|ied)|signal\w*|threat\w*|jeopard\w*|endanger\w*|concern\w*|worr\w*|confiden\w*|risky|danger\w*|critical|serious\w*|severe\w*|significant\w*|substantial\w*|material\w*|major|minor|alarming|healthy|strong\w*|weak\w*|poor\w*|good|bad|low|deteriorat\w*|improv\w*|trend\w*|pressure\w*|exposure|exposed|attention|urgent\w*|immediate\w*|sufficient|insufficient|adequate|inadequate|comfortabl\w*|tight|slack|headroom|room)\b/gi;

class ReportError extends Error { constructor(code, message) { super(message); this.code = code; } }

// ---- the checker (pure)
const DATE_RE = /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g;
const ID_RE = /\b[A-Za-z]{1,5}-[A-Za-z]?\d+[A-Za-z0-9-]*\b/g;
const NUM_RE = /(\$?)(\d[\d,]*(?:\.\d+)?)(%)?(?:\s+([A-Za-z][A-Za-z-]*))?/g;
const FUNCTION_WORDS = new Set('of to and in is by at on for or the a an with from as are was were be been it its this that than then over under into per out up off'.split(' '));

function normDate(d) {
  const [m, day, y] = d.split('/').map((x) => parseInt(x, 10));
  return m + '/' + day + '/' + (y < 100 ? 2000 + y : y);
}
function normNum(n) { return n.replace(/,/g, '').replace(/^0+(?=\d)/, ''); }
const stem = (w) => w.toLowerCase().replace(/(ies|es|s)$/, '');

// "14d" is "14 days"
function prep(text) { return String(text || '').replace(/(\d)d\b/g, '$1 days'); }

// Everything numeric in a text, by kind. nums: [{ n, cls, noun }] where cls is '$', '%', 'dec' (has a decimal point) or 'int',
// noun the word right after an integer ('' if none / a function word).
function inventory(text) {
  let t = prep(text);
  const dates = new Set((t.match(DATE_RE) || []).map(normDate));
  t = t.replace(DATE_RE, ' ');
  const ids = new Set((t.match(ID_RE) || []).map((x) => x.toUpperCase()));
  t = t.replace(ID_RE, ' ');
  const nums = [];
  let m; NUM_RE.lastIndex = 0;
  while ((m = NUM_RE.exec(t)) !== null) {
    const cls = m[1] ? '$' : m[3] ? '%' : m[2].includes('.') ? 'dec' : 'int';
    const noun = (cls === 'int' && m[4] && !FUNCTION_WORDS.has(m[4].toLowerCase()) && m[4].length > 2) ? stem(m[4]) : '';
    nums.push({ n: normNum(m[2]), cls, noun });
  }
  return { dates, ids, nums };
}

// The facts a sentence may draw on: the inventory plus each fact line's own text (to confirm a count's unit).
function factInventory(facts) {
  const lines = (facts || []).map((f) => prep(f).toLowerCase());
  const inv = inventory((facts || []).join('\n'));
  inv.text = (facts || []).map((f) => prep(f).toLowerCase()).join(' ');
  inv.lines = (facts || []).map((f) => ({ inv: inventory(f), text: prep(f).toLowerCase() }));
  return inv;
}

// -> { ok:boolean, why:string }
function checkSentence(sentence, inv) {
  if (NUMBER_WORDS.test(sentence)) return { ok: false, why: 'spells out a quantity in words' };
  // opinion words must come from the facts
  const opinions = String(sentence).match(OPINION_WORDS) || [];
  for (const w of opinions) {
    const root = w.toLowerCase().replace(/(ing|ed|es|s|ly)$/, '');
    if (!inv.text.includes(root.length >= 4 ? root : w.toLowerCase())) return { ok: false, why: 'opinion or prediction not in the facts: ' + w };
  }
  const s = inventory(sentence);
  for (const d of s.dates) if (!inv.dates.has(d)) return { ok: false, why: 'date not in the facts: ' + d };
  for (const i of s.ids) if (!inv.ids.has(i)) return { ok: false, why: 'record id not in the facts: ' + i };
  for (const x of s.nums) {
    // the same number, of the same kind ($, %, decimal or whole), in a fact line
    const lines = inv.lines.filter((l) => l.inv.nums.some((y) => y.n === x.n && y.cls === x.cls));
    if (!lines.length) return { ok: false, why: 'number not in the facts: ' + x.n + (x.cls === '%' ? '%' : '') };
    // a count used with a unit ("3 weeks") needs that unit in a line that has the number
    if (x.noun && !lines.some((l) => l.text.includes(x.noun))) return { ok: false, why: 'number used with a unit the facts do not give it: ' + x.n + ' ' + x.noun };
  }
  return { ok: true, why: '' };
}

// A suggested next step { who, what, when } is kept only if: "who" is "Owner not recorded" or a name that appears in
// the facts; "when" is empty or a date that appears in the facts; and "what" is short and passes the same number /
// date / record-ID / opinion check as an analysis sentence.
function verifyStep(step, facts) {
  if (!step || typeof step !== 'object') return null;
  const who = String(step.who == null ? '' : step.who).replace(/\s+/g, ' ').trim();
  const what = String(step.what == null ? '' : step.what).replace(/\s+/g, ' ').trim();
  const when = String(step.when == null ? '' : step.when).trim();
  if (!who || !what || what.split(' ').length > 24) return null;
  const inv = factInventory(facts);
  if (who.toLowerCase() !== 'owner not recorded' && !inv.text.includes(who.toLowerCase())) return null;
  if (when) {
    if (!DATE_RE.test(when)) { DATE_RE.lastIndex = 0; return null; }
    DATE_RE.lastIndex = 0;
    if (!inv.dates.has(normDate(when.match(DATE_RE)[0]))) return null;
    DATE_RE.lastIndex = 0;
  }
  if (!checkSentence(what, inv).ok) return null;
  return { who, what, when };
}

function verifyAnalysis(text, facts) {
  const inv = factInventory(facts);
  const clean = String(text || '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
  const sentences = clean.split(/(?<=[.!?])\s+/).filter(Boolean);
  const kept = [], dropped = [];
  sentences.forEach((s) => { const r = checkSentence(s, inv); if (r.ok) kept.push(s); else dropped.push({ sentence: s, why: r.why }); });
  return { text: kept.join(' '), dropped };
}

// ---- prompt
const SYSTEM = [
  'You write the "Analysis" line for each section of an executive project status report, for a C-level reader.',
  'For every SECTION you get an executive QUESTION and the FACTS the report shows for it. Answer the question in 2 to 3 sentences (at most 60 words): the direct answer first, then the one or two facts that most directly support it.',
  'STRICT RULES.',
  '1. Use ONLY the facts given. Every number, date and record ID you write must be copied exactly as written in the facts. Never compute, round, convert, combine or estimate a figure (write $1,290,000, never $1.29M; never add or subtract two facts).',
  '2. Write numbers as digits, never as words.',
  '3. Do not state causes, intentions, plans, actions or mitigations that the facts do not state. Where a fact only shows a status, describe the status, not a reason.',
  '3b. No opinions, predictions or evaluations: never say something is likely, at risk, concerning, healthy, low, significant, improving, deteriorating or the like, never give a confidence level, and never say what will or may happen — unless the facts themselves use that very word. Say what the facts show and make only plain comparisons between figures they give (above, below, earlier, later, behind, overdue, blocked, pending).',
  '4. Make no recommendation unless a fact shows a decision or approval is pending, and then only say that it is pending.',
  '5. If the facts are not enough to answer, write exactly: There is not enough data to assess this.',
  '6. Plain business English, no markdown, no bullet points, no record jargon.',
  'For every entry under NEXT-STEP FACTS, suggest up to 3 NEXT STEPS as {"who","what","when"}: "who" must be a person, role or team that is named in its facts, copied exactly, or exactly "Owner not recorded"; "what" is a short instruction (at most 15 words) that acts on an item listed in the facts and uses only figures, dates and IDs from them; "when" is a date copied from the facts, or an empty string. Never invent an item, a person or a date. Prefer the first item listed as "Start here", and items that are blocked, late or highest rated.',
  'Reply with ONLY a JSON object: {"sections": {"<section id>": "<analysis text>", ...}, "nextSteps": {"<section id>": [{"who":"","what":"","when":""}, ...]}} with one entry per id given in SECTIONS and one per id given in NEXT-STEP FACTS.'
].join('\n');

function buildPrompt(projectName, sections, charts) {
  return 'PROJECT: ' + String(projectName || 'the project').slice(0, 120) + '\n\nSECTIONS:\n' +
    JSON.stringify(sections.map((s) => ({ id: s.id, question: s.question, facts: s.facts }))) +
    ((charts && charts.length) ? '\n\nNEXT-STEP FACTS:\n' + JSON.stringify(charts.map((c) => ({ id: c.id, facts: c.facts }))) : '');
}

function extractJson(text) {
  const fenced = String(text || '').match(/```(?:json)?\s*([\s\S]*?)```/i);
  const c = fenced ? fenced[1] : String(text || '');
  const a = c.indexOf('{'), b = c.lastIndexOf('}');
  if (a === -1 || b === -1) return null;
  try { return JSON.parse(c.slice(a, b + 1)); } catch (e) { return null; }
}

function cleanInput(data) {
  const raw = Array.isArray(data && data.sections) ? data.sections : [];
  if (!raw.length || raw.length > MAX_SECTIONS) throw new ReportError('invalid-argument', 'A list of report sections is required.');
  const seen = new Set();
  return raw.map((s) => {
    const id = String(s && s.id || '');
    if (!SECTION_IDS.includes(id) || seen.has(id)) throw new ReportError('invalid-argument', 'Unknown or repeated section: ' + id);
    seen.add(id);
    const facts = (Array.isArray(s.facts) ? s.facts : []).map((f) => String(f == null ? '' : f).replace(/\s+/g, ' ').trim().slice(0, MAX_FACT_CHARS)).filter(Boolean).slice(0, MAX_FACTS);
    return { id, question: String(s.question || '').slice(0, 300), facts };
  }).filter((s) => s.facts.length);
}

function cleanCharts(data) {
  const raw = Array.isArray(data && data.charts) ? data.charts : [];
  const seen = new Set();
  return raw.slice(0, 12).map((c) => {
    const id = String(c && c.id || '');
    if (!CHART_IDS.includes(id) || seen.has(id)) throw new ReportError('invalid-argument', 'Unknown or repeated section: ' + id);
    seen.add(id);
    const facts = (Array.isArray(c.facts) ? c.facts : []).map((f) => String(f == null ? '' : f).replace(/\s+/g, ' ').trim().slice(0, MAX_FACT_CHARS)).filter(Boolean).slice(0, 30);
    return { id, facts };
  }).filter((c) => c.facts.length);
}

async function handleReportAnalysis({ db, auth, data, owners, apiKey, fetchImpl, now = new Date() }) {
  if (!auth || !auth.uid) throw new ReportError('unauthenticated', 'Please sign in.');
  const isOwner = owners.includes(String((auth.token && auth.token.email) || '').toLowerCase());
  const bizKey = data && data.bizKey, projKey = data && data.projKey;
  if (typeof bizKey !== 'string' || !bizKey || typeof projKey !== 'string' || !projKey) throw new ReportError('invalid-argument', 'A company and project are required.');
  if (!apiKey || String(apiKey).indexOf('PLACEHOLDER') !== -1) throw new ReportError('failed-precondition', 'The AI assistant is not configured yet.');
  const hasSections = !!(data && Array.isArray(data.sections) && data.sections.length), hasCharts = !!(data && Array.isArray(data.charts) && data.charts.length);
  if (!hasSections && !hasCharts) throw new ReportError('invalid-argument', 'A list of report sections is required.');
  const sections = hasSections ? cleanInput(data) : [];
  const charts = cleanCharts(data);
  if (!sections.length && !charts.length) return { sections: {}, nextSteps: {} };

  const projRef = db.collection('businesses').doc(bizKey).collection('projects').doc(projKey);
  const projSnap = await projRef.get();
  if (!projSnap.exists) throw new ReportError('not-found', 'That project was not found.');
  const perms = (projSnap.data() || {}).reportPermissions || {};
  let role = 'owner';
  if (!isOwner) {
    const m = await projRef.collection('members').doc(auth.uid).get();
    if (!m.exists) throw new ReportError('permission-denied', 'You are not a member of this project.');
    role = (m.data() || {}).role;
    if (!(perms.statusReportAction && perms.statusReportAction[role] === true)) throw new ReportError('permission-denied', 'Your role has not been given access to the Status Report.');
    if (!resolveStyle({ isOwner: false, role, perms, requested: 'executive' }).allowExecutive) throw new ReportError('permission-denied', 'Your role does not have the executive wording.');
  }

  // per-user daily cap, counted in the same place as Ask the Project
  const usageRef = projRef.collection('aiUsage').doc(auth.uid + '_' + now.toISOString().slice(0, 10));
  await db.runTransaction(async (tx) => {
    const s = await tx.get(usageRef), n = s.exists ? (s.data().count || 0) : 0;
    if (n >= (isOwner ? 300 : 60)) throw new ReportError('resource-exhausted', 'You have reached today\'s AI limit. Try again tomorrow.');
    tx.set(usageRef, { count: n + 1, uid: auth.uid, email: String((auth.token && auth.token.email) || '').toLowerCase(), day: now.toISOString().slice(0, 10) });
  });

  const resp = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 4000, thinking: { type: 'disabled' }, system: SYSTEM, messages: [{ role: 'user', content: buildPrompt(data.projectName, sections, charts) }] })
  });
  if (!resp.ok) {
    let detail = ''; try { detail = (await resp.text()).slice(0, 300); } catch (e) { /* ignore */ }
    const err = new ReportError('internal', 'The AI service could not answer right now.'); err.detail = 'HTTP ' + resp.status + ' ' + detail; throw err;
  }
  const body = await resp.json();
  const text = ((body && body.content) || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  const parsed = extractJson(text);
  if (!parsed || (sections.length && (typeof parsed.sections !== 'object' || !parsed.sections))) throw new ReportError('internal', 'The AI service returned an unexpected answer.');

  const out = {};
  sections.forEach((s) => {
    const v = verifyAnalysis(parsed.sections[s.id], s.facts);
    out[s.id] = { analysis: v.text, dropped: v.dropped.length, checked: true };
  });
  const nextSteps = {};
  charts.forEach((c) => {
    const arr = parsed.nextSteps && Array.isArray(parsed.nextSteps[c.id]) ? parsed.nextSteps[c.id] : [];
    nextSteps[c.id] = arr.slice(0, 3).map((st) => verifyStep(st, c.facts)).filter(Boolean);
  });
  return { sections: out, nextSteps, role };
}

module.exports = { handleReportAnalysis, ReportError, verifyAnalysis, verifyStep, checkSentence, inventory, buildPrompt, SYSTEM, SECTION_IDS, MODEL };
