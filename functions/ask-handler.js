'use strict';
/* ============================================================================
   ask-handler.js — the logic behind the askProject Cloud Function, written with
   its dependencies injected (db, fetch, clock) so its security properties can be
   tested with a fake database and a fake AI endpoint:

     - only a signed-in owner or member of THIS project can ask
     - a non-owner also needs the "Ask the Project" grant in the Permissions matrix
     - documents are limited to those whose allowedRoles include the asker's role
     - live data is limited to cards the asker's role can view
     - a per-user daily cap protects the API bill
     - the AI only ever receives the context that passed those filters
   ============================================================================ */

const lib = require('./ask-lib');
const { resolveStyle } = require('./exec-style');

const MODEL = 'claude-sonnet-5';
const DAILY_CAP = 60;
const OWNER_DAILY_CAP = 300;
const MAX_LIST = 400;
const DATA_BLOCK_WORDS = 5000;

class AskError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const isPlaceholder = (v) => !v || String(v).indexOf('PLACEHOLDER') !== -1;

async function handleAsk({ db, auth, data, owners, apiKey, fetchImpl, now = new Date() }) {
  if (!auth || !auth.uid) throw new AskError('unauthenticated', 'Please sign in.');
  const email = String((auth.token && auth.token.email) || '').toLowerCase();
  const isOwner = owners.includes(email);

  const bizKey = data && data.bizKey, projKey = data && data.projKey;
  const question = String((data && data.question) || '').trim();
  if (typeof bizKey !== 'string' || !bizKey || typeof projKey !== 'string' || !projKey) throw new AskError('invalid-argument', 'A company and project are required.');
  if (question.length < 3) throw new AskError('invalid-argument', 'Please type a question.');
  if (question.length > 1000) throw new AskError('invalid-argument', 'Please keep the question under 1,000 characters.');
  if (isPlaceholder(apiKey)) throw new AskError('failed-precondition', 'The AI assistant is not configured yet.');

  const projRef = db.collection('businesses').doc(bizKey).collection('projects').doc(projKey);
  const projSnap = await projRef.get();
  if (!projSnap.exists) throw new AskError('not-found', 'That project was not found.');
  const project = projSnap.data() || {};
  const perms = project.reportPermissions || {};

  // ---- who is asking, and may they?
  let role = 'owner';
  if (!isOwner) {
    const m = await projRef.collection('members').doc(auth.uid).get();
    if (!m.exists) throw new AskError('permission-denied', 'You are not a member of this project.');
    role = (m.data() || {}).role;
    if (!(perms.askProjectAction && perms.askProjectAction[role] === true)) {
      throw new AskError('permission-denied', 'Your role has not been given access to Ask the Project.');
    }
  }
  const canView = (card) => isOwner || !!(perms[card] && perms[card][role] === true);
  // the wording this role may have: executive (short, C-level) and/or the current detailed one
  const wording = resolveStyle({ isOwner, role, perms, requested: data.style });

  // ---- daily cap (counts attempts, so a stuck client can't loop)
  const dayKey = now.toISOString().slice(0, 10);
  const usageRef = projRef.collection('aiUsage').doc(auth.uid + '_' + dayKey);
  const cap = isOwner ? OWNER_DAILY_CAP : DAILY_CAP;
  await db.runTransaction(async (tx) => {
    const s = await tx.get(usageRef);
    const n = s.exists ? (s.data().count || 0) : 0;
    if (n >= cap) throw new AskError('resource-exhausted', 'You have reached today\'s limit of ' + cap + ' questions. Try again tomorrow.');
    tx.set(usageRef, { count: n + 1, uid: auth.uid, email, day: dayKey });
  });

  // ---- documents this role may read
  const docsQuery = isOwner ? projRef.collection('documents') : projRef.collection('documents').where('allowedRoles', 'array-contains', role);
  const docsSnap = await docsQuery.get();
  const docs = docsSnap.docs.map((d) => Object.assign({ id: d.id }, d.data()));
  const sections = [];
  if (docs.length) {
    const textSnaps = await db.getAll(...docs.map((d) => projRef.collection('documentText').doc(d.id)));
    textSnaps.forEach((snap, i) => {
      if (!snap.exists) return;
      const d = docs[i];
      const label = [d.number, d.title, d.version ? 'v' + d.version : ''].filter(Boolean).join(' ');
      // `idx` is the section's position in the document's stored section list — the viewer re-reads the
      // original file with the same extractor, so the same index points at the same section.
      ((snap.data() || {}).sections || []).forEach((s, idx) => sections.push({
        title: s.title, text: s.text, words: s.words, idx: idx,
        docId: d.id, docLabel: label, docTitle: d.title || '', phase: d.phase || '', ext: d.ext || ''
      }));
    });
  }

  // ---- live data, only for cards this role can view
  const wanted = new Set();
  Object.keys(lib.SNAPSHOT_COLLECTIONS).forEach((card) => { if (canView(card)) lib.SNAPSHOT_COLLECTIONS[card].forEach((c) => wanted.add(c)); });
  const lists = {};
  await Promise.all(Array.from(wanted).map(async (c) => {
    const s = await projRef.collection(c).limit(MAX_LIST).get();
    lists[c] = s.docs.map((d) => Object.assign({ id: d.id }, d.data()));
  }));
  const blocks = lib.formatSnapshot({ project, lists }, canView);

  // ---- retrieval: best document sections, and the most relevant data blocks
  const history = Array.isArray(data.history) ? data.history : [];
  const query = lib.effectiveQuery(question, history);
  const ranked = lib.search(lib.buildIndex(sections), query, 40);
  const picked = lib.pickContext(sections, ranked);
  const overview = blocks[0], dataOnly = blocks.slice(1);
  const bRanked = lib.search(lib.buildIndex(dataOnly.map((b) => ({ title: b.label, text: b.text }))), query, 6);
  const dataBlocks = [overview];
  let dataWords = 0;
  bRanked.forEach((r) => {
    const b = dataOnly[r.i], w = b.text.split(/\s+/).length;
    if (dataWords + w > DATA_BLOCK_WORDS && dataBlocks.length > 1) return;
    dataBlocks.push(b); dataWords += w;
  });

  const prompt = lib.buildPrompt({ project: project.name, question, history, sections: picked, dataBlocks, style: wording.style });

  // ---- ask the model
  const resp = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(Object.assign({ model: MODEL, max_tokens: 1500, system: prompt.system, messages: prompt.messages },
      // the short executive answer needs no extended thinking (it could use the whole budget and return no text)
      wording.style === 'executive' ? { thinking: { type: 'disabled' } } : {}))
  });
  if (!resp.ok) {
    let detail = ''; try { detail = (await resp.text()).slice(0, 300); } catch (e) { /* ignore */ }
    const err = new AskError('internal', 'The AI service could not answer right now. Please try again.');
    err.detail = 'HTTP ' + resp.status + ' ' + detail;
    throw err;
  }
  const body = await resp.json();
  const answer = ((body && body.content) || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
  if (!answer) throw new AskError('internal', 'The AI service returned an empty answer. Please try again.');

  return {
    answer,
    sources: lib.citedSources(answer, prompt.sources),
    style: wording.style,
    stats: { documents: docs.length, sections: picked.length, dataSets: dataBlocks.length - 1, role }
  };
}

module.exports = { handleAsk, AskError, MODEL, DAILY_CAP, OWNER_DAILY_CAP };
