'use strict';
/* ============================================================================
   discrepancy-handler.js — the logic behind the discrepancyAnalysis Cloud
   Function: an expert-business-analyst pass over the WHOLE project, checking
   the portal's own card data against the team's uploaded documents, and
   against itself (card vs. card), for real contradictions — not gaps,
   not "not started yet," only two things that state something different
   about the same real-world fact.

   Owner-only, end to end (unlike Ask the Project, there is no per-role
   grant — this report itself is owner-only per firestore.rules's
   discrepancyReports block, so the analysis that feeds it is too).

   Reuses ask-lib.js's exact document-section and live-card-data gathering
   (formatSnapshot/PARTS/SNAPSHOT_COLLECTIONS) — the SAME "portal depiction"
   Ask the Project already reads — so a discrepancy finding can never point
   at data the dashboard doesn't actually show. Every finding must cite
   1-4 of the numbered context items it rests on ("refs"); any finding
   whose refs don't resolve to a real context item is dropped before the
   result ever reaches the client — the same "never show an unchecked claim"
   discipline report-analysis.js uses for the Status Report.
   ============================================================================ */

const lib = require('./ask-lib');

const MODEL = 'claude-sonnet-5';
const MAX_FINDINGS = 60;
const DOC_WORD_BUDGET = 30000;   // generous vs. Ask the Project's 7500 — this pass wants full coverage, not just the top-ranked sections
const MAX_SECTIONS = 220;
const DATA_WORD_BUDGET = 20000;

class DiscrepancyError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const isPlaceholder = (v) => !v || String(v).indexOf('PLACEHOLDER') !== -1;
const clip = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

const SYSTEM = [
  'You are an expert business analyst auditing a project-management portal for consistency.',
  'You are given numbered CONTEXT items of two kinds: DOCUMENT sections (excerpts of files the team uploaded) and PORTAL DATA blocks (what the dashboard currently shows, card by card, drawn from live records).',
  'Find real DISCREPANCIES only: two context items that state something DIFFERENT about the SAME real-world fact — a number, date, name, decision, status, or figure that disagrees between (a) a document and the portal data, or (b) one portal data block and another.',
  'Do NOT report something merely being absent, incomplete, not yet started, or not mentioned somewhere — that is not a discrepancy, it is just missing information. Do NOT invent a discrepancy the context does not actually show. When in doubt, leave it out.',
  'For every discrepancy, cite the numbered context items it rests on as "refs": an array of 1 to 4 of the exact numbers given. Never invent a number that was not shown to you.',
  'Reply with ONLY a JSON object: {"findings":[{"summary":"one sentence naming the conflict","detail":"2-4 sentences: what each side says, plainly, quoting the figures/words exactly as given","severity":"high"|"medium"|"low","refs":[n,n]}]}. Order findings most severe first (high = contradicts budget/schedule/scope/safety-relevant facts; low = wording/minor figure drift). If you find nothing, reply {"findings":[]}.'
].join('\n');

function extractJson(text) {
  const fenced = String(text || '').match(/```(?:json)?\s*([\s\S]*?)```/i);
  const c = fenced ? fenced[1] : String(text || '');
  const a = c.indexOf('{'), b = c.lastIndexOf('}');
  if (a === -1 || b === -1) return null;
  try { return JSON.parse(c.slice(a, b + 1)); } catch (e) { return null; }
}

// Same numbered-context shape ask-lib.js's buildPrompt uses for Ask the Project
// (sources[n-1] describes context item n) — reused here so the frontend's
// jump-to-card / jump-to-document links work identically to the Evidence panel.
function buildContext(sections, dataBlocks) {
  const sources = [], parts = [];
  let words = 0;
  for (const s of sections) {
    if (sources.length >= MAX_SECTIONS) break;
    const w = s.words || String(s.text || '').split(/\s+/).length;
    if (words + w > DOC_WORD_BUDGET && sources.length) continue;
    words += w;
    sources.push({
      n: sources.length + 1, kind: 'document', docId: s.docId, docLabel: s.docLabel, docTitle: s.docTitle || '', phase: s.phase || '', ext: s.ext || '',
      sectionIndex: s.idx, sectionTitle: s.title, excerpt: clip(s.text.split('\n').slice(1).join(' '), 400)
    });
    parts.push('[' + sources.length + '] DOCUMENT: ' + s.docLabel + (s.phase ? ' (' + s.phase + ')' : '') + ' — section "' + s.title + '"\n' + s.text);
  }
  let dataWords = 0;
  for (const b of dataBlocks) {
    const w = String(b.text || '').split(/\s+/).length;
    if (dataWords + w > DATA_WORD_BUDGET && sources.length) continue;
    dataWords += w;
    sources.push({ n: sources.length + 1, kind: 'data', card: b.card || '', label: 'Portal data — ' + b.label.split(' (')[0], excerpt: clip(b.text, 400) });
    parts.push('[' + sources.length + '] PORTAL DATA: ' + b.label + '\n' + b.text);
  }
  return { context: parts.join('\n\n'), sources };
}

async function handleDiscrepancyAnalysis({ db, auth, data, owners, apiKey, fetchImpl, now = new Date() }) {
  if (!auth || !auth.uid) throw new DiscrepancyError('unauthenticated', 'Please sign in.');
  const email = String((auth.token && auth.token.email) || '').toLowerCase();
  if (!owners.includes(email)) throw new DiscrepancyError('permission-denied', 'Only the Owner can run the Discrepancy Report.');

  const bizKey = data && data.bizKey, projKey = data && data.projKey;
  if (typeof bizKey !== 'string' || !bizKey || typeof projKey !== 'string' || !projKey) throw new DiscrepancyError('invalid-argument', 'A company and project are required.');
  if (isPlaceholder(apiKey)) throw new DiscrepancyError('failed-precondition', 'The AI assistant is not configured yet.');

  const projRef = db.collection('businesses').doc(bizKey).collection('projects').doc(projKey);
  const projSnap = await projRef.get();
  if (!projSnap.exists) throw new DiscrepancyError('not-found', 'That project was not found.');
  const project = projSnap.data() || {};

  // per-owner daily cap, same mechanism/table as Ask the Project and the Status Report
  const dayKey = now.toISOString().slice(0, 10);
  const usageRef = projRef.collection('aiUsage').doc(auth.uid + '_' + dayKey);
  await db.runTransaction(async (tx) => {
    const s = await tx.get(usageRef);
    const n = s.exists ? (s.data().count || 0) : 0;
    if (n >= 300) throw new DiscrepancyError('resource-exhausted', 'You have reached today\'s AI usage limit. Try again tomorrow.');
    tx.set(usageRef, { count: n + 1, uid: auth.uid, email, day: dayKey });
  });

  // ---- every uploaded document (owner sees all, no role filter — this report is owner-only)
  const docsSnap = await projRef.collection('documents').get();
  const docs = docsSnap.docs.map((d) => Object.assign({ id: d.id }, d.data()));
  const sections = [];
  if (docs.length) {
    const textSnaps = await db.getAll(...docs.map((d) => projRef.collection('documentText').doc(d.id)));
    textSnaps.forEach((snap, i) => {
      if (!snap.exists) return;
      const d = docs[i];
      const label = [d.number, d.title, d.version ? 'v' + d.version : ''].filter(Boolean).join(' ');
      ((snap.data() || {}).sections || []).forEach((s, idx) => sections.push({
        title: s.title, text: s.text, words: s.words, idx: idx,
        docId: d.id, docLabel: label, docTitle: d.title || '', phase: d.phase || '', ext: d.ext || ''
      }));
    });
  }

  // ---- every card's live data (owner sees all)
  const canView = () => true;
  const wanted = new Set();
  Object.keys(lib.SNAPSHOT_COLLECTIONS).forEach((card) => { lib.SNAPSHOT_COLLECTIONS[card].forEach((c) => wanted.add(c)); });
  const lists = {};
  await Promise.all(Array.from(wanted).map(async (c) => {
    const s = await projRef.collection(c).limit(400).get();
    lists[c] = s.docs.map((d) => Object.assign({ id: d.id }, d.data()));
  }));
  // Risk Reserve's total (a fixed-id doc, not a plain list) — appended as its own tiny block.
  const reserveSnap = await projRef.collection('riskReserve').doc('main').get();
  const dataBlocks = lib.formatSnapshot({ project, lists }, canView);
  if (reserveSnap.exists && typeof reserveSnap.data().totalAmount === 'number') {
    dataBlocks.push({ label: 'Risk Reserve total (from the Risk Reserve card)', text: 'Total contingency reserve: ' + reserveSnap.data().totalAmount, card: 'riskReserveCard' });
  }

  const { context, sources } = buildContext(sections, dataBlocks);
  if (sources.length < 2) return { findings: [], sources: [], stats: { documents: docs.length, sections: sections.length, dataBlocks: dataBlocks.length } };

  const resp = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL, max_tokens: 8000,
      system: SYSTEM,
      messages: [{ role: 'user', content: 'PROJECT: ' + (project.name || 'this project') + '\n\nCONTEXT:\n\n' + context + '\n\nFind the discrepancies.' }]
    })
  });
  if (!resp.ok) {
    let detail = ''; try { detail = (await resp.text()).slice(0, 300); } catch (e) { /* ignore */ }
    const err = new DiscrepancyError('internal', 'The AI service could not complete the analysis right now. Please try again.');
    err.detail = 'HTTP ' + resp.status + ' ' + detail;
    throw err;
  }
  const body = await resp.json();
  const text = ((body && body.content) || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  const parsed = extractJson(text);
  if (!parsed || !Array.isArray(parsed.findings)) throw new DiscrepancyError('internal', 'The AI service returned an unexpected answer.');

  // Mechanical honesty check: a finding whose refs don't resolve to a real, numbered
  // context item is dropped, never shown — same discipline as report-analysis.js's
  // fact-checker, just against "does this citation exist" rather than a text inventory.
  const SEVERITIES = new Set(['high', 'medium', 'low']);
  const findings = parsed.findings.slice(0, MAX_FINDINGS).map((f, i) => {
    if (!f || typeof f !== 'object') return null;
    const summary = clip(f.summary, 300), detail = clip(f.detail, 900);
    if (!summary || !detail) return null;
    const severity = SEVERITIES.has(f.severity) ? f.severity : 'medium';
    const refs = (Array.isArray(f.refs) ? f.refs : []).map((n) => parseInt(n, 10)).filter((n) => n >= 1 && n <= sources.length);
    if (!refs.length) return null;
    const locations = refs.map((n) => sources[n - 1]);
    return { id: 'f' + (i + 1), summary, detail, severity, locations, fixed: false, fixedAt: null, fixedBy: '' };
  }).filter(Boolean);

  findings.sort((a, b) => { const order = { high: 0, medium: 1, low: 2 }; return order[a.severity] - order[b.severity]; });

  return { findings, stats: { documents: docs.length, sections: sections.length, dataBlocks: dataBlocks.length, contextItems: sources.length } };
}

module.exports = { handleDiscrepancyAnalysis, DiscrepancyError, MODEL };
