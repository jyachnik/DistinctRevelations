/**
 * Cloud Functions for Distinct Revelations.
 *
 * notifyOwnerOnNewMember: fires whenever a new member document is created
 * at businesses/{biz}/users/{uid} (see Public/JS/signup.js). If the member
 * being added is NOT the founding member of a brand-new business — i.e. the
 * business already had at least one other member — an SMS is sent to the
 * owner's phone so they're aware someone joined an existing company and can
 * follow up/approve. Signup itself is never blocked by this; it's a
 * fire-and-forget notification after the fact.
 *
 * notifyOwnerOnNewQuestion: fires on a new Q&A item (Public/JS/qna.js)
 * whose type is 'question' — texts the business's own Notification Phone
 * Number (Settings ▸ Notification Phone Number, Public/JS/notification-
 * settings.js — a separate Firestore field from OWNER_PHONE_NUMBER below,
 * kept distinct per explicit request).
 *
 * sendOverdueDigest: a daily scheduled scan across every business for
 * overdue Meetings/Events, Activity Log items, Issue Log items, and
 * high-severity Risk Register entries with no response yet — one SMS per
 * business per day, to that same Notification Phone Number.
 */

const { onDocumentCreated, onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineString } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const twilio = require('twilio');
const sgMail = require('@sendgrid/mail');

initializeApp();

// --- Configuration (placeholders until real values are provided) ----------
// Set real values with, e.g.:
//   firebase functions:config:env:set ... (classic)
// or, for 2nd-gen params, create functions/.env / .env.<project-id> with:
//   TWILIO_ACCOUNT_SID=...
//   TWILIO_AUTH_TOKEN=...
//   TWILIO_FROM_NUMBER=+1...
//   OWNER_PHONE_NUMBER=+1...
// See functions/.env.example.
const TWILIO_ACCOUNT_SID = defineString('TWILIO_ACCOUNT_SID', { default: 'PLACEHOLDER_ACCOUNT_SID' });
const TWILIO_AUTH_TOKEN = defineString('TWILIO_AUTH_TOKEN', { default: 'PLACEHOLDER_AUTH_TOKEN' });
const TWILIO_FROM_NUMBER = defineString('TWILIO_FROM_NUMBER', { default: '+10000000000' });
// Placeholder — the real owner phone number hasn't been provided yet.
const OWNER_PHONE_NUMBER = defineString('OWNER_PHONE_NUMBER', { default: '+10000000000' });
// Master off-switch for EVERY text message (new member, new question, daily
// overdue digest — they all send through sendOwnerSms below). Anything other
// than the exact value 'true' means "don't send" — set SMS_ENABLED=false in
// functions/.env while testing so no Twilio charges are incurred, then set it
// back to true (or remove the line) and redeploy the three SMS functions.
const SMS_ENABLED = defineString('SMS_ENABLED', { default: 'true' });

// Team Directory "send email" (Public/JS/team-directory.js). Get an API key at
// https://app.sendgrid.com — SENDGRID_FROM_EMAIL must be a verified sender
// identity in that account. See functions/.env.example.
const SENDGRID_API_KEY = defineString('SENDGRID_API_KEY', { default: 'PLACEHOLDER_SENDGRID_KEY' });
const SENDGRID_FROM_EMAIL = defineString('SENDGRID_FROM_EMAIL', { default: 'PLACEHOLDER_SENDGRID_FROM_EMAIL' });
// Master off-switch for the Team Directory's "send email" feature, same
// pattern as SMS_ENABLED — anything other than 'true' means "don't send".
const EMAIL_ENABLED = defineString('EMAIL_ENABLED', { default: 'false' });

function isPlaceholder(value) {
  return !value || value.indexOf('PLACEHOLDER') !== -1 || value.indexOf('0000000000') !== -1;
}

// Wraps @sendgrid/mail behind the { to, subject, text } shape team-email-handler.js expects,
// so the handler never needs to know which provider is behind it (same DI pattern as ask-handler's
// injected fetchImpl). Throws on anything that should count as a per-recipient failure.
function makeSendGridSender(apiKey, fromEmail, enabledFlag) {
  return async function sendMail({ to, subject, text }) {
    if (String(enabledFlag).trim().toLowerCase() !== 'true') {
      logger.info('sendTeamEmail: email is switched off (EMAIL_ENABLED is not "true") — not sending.', { to: to });
      throw new Error('Email sending is currently disabled.');
    }
    if (isPlaceholder(apiKey) || isPlaceholder(fromEmail)) {
      logger.warn('sendTeamEmail: SendGrid is not configured yet — not sending.', { to: to });
      throw new Error('Email is not configured yet.');
    }
    sgMail.setApiKey(apiKey);
    await sgMail.send({ to: to, from: fromEmail, subject: subject, text: text });
  };
}

// --- AI Project Analysis -----------------------------------------------
// Owner-triggered ("Run Analysis" button, see Public/JS/ai-analysis.js) —
// NOT automatic — since this reads across every import in the project and
// costs more per call than a single-card rephrase. Two layers of ground
// truth go into the prompt: (1) cardFacts — the exact rule-based sentences
// each card already computes and shows (deterministic, always correct —
// the model is told to preserve every number in these, not recompute
// them), and (2) trimmed raw records from every collection, so the model
// can cross-reference things no single card's formula looks at (e.g. a
// risk's impact area matching an over-allocated resource, a constraint
// that blocks a milestone that's about to slip). Get a key at
// https://console.anthropic.com — set it in functions/.env (or
// functions/.env.<project-id>) as ANTHROPIC_API_KEY, see .env.example.
const ANTHROPIC_API_KEY = defineString('ANTHROPIC_API_KEY', { default: 'PLACEHOLDER_ANTHROPIC_KEY' });

// Mirrors Public/JS/app-config.js's APP_CONFIG.OWNERS — this app has one
// global list of Owner emails across every business, not a per-business
// owner field, so that's the same check used everywhere else client-side.
// Keep these two lists in sync by hand.
const OWNERS = ['john@distinctrevelations.com', 'second.owner@example.com'];

// Raised from an earlier 6000 — the dashboard has grown to ~30 cards each
// contributing their own insight-text sentence(s) to cardFacts (Critical
// Path, Top Slipped Tasks, Forecast Finish Date, Risk Exposure Trend,
// Issue Log, etc. all added after that original cap was set), and real
// usage started tripping "cardFacts payload too large" well before
// anything was actually wrong. This is just a sanity ceiling against a
// truly pathological payload, not a tight budget — cardFacts is short
// per-card summaries, not the raw import data (see
// MAX_RECORDS_PER_COLLECTION below for that).
const MAX_CARD_FACTS_LENGTH = 20000;
// Raised from an earlier 40-row / 240-char cap — the whole point of this
// feature is cross-referencing the actual imports, and a heavily-shrunk
// sample was producing shallow, generic output. This app's realistic
// dataset sizes (dozens to a couple hundred rows per collection) are well
// within a single prompt's budget, so send close to everything instead.
const MAX_RECORDS_PER_COLLECTION = 500;
const MAX_FIELD_LENGTH = 2000;
// Noisy, app-generated fields that aren't part of the actual import and
// just bloat the prompt without adding analytical value.
const EXCLUDED_FIELDS = { changeLog: true };

function truncate(v) {
  if (v == null) return v;
  const s = String(v);
  return s.length > MAX_FIELD_LENGTH ? s.slice(0, MAX_FIELD_LENGTH) + '…' : s;
}

// Passes through every field of every row (up to MAX_RECORDS_PER_COLLECTION
// rows) rather than a hand-maintained field picklist — so a newly-imported
// column shows up here automatically instead of silently being invisible
// to the analysis until someone remembers to add it to a list. Firestore
// Timestamps become ISO strings; nested objects/arrays other than plain
// scalars are dropped (they're either noise like changeLog, or something
// too unstructured to usefully hand to the model as-is).
function trimRecords(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, MAX_RECORDS_PER_COLLECTION).map(function (r) {
    const out = {};
    Object.keys(r || {}).forEach(function (k) {
      if (EXCLUDED_FIELDS[k]) return;
      let v = r[k];
      if (v && typeof v.toDate === 'function') v = v.toDate().toISOString();
      if (v !== null && typeof v === 'object') return; // skip nested blobs
      if (typeof v === 'string') v = truncate(v);
      if (v !== undefined) out[k] = v;
    });
    // changeLog's full entries are excluded above as noise, but its mere
    // presence is a real signal (e.g. the Gantt card is asked to point at
    // recently-edited tasks) — keep a lightweight derived summary instead
    // of the raw array.
    if (Array.isArray(r && r.changeLog) && r.changeLog.length) {
      out.recentlyEdited = true;
      const last = r.changeLog[r.changeLog.length - 1];
      if (last && last.changedAt) {
        const when = last.changedAt.toDate ? last.changedAt.toDate() : new Date(last.changedAt);
        if (!isNaN(when.getTime())) out.lastEditedAt = when.toISOString();
      }
    }
    return out;
  });
}

// Everything is read from THIS project (businesses/{biz}/projects/{proj}) — the company-level
// document and collections are shared by every project (and, after the multi-project cutover,
// only mirror the 'default' project), so reading them analysed the wrong data.
async function loadProjectRecords(db, bizKey, projKey) {
  const projRef = db.collection('businesses').doc(bizKey).collection('projects').doc(projKey);
  const bizSnap = await projRef.get();
  const biz = (bizSnap.exists && bizSnap.data()) || {};

  const [milestonesSnap, activitiesSnap, qnaSnap, filesSnap] = await Promise.all([
    projRef.collection('milestones').get(),
    projRef.collection('activities').get(),
    projRef.collection('qna').get(),
    projRef.collection('files').get()
  ]);
  const toRows = function (snap) { return snap.docs.map(function (d) { return d.data() || {}; }); };

  const records = {
    risks: trimRecords(biz.riskRegister),
    assumptions: trimRecords(biz.assumptionsLog),
    constraints: trimRecords(biz.constraintsLog),
    defects: trimRecords(biz.qualityDefects),
    resourceRows: trimRecords(biz.resourceWeeklyRows && biz.resourceWeeklyRows.length ? biz.resourceWeeklyRows : biz.resourceRows),
    raci: biz.raciMatrix && Array.isArray(biz.raciMatrix.rows) ? { resources: biz.raciMatrix.resources || [], rows: trimRecords(biz.raciMatrix.rows) } : null,
    milestones: trimRecords(toRows(milestonesSnap)),
    activities: trimRecords(toRows(activitiesSnap)),
    qna: trimRecords(toRows(qnaSnap)),
    files: trimRecords(toRows(filesSnap)),
    projectStatus: biz.projectStatus || null,
    projectProgress: typeof biz.projectProgress === 'number' ? biz.projectProgress : null
  };

  // The PREVIOUS run's output (if any) — read here, before this call's own
  // write overwrites it — so the new analysis can check whether its prior
  // recommendations were actually followed. Only the parts relevant to
  // that comparison; cardText is just phrasing, not useful for this.
  const previousAnalysis = biz.aiAnalysis ? {
    generatedAt: biz.aiAnalysis.generatedAt && biz.aiAnalysis.generatedAt.toDate ? biz.aiAnalysis.generatedAt.toDate().toISOString() : null,
    executiveSummary: biz.aiAnalysis.executiveSummary || null,
    watchItems: biz.aiAnalysis.watchItems || null
  } : null;

  return { records, previousAnalysis };
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try { return JSON.parse(candidate.slice(start, end + 1)); } catch (e) { return null; }
}

// "Ask the Project" — a role-limited, cited Q&A over the project's imported
// documents and live card data. All the logic (and its security tests) lives in
// ask-handler.js; this is only the Cloud Functions wrapper.
const { handleAsk, AskError } = require('./ask-handler');
const { EXEC_MODEL, buildExecPrompt, sanitizeExecutive, sanitizeCardTextExec } = require('./exec-style');

// The C-level wording of an analysis: a separate call to a stronger model, isolated so that a failure
// here never loses the technical analysis (the result just has no executive layer until the next run).
async function generateExecutive(apiKey, cardFactsStr, records, analysis) {
  const none = { executive: null, cardTextExec: {} };
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: EXEC_MODEL, max_tokens: 8000,
        // no extended thinking: on a full project's records it spent the whole token budget and returned no text
        thinking: { type: 'disabled' },
        messages: [{ role: 'user', content: buildExecPrompt({ cardFactsStr, recordsStr: JSON.stringify(records), analysis }) }]
      })
    });
    if (!resp.ok) { logger.error('runProjectAnalysis: executive layer API error', { status: resp.status, errText: (await resp.text()).slice(0, 300) }); return none; }
    const json = await resp.json();
    const text = (json.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
    const parsed = extractJson(text);
    if (!parsed) { logger.error('runProjectAnalysis: executive layer unparseable', { text: text.slice(0, 500) }); return none; }
    return { executive: sanitizeExecutive(parsed.executive), cardTextExec: sanitizeCardTextExec(parsed.cardTextExec) };
  } catch (err) {
    logger.error('runProjectAnalysis: executive layer failed', err);
    return none;
  }
}
exports.askProject = onCall({ timeoutSeconds: 120, memory: '512MiB' }, async (request) => {
  try {
    return await handleAsk({
      db: getFirestore(), auth: request.auth, data: request.data, owners: OWNERS,
      apiKey: ANTHROPIC_API_KEY.value(), fetchImpl: fetch
    });
  } catch (err) {
    if (err instanceof AskError) {
      if (err.detail) logger.error('askProject: model call failed', { detail: err.detail });
      throw new HttpsError(err.code, err.message);
    }
    logger.error('askProject failed', err);
    throw new HttpsError('internal', 'Something went wrong while answering. Please try again.');
  }
});

// Team Directory "send email" — all the logic (and its security tests) lives in
// team-email-handler.js; this is only the Cloud Functions wrapper, same shape as askProject above.
const { handleSendTeamEmail, TeamEmailError } = require('./team-email-handler');
exports.sendTeamEmail = onCall({ timeoutSeconds: 60 }, async (request) => {
  try {
    return await handleSendTeamEmail({
      db: getFirestore(), auth: request.auth, data: request.data, owners: OWNERS,
      sendMail: makeSendGridSender(SENDGRID_API_KEY.value(), SENDGRID_FROM_EMAIL.value(), EMAIL_ENABLED.value())
    });
  } catch (err) {
    if (err instanceof TeamEmailError) throw new HttpsError(err.code, err.message);
    logger.error('sendTeamEmail failed', err);
    throw new HttpsError('internal', 'Could not send the email. Please try again.');
  }
});

// Status Report: the machine-checked "Analysis" line under each executive section (see report-analysis.js).
const { handleReportAnalysis, ReportError } = require('./report-analysis');
exports.reportAnalysis = onCall({ timeoutSeconds: 120, memory: '512MiB' }, async (request) => {
  try {
    return await handleReportAnalysis({
      db: getFirestore(), auth: request.auth, data: request.data, owners: OWNERS,
      apiKey: ANTHROPIC_API_KEY.value(), fetchImpl: fetch
    });
  } catch (err) {
    if (err instanceof ReportError) {
      if (err.detail) logger.error('reportAnalysis: model call failed', { detail: err.detail });
      throw new HttpsError(err.code, err.message);
    }
    logger.error('reportAnalysis failed', err);
    throw new HttpsError('internal', 'Something went wrong while writing the analysis.');
  }
});

// Discrepancy Report (Settings, owner-only) — an expert-business-analyst pass
// checking portal card data against uploaded documents, and against itself,
// for real contradictions. See discrepancy-handler.js.
const { handleDiscrepancyAnalysis, DiscrepancyError } = require('./discrepancy-handler');
exports.discrepancyAnalysis = onCall({ timeoutSeconds: 300, memory: '512MiB' }, async (request) => {
  try {
    return await handleDiscrepancyAnalysis({
      db: getFirestore(), auth: request.auth, data: request.data, owners: OWNERS,
      apiKey: ANTHROPIC_API_KEY.value(), fetchImpl: fetch
    });
  } catch (err) {
    if (err instanceof DiscrepancyError) {
      if (err.detail) logger.error('discrepancyAnalysis: model call failed', { detail: err.detail });
      throw new HttpsError(err.code, err.message);
    }
    logger.error('discrepancyAnalysis failed', err);
    throw new HttpsError('internal', 'Something went wrong while running the analysis. Please try again.');
  }
});

exports.runProjectAnalysis = onCall({ timeoutSeconds: 480 }, async (request) => {
  if (!request.auth || !request.auth.token || !OWNERS.includes((request.auth.token.email || '').toLowerCase())) {
    throw new HttpsError('permission-denied', 'Only the Owner can run project analysis.');
  }

  const bizKey = request.data && request.data.bizKey;
  // A page that hasn't been refreshed since this change doesn't send projKey yet; fall back to the
  // company's default project rather than failing (new pages always send the project being viewed).
  const projKey = (request.data && typeof request.data.projKey === 'string' && request.data.projKey) || 'default';
  const cardFacts = (request.data && request.data.cardFacts) || {};
  if (!bizKey || typeof bizKey !== 'string') {
    throw new HttpsError('invalid-argument', 'bizKey is required.');
  }
  const cardFactsStr = JSON.stringify(cardFacts);
  if (cardFactsStr.length > MAX_CARD_FACTS_LENGTH) {
    throw new HttpsError('invalid-argument', 'cardFacts payload too large.');
  }

  const apiKey = ANTHROPIC_API_KEY.value();
  if (isPlaceholder(apiKey)) {
    throw new HttpsError('failed-precondition', 'AI project analysis is not configured yet.');
  }

  const db = getFirestore();
  const { records, previousAnalysis } = await loadProjectRecords(db, bizKey, projKey);

  const prompt =
    'You are an experienced project management business analyst reviewing a client project ' +
    'dashboard. Below are up to three things: (1) CARD_FACTS — sentences already shown on the ' +
    'dashboard, computed deterministically and already correct; treat every number/name/date in ' +
    'them as ground truth, never contradict or recompute them. (2) RAW_RECORDS — the underlying ' +
    'data from every import (risk register, assumptions, constraints, defects, resource hours, ' +
    'RACI, milestones, activities, Q&A, files) — THIS is where your best insight has to come from. ' +
    'Actually read it and cross-reference entries against each other and against CARD_FACTS; do not ' +
    'just restate CARD_FACTS and ignore RAW_RECORDS. (3) PREVIOUS_ANALYSIS — the executive summary ' +
    'and watch-items from the last time this analysis was run (null if this is the first run).\n\n' +
    'Do not hallucinate. Never invent a number, name, date, status, or fact that is not present ' +
    'somewhere in CARD_FACTS or RAW_RECORDS below. If you are not sure a claim is actually ' +
    'supported by the data given, leave it out rather than guessing or assuming. This analysis is ' +
    'a paid service — an item that just restates a number already visible on its own card, or a ' +
    'generic platitude with no real analysis behind it, is a failure to deliver.\n\n' +
    'Whenever you write a date anywhere in your output (executiveSummary, previousStepsReview, ' +
    'watchItems, cardText), always format it MM/DD/YYYY (US format, 4-digit year) — e.g. 09/18/2026 ' +
    '— regardless of what format that date happens to appear in within RAW_RECORDS.\n\n' +
    'Each CARD_FACTS entry is either a plain string, or an object {current, history} — "current" ' +
    'is what\'s shown on screen right now for whichever single time period is selected; "history" ' +
    '(when present) separately describes how that same metric has moved across the FULL project ' +
    'history, independent of the selected period. Use "history" to describe fluctuation/trends ' +
    'over time in executiveSummary and watchItems; when rewriting a card in cardText, rewrite only ' +
    'its "current" text (history is context for you, not something to restate verbatim there).\n\n' +
    'Produce a JSON object with exactly these keys:\n' +
    '"executiveSummary": a 1-2 sentence overview of the project\'s overall state, considering ' +
    'everything below together — including how key metrics have fluctuated over time where that\'s ' +
    'informative, not just a snapshot of right now.\n' +
    '"previousStepsReview": if PREVIOUS_ANALYSIS is not null, 1-2 sentences checking whether its ' +
    'watchItems appear to have actually been acted on, using what current CARD_FACTS/RAW_RECORDS now ' +
    'show — e.g. a previously-flagged risk that\'s still open and unchanged (not addressed), or a ' +
    'metric that moved in the direction a previous recommendation would have caused (progress made). ' +
    'Say plainly if you can\'t tell either way from the data available — do not assume action was ' +
    'taken just because time passed. If PREVIOUS_ANALYSIS is null (first run), set this to null.\n' +
    '"watchItems": an array of 2 to 4 objects — this is the project manager\'s punch list, so it ' +
    'must NEVER come back empty as long as ANY numbers are present above. Every project has ' +
    'something worth a closer look; find it by actually mining RAW_RECORDS, not just CARD_FACTS. ' +
    'Each object has exactly these string fields:\n' +
    '  "what": the specific finding or issue, referencing a real number/name/date from the data.\n' +
    '  "who": the specific role or person who should act (e.g. "the PM", "the Development Team ' +
    'lead", a named owner/assignee actually present in the data if one applies) — never just "the ' +
    'team" with no more specificity than that when a more specific owner is identifiable.\n' +
    '  "why": the underlying reason/root cause this matters, ideally a contributing factor found by ' +
    'cross-referencing RAW_RECORDS (not just "because the number is bad").\n' +
    '  "when": how urgently — a specific timeframe (e.g. "this week", "before the next status ' +
    'meeting", "before R-006\'s July 1 deadline") rather than a vague "soon."\n' +
    '  "expectedResult": what should measurably improve if this is actually carried out, stated so ' +
    'it can be checked against next time this analysis runs.\n' +
    'Draw findings from, in priority order: (1) a pattern from cross-referencing RAW_RECORDS entries ' +
    'against each other (e.g. a risk\'s impact area matching an over-allocated resource, a constraint ' +
    'blocking a slipping milestone, a named assignee across multiple overdue items); (2) a ' +
    'fluctuation/outlier in a CARD_FACTS "history" trend; (3) a concrete recommendation grounded in ' +
    'the numbers you do have (an SPI/CPI reading warranting a recovery plan review, a budget ' +
    'reforecast, a stakeholder check-in) if the first two turn up nothing. Never a platitude like ' +
    '"monitor risks closely."\n' +
    '"cardText": an object mapping each CARD_FACTS key to an analyst insight for that card. The ' +
    'dashboard hard-caps what shows inline to about 2 lines of text and cuts off at that exact point ' +
    'REGARDLESS of sentence boundaries (it does not wait for a sentence to finish) — everything ' +
    'beyond that sits behind a "…more detail" click that most readers never make. Since the exact ' +
    'cutoff isn\'t predictable, front-load the single most important insight as early as possible, ' +
    'ideally complete within the first ~25-30 words, so it survives the cut even in the worst case. ' +
    'That makes the opening the single most important part of what you write, and it must NEVER be ' +
    'spent restating something already visibly obvious from looking at ' +
    'the card itself: its color, its badge text, its headline number, or the shape of its chart. The ' +
    'reader can already see the traffic light is red, that the badge says "Caution," that SPI is ' +
    '0.96 — a first sentence like "Overall status is Caution" or "The overall project status is ' +
    'Critical" or "SPI is 0.96, indicating the project is slightly behind" tells them literally ' +
    'nothing they do not already know from a glance, and is a failure to deliver on a paid analysis. ' +
    'Skip the preamble entirely and open with the actual insight: WHAT, from RAW_RECORDS, is likely ' +
    'CAUSING that card\'s number to be what it is. For example, instead of "Overall status is ' +
    'Caution." (bad — pure restatement), write something like "Cost Performance Index has slipped to ' +
    '0.93 (7% over budget) while three high-severity risks remain unresolved, which is what is ' +
    'pulling the overall status down to Caution." (good — the cause leads, the already-visible status ' +
    'is only mentioned in passing as context, and it is still one complete, grammatically standalone ' +
    'sentence — never a fragment, and never an opener like "Because of X," that only makes sense once ' +
    'the reader has already clicked through). If a card\'s data genuinely gives you no cause beyond ' +
    'its own number, say that plainly ("No specific driver stands out beyond the metrics already ' +
    'shown.") rather than manufacturing a restatement to fill the space — but treat that as the rare ' +
    'exception, not the default. Prefer naming who and giving a concrete next step over a vague one. ' +
    'There is no fixed sentence limit — use as many as the actual insight genuinely needs, but do not ' +
    'pad. Put any remaining supporting detail and the next step in the sentence(s) after the first. ' +
    'Preserve every number/name/date from "current" exactly (except reformatting a date to MM/DD/YYYY ' +
    'per the date rule above).\n\n' +
    'Extra requirements for these specific cards, on top of the general rule above:\n' +
    '- "burndownCard"/"burnupCard": use "history" to say which OTHER period (or the overall trend ' +
    'direction) was more favorable than the current one, and name what likely changed between then ' +
    'and now by cross-referencing RAW_RECORDS (new tasks added, a batch of defects found, resources ' +
    'reassigned, a slipped milestone). These charts have a Tasks/Duration toggle — if CARD_FACTS ' +
    'mentions "tasks" or "days", briefly clarify which one this reading is (task-count vs. ' +
    'duration-weighted) since that changes how the number should be read.\n' +
    '- "velocityCard": state plainly how much worse or better the most recent period is vs. the ' +
    'running average (a number, not just "lower"), and name a LIKELY cause for that specific period ' +
    'by cross-referencing RAW_RECORDS for the same window (newly-opened defects, resources notably ' +
    'under-utilized, several tasks reassigned or slipped, a milestone/gate blocking downstream work).\n' +
    '- "ganttSection": don\'t just report counts — name 1-2 SPECIFIC tasks (by their actual title from ' +
    'RAW_RECORDS) worth clicking into for more detail, chosen either because they were recently ' +
    'edited or because they\'re furthest behind their own due date relative to their % complete, and ' +
    'say specifically what to look for (what changed, current % complete) so the reader is pointed at ' +
    'exactly where to click rather than told to "review the schedule."\n\n' +
    'Return ONLY the JSON object, no preamble or code fences.\n\n' +
    'CARD_FACTS:\n' + cardFactsStr + '\n\n' +
    'PREVIOUS_ANALYSIS:\n' + JSON.stringify(previousAnalysis) + '\n\n' +
    'RAW_RECORDS:\n' + JSON.stringify(records);

  let text;
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        // Rewriting every card's text plus the summary/watchItems in one
        // response runs long (~30 cards x up to 3 analyst sentences each,
        // now that cardText requires contributing factors/next steps, not
        // just a rephrase) — a low cap was cutting the response off
        // mid-JSON before it could close, which made the whole response
        // fail to parse even though the content generated so far was
        // good. This is a genuinely large response, not a runaway one.
        max_tokens: 16000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!resp.ok) {
      const errText = await resp.text();
      logger.error('runProjectAnalysis: Anthropic API error', { status: resp.status, errText });
      throw new HttpsError('internal', 'AI request failed.');
    }

    const json = await resp.json();
    text = json.content && json.content[0] && json.content[0].text ? json.content[0].text.trim() : '';
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    logger.error('runProjectAnalysis: request failed', err);
    throw new HttpsError('internal', 'AI request failed.');
  }

  const parsed = extractJson(text || '');
  if (!parsed || typeof parsed.executiveSummary !== 'string') {
    logger.error('runProjectAnalysis: could not parse AI response', { text });
    throw new HttpsError('internal', 'AI returned an unexpected response.');
  }

  const WATCH_ITEM_FIELDS = ['what', 'who', 'why', 'when', 'expectedResult'];
  const watchItems = Array.isArray(parsed.watchItems)
    ? parsed.watchItems.slice(0, 4).map(function (item) {
        const out = {};
        WATCH_ITEM_FIELDS.forEach(function (f) { out[f] = item && item[f] != null ? String(item[f]) : ''; });
        return out;
      }).filter(function (item) { return item.what; }) // drop anything malformed rather than showing a blank card
    : [];

  const result = {
    executiveSummary: parsed.executiveSummary,
    previousStepsReview: typeof parsed.previousStepsReview === 'string' ? parsed.previousStepsReview : null,
    watchItems: watchItems,
    cardText: parsed.cardText && typeof parsed.cardText === 'object' ? parsed.cardText : {}
  };
  // the C-level wording of the same analysis (which roles see it is decided in the browser and by Permissions)
  const layer = await generateExecutive(apiKey, cardFactsStr, records, { executiveSummary: parsed.executiveSummary, previousStepsReview: result.previousStepsReview, watchItems: watchItems });
  result.executive = layer.executive;
  result.cardTextExec = layer.cardTextExec;

  await db.collection('businesses').doc(bizKey).collection('projects').doc(projKey).set({
    aiAnalysis: Object.assign({}, result, { generatedAt: new Date() })
  }, { merge: true });

  return result;
});

// ---------------------------------------------------------------------
// translatePageText — proxies the dashboard's Language switcher through
// Google Translate's UNOFFICIAL public web endpoint (the same one
// translate.google.com's own page uses, called directly rather than
// through the paid, officially-supported Cloud Translation API). This
// was a deliberate choice, not an oversight: it needs no API key, no
// billing setup, and no ongoing per-character cost — the trade-off is
// that it's undocumented, unsupported, and can be rate-limited or
// blocked by Google without notice. If that ever happens, the fix is to
// swap the body of translateBatch() below for a real Cloud Translation
// API call (google-cloud/translate) — callers of this function don't
// need to change, since the {texts, targetLang} -> {translations} shape
// stays the same either way.
//
// Proxied through a Cloud Function (rather than called directly from the
// browser) for two reasons: this endpoint doesn't reliably send CORS
// headers for arbitrary origins, and centralizing it here means any
// future swap to a real, key-based API only touches one file.
const MAX_TRANSLATE_TEXTS = 500;
const MAX_TRANSLATE_BATCH = 20; // small batches — fewer strings per request means a misaligned split (see below) loses less
const MAX_TRANSLATE_TEXT_LENGTH = 2000;
const SEGMENT_DELIMITER = '\n@@DRSEG@@\n';

async function translateBatch(texts, targetLang) {
  // Multiple strings are joined into ONE request (separated by a marker
  // unlikely to appear in real UI text) rather than one request per
  // string — this endpoint has no official batch support, and one
  // request per text node would mean hundreds of calls for a single
  // dashboard render. If the translated result doesn't split back into
  // exactly as many segments as went in (the marker can occasionally get
  // reflowed or dropped by the translator), this batch is returned
  // UNTRANSLATED rather than risk assigning a translation to the wrong
  // original string.
  const joined = texts.join(SEGMENT_DELIMITER);
  const url = 'https://translate.googleapis.com/translate_a/single' +
    '?client=gtx&sl=en&tl=' + encodeURIComponent(targetLang) + '&dt=t&q=' + encodeURIComponent(joined);

  const resp = await fetch(url, { method: 'GET' });
  if (!resp.ok) throw new Error('translate endpoint returned ' + resp.status);
  const data = await resp.json();

  // Shape: [[[translatedChunk, originalChunk, null, null, 1], ...], null, "en"]
  // — the translator can re-segment by sentence, so the number of chunks
  // rarely matches the number of inputs; they're joined back into one
  // string before re-splitting on the marker.
  const chunks = Array.isArray(data) && Array.isArray(data[0]) ? data[0] : [];
  const translatedJoined = chunks.map((c) => (Array.isArray(c) ? c[0] : '')).join('');

  const translatedParts = translatedJoined.split(SEGMENT_DELIMITER.trim());
  if (translatedParts.length !== texts.length) {
    return texts.slice(); // misaligned — fail safe to the original English text
  }
  return translatedParts.map((s) => s.trim());
}

exports.translatePageText = onCall({ timeoutSeconds: 60 }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in required.');
  }

  const texts = (request.data && request.data.texts) || [];
  const targetLang = request.data && request.data.targetLang;
  if (!Array.isArray(texts) || !texts.length) {
    throw new HttpsError('invalid-argument', 'texts must be a non-empty array.');
  }
  if (texts.length > MAX_TRANSLATE_TEXTS) {
    throw new HttpsError('invalid-argument', 'Too many strings in one request (max ' + MAX_TRANSLATE_TEXTS + ').');
  }
  if (!targetLang || typeof targetLang !== 'string' || targetLang.length > 10) {
    throw new HttpsError('invalid-argument', 'targetLang is required.');
  }
  for (const t of texts) {
    if (typeof t !== 'string' || t.length > MAX_TRANSLATE_TEXT_LENGTH) {
      throw new HttpsError('invalid-argument', 'Each text must be a string under ' + MAX_TRANSLATE_TEXT_LENGTH + ' characters.');
    }
  }

  const results = new Array(texts.length);
  for (let i = 0; i < texts.length; i += MAX_TRANSLATE_BATCH) {
    const batch = texts.slice(i, i + MAX_TRANSLATE_BATCH);
    let translated;
    try {
      translated = await translateBatch(batch, targetLang);
    } catch (err) {
      logger.warn('translateBatch failed, returning original text for this batch', err);
      translated = batch.slice();
    }
    for (let j = 0; j < translated.length; j++) results[i + j] = translated[j];
  }

  return { translations: results };
});

// Owner-only account creation — replaces the old public self-service signup
// flow (Public/JS/signup.js, retired). Creating a Firebase Auth user via the
// CLIENT sdk signs the caller out and into the new account, so this has to
// go through the Admin SDK server-side instead, which has no such effect on
// the owner's own session. The company is chosen from a dropdown of
// existing businesses on the client (Public/JS/create-account.js) rather
// than typed freehand, specifically to eliminate the typo-creates-a-new-
// business class of bug the old free-text field allowed — this function
// re-validates that independently of the client, regardless of what called
// it. The owner sets a temporary password directly (communicated to the
// new user out of band); the new user can change it via the existing
// "Forgot password" flow whenever they like.
// Manage Project Access (Public/JS/manage-project-access.js) adds a person to
// a project by email. A company can hold several stale user records for the
// same email (each time an account is deleted and recreated, the old
// businesses/{biz}/users/{uid} doc lingers), and matching on email alone can
// pick the wrong one — the person then can't see their project. Firebase
// Authentication is the only authority on which uid an email actually signs
// in as, and only the server can ask it, so this returns that uid.
exports.resolveMemberUid = onCall({ timeoutSeconds: 15 }, async (request) => {
  if (!request.auth || !request.auth.token || !OWNERS.includes((request.auth.token.email || '').toLowerCase())) {
    throw new HttpsError('permission-denied', 'Only the Owner can look up members.');
  }
  const email = ((request.data && request.data.email) || '').trim().toLowerCase();
  if (!email) throw new HttpsError('invalid-argument', 'Email is required.');
  try {
    const user = await getAuth().getUserByEmail(email);
    return { uid: user.uid, email: user.email || email };
  } catch (err) {
    if (err && err.code === 'auth/user-not-found') {
      throw new HttpsError('not-found', 'No login account exists for that email.');
    }
    logger.error('resolveMemberUid failed', { err: err && err.message });
    throw new HttpsError('internal', 'Could not look up that email.');
  }
});

exports.createCompanyAccount = onCall({ timeoutSeconds: 30 }, async (request) => {
  if (!request.auth || !request.auth.token || !OWNERS.includes((request.auth.token.email || '').toLowerCase())) {
    throw new HttpsError('permission-denied', 'Only the Owner can create accounts.');
  }

  const data = request.data || {};
  const firstName = (data.firstName || '').trim();
  const lastName = (data.lastName || '').trim();
  const email = (data.email || '').trim().toLowerCase();
  const phone = (data.phone || '').trim();
  const businessKey = (data.businessKey || '').trim();
  const password = (data.password || '');
  const isNewCompany = !!data.isNewCompany;
  if (!firstName || !lastName || !email || !phone || !businessKey || !password) {
    throw new HttpsError('invalid-argument', 'First name, last name, email, phone, company, and a temporary password are required.');
  }
  if (password.length < 6) {
    throw new HttpsError('invalid-argument', 'Temporary password must be at least 6 characters.');
  }

  const db = getFirestore();
  const bizRef = db.collection('businesses').doc(businessKey);

  let bizSnap;
  try {
    bizSnap = await bizRef.get();
  } catch (err) {
    logger.error('createCompanyAccount: business lookup failed', { businessKey, err: err && err.message });
    throw new HttpsError('internal', 'Could not look up that company: ' + (err && err.message ? err.message : 'unknown error'));
  }

  if (isNewCompany) {
    if (bizSnap.exists) {
      throw new HttpsError('already-exists', 'A company with that name already exists — pick it from the dropdown instead.');
    }
    try {
      await bizRef.set({
        name: businessKey,
        nameLower: businessKey.toLowerCase(),
        createdAt: new Date(),
        createdByOwner: true
      });
    } catch (err) {
      logger.error('createCompanyAccount: new business create failed', { businessKey, err: err && err.message });
      throw new HttpsError('internal', 'Could not create the new company: ' + (err && err.message ? err.message : 'unknown error'));
    }
  } else if (!bizSnap.exists) {
    throw new HttpsError('not-found', 'That company does not exist.');
  }

  let userRecord;
  try {
    userRecord = await getAuth().createUser({
      email,
      password,
      displayName: (firstName + ' ' + lastName).trim()
    });
  } catch (err) {
    if (err && err.code === 'auth/email-already-exists') {
      throw new HttpsError('already-exists', 'An account with that email already exists.');
    }
    logger.error('createCompanyAccount: createUser failed', { email, code: err && err.code, message: err && err.message });
    throw new HttpsError('internal', 'Could not create the account: ' + (err && err.message ? err.message : 'unknown error'));
  }

  const uid = userRecord.uid;

  // Same field shapes signup.js used to write client-side — /users/{uid}
  // (what login-simple.js expects for non-owner routing) and
  // /businesses/{businessKey}/users/{uid} (company membership, what
  // qna.js/filemanager.js read for assignee lists and Firestore rules
  // check for isMember()). Admin SDK writes bypass security rules, so this
  // works even though direct client self-creation of these paths is now
  // locked to owner-only. The Auth account already exists at this point —
  // if either write below fails, log loudly (rather than silently leaving
  // a signed-up-but-unlinked account) instead of throwing a generic error
  // that hides which of the two writes actually failed.
  try {
    await db.collection('users').doc(uid).set({
      uid,
      firstName,
      lastName,
      businessName: businessKey,
      businessKey,
      business: businessKey,
      email,
      phone,
      createdAt: new Date(),
      createdByOwner: true
    }, { merge: true });

    await db.collection('businesses').doc(businessKey).collection('users').doc(uid).set({
      uid,
      email,
      firstName,
      lastName,
      role: 'member',
      addedAt: new Date(),
      createdByOwner: true
    }, { merge: true });
  } catch (err) {
    logger.error('createCompanyAccount: membership write failed after auth account was already created', { uid, email, businessKey, err: err && err.message });
    throw new HttpsError('internal', 'Account was created (uid ' + uid + ') but linking it to the company failed: ' + (err && err.message ? err.message : 'unknown error') + '. Contact support rather than retrying, to avoid a duplicate account.');
  }

  return { ok: true, uid, email };
});

// Shared by every Twilio-sending function below — checks Twilio's own
// account config plus whichever phone number was passed in, and never
// throws (a notification failure should never break the write/trigger
// that led to it).
async function sendOwnerSms(toPhone, messageBody, logLabel) {
  if (String(SMS_ENABLED.value()).trim().toLowerCase() !== 'true') {
    logger.info(logLabel + ': SMS is switched off (SMS_ENABLED is not "true") — not sending.', { wouldHaveSent: messageBody });
    return;
  }
  const accountSid = TWILIO_ACCOUNT_SID.value();
  const authToken = TWILIO_AUTH_TOKEN.value();
  const fromNumber = TWILIO_FROM_NUMBER.value();

  if (isPlaceholder(toPhone) || isPlaceholder(accountSid) || isPlaceholder(authToken) || isPlaceholder(fromNumber)) {
    logger.warn(logLabel + ': Twilio/phone config is still a placeholder — not sending SMS.', { wouldHaveSent: messageBody });
    return;
  }

  try {
    const client = twilio(accountSid, authToken);
    await client.messages.create({ to: toPhone, from: fromNumber, body: messageBody });
    logger.info(logLabel + ': SMS sent');
  } catch (err) {
    logger.error(logLabel + ': Twilio send failed', err);
  }
}

// Appends a project label when it's unambiguous, and only when the
// project's name was actually customized away from the business name
// (every business auto-gets a 'default' project whose name mirrors the
// business name, per ensureDefaultProject() below — echoing that back as
// "Project: CompanyName" would just be noise). Never throws — a lookup
// failure here should never block the SMS it's decorating.
//
// Pass knownProjId when the caller already knows exactly which project
// an item belongs to (e.g. notifyOwnerOnNewQuestion, whose trigger path
// is itself project-scoped post-cutover) — that's a direct, precise
// lookup. Without it (notifyOwnerOnNewMember, sendOverdueDigest — whose
// company-membership/overdue data isn't tied to one specific project),
// this falls back to a heuristic: only label if the business has exactly
// one project total, since there's no other way to guess which one an
// item belongs to.
async function getProjectContextLabel(db, biz, bizName, knownProjId) {
  try {
    if (knownProjId) {
      const projSnap = await db.collection('businesses').doc(biz).collection('projects').doc(knownProjId).get();
      const projName = projSnap.exists && projSnap.data().name;
      if (!projName || projName === bizName) return '';
      return ' / Project: "' + projName + '"';
    }
    const projSnap = await db.collection('businesses').doc(biz).collection('projects').get();
    if (projSnap.size !== 1) return '';
    const projName = projSnap.docs[0].data().name;
    if (!projName || projName === bizName) return '';
    return ' / Project: "' + projName + '"';
  } catch (err) {
    logger.warn('getProjectContextLabel: lookup failed, omitting project label', err);
    return '';
  }
}

exports.notifyOwnerOnNewMember = onDocumentCreated('businesses/{biz}/users/{uid}', async (event) => {
  const biz = event.params.biz;
  const memberData = event.data.data() || {};
  const db = getFirestore();

  // A brand-new business's founding member also gets a users/{uid} doc
  // created in the same signup flow — don't text the owner for that.
  const rosterSnap = await db.collection('businesses').doc(biz).collection('users').get();
  if (rosterSnap.size <= 1) {
    logger.info('notifyOwnerOnNewMember: founding member of a new business, skipping SMS', { biz });
    return;
  }

  const bizDoc = await db.collection('businesses').doc(biz).get();
  const bizName = (bizDoc.exists && (bizDoc.data().name || bizDoc.data().businessName)) || biz;
  const projectLabel = await getProjectContextLabel(db, biz, bizName);

  const memberLabel =
    [memberData.firstName, memberData.lastName].filter(Boolean).join(' ') ||
    memberData.email ||
    'A new user';

  const messageBody =
    memberLabel + ' (' + (memberData.email || 'no email on file') + ') just joined "' +
    bizName + '"' + projectLabel + ' as an additional member. Reply or check the portal to approve.';

  await sendOwnerSms(OWNER_PHONE_NUMBER.value(), messageBody, 'notifyOwnerOnNewMember');
});

// Fires on every new Q&A item (Public/JS/qna.js's addItem()) — only a
// genuine new QUESTION texts the business's Notification Phone Number
// (Settings ▸ Notification Phone Number); the same qna collection also
// holds tasks/risks/issues converted from a question, which don't.
// Multi-project cutover — trigger path now matches the nested,
// project-scoped location qna.js actually writes to
// (businesses/{biz}/projects/{proj}/qna/{qnaId}). Watching the old flat
// businesses/{biz}/qna/{qnaId} path here would silently stop firing the
// moment the client cuts over, since a Firestore trigger only matches
// the exact path pattern it's declared with.
exports.notifyOwnerOnNewQuestion = onDocumentCreated('businesses/{biz}/projects/{proj}/qna/{qnaId}', async (event) => {
  const biz = event.params.biz;
  const proj = event.params.proj;
  const item = event.data.data() || {};
  // dashboard.html's #qna-type dropdown value is literally "Question"
  // (capitalized) — matches Public/JS/qna.js's addItem() payload exactly.
  if ((item.type || '').toLowerCase() !== 'question') return;

  const db = getFirestore();
  const bizDoc = await db.collection('businesses').doc(biz).get();
  const bizData = (bizDoc.exists && bizDoc.data()) || {};
  const bizName = bizData.name || bizData.businessName || biz;
  const notificationPhone = bizData.notificationPhone;

  if (isPlaceholder(notificationPhone)) {
    logger.info('notifyOwnerOnNewQuestion: no notificationPhone set for this business, skipping SMS', { biz });
    return;
  }

  const projectLabel = await getProjectContextLabel(db, biz, bizName, proj);
  const askerLabel = item.createdBy || 'A team member';
  const preview = String(item.message || '').slice(0, 140);
  const messageBody =
    'New question in "' + bizName + '"' + projectLabel + ' from ' + askerLabel + ': "' + preview +
    (item.message && item.message.length > 140 ? '…' : '') + '"';

  await sendOwnerSms(notificationPhone, messageBody, 'notifyOwnerOnNewQuestion');
});

function dateOnly(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function toJsDateSafe(v) {
  if (!v) return null;
  if (v.toDate) return v.toDate();
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

// Daily digest, one SMS per business (to that business's Notification
// Phone Number — businesses with none set are skipped entirely) —
// overdue Meetings/Events and Activity Log items, plus overdue Issue Log
// entries and high-severity/no-response-yet Risk Register entries.
//
// Multi-project cutover — all four now read from the 'default' project
// doc (businesses/{biz}/projects/default/...) rather than the legacy
// flat businesses/{biz}/... paths, matching where the client (gantt.js/
// burndown.js/issueLog.js/riskAssumptions.js) now reads/writes them.
// Scoped to 'default' only for this pass — a business with additional,
// separately-named projects won't have THEIR overdue items covered by
// this digest yet; extending it to loop over every project is a natural
// follow-up once that's actually needed. A business with nothing overdue
// today gets no text at all — no "0 overdue items" noise.
exports.sendOverdueDigest = onSchedule({ schedule: 'every day 08:00', timeZone: 'America/New_York' }, async () => {
  const db = getFirestore();
  const today = dateOnly(new Date());
  const bizSnap = await db.collection('businesses').get();

  for (const bizDoc of bizSnap.docs) {
    const biz = bizDoc.id;
    const bizData = bizDoc.data() || {};
    const notificationPhone = bizData.notificationPhone;
    if (isPlaceholder(notificationPhone)) continue;

    const bizName = bizData.name || bizData.businessName || biz;
    const sections = [];

    const projRef = db.collection('businesses').doc(biz).collection('projects').doc('default');
    const projSnap = await projRef.get();
    const projData = (projSnap.exists && projSnap.data()) || {};

    const milestonesSnap = await projRef.collection('milestones').get();
    const overdueMeetings = [];
    milestonesSnap.forEach((doc) => {
      const d = doc.data() || {};
      const due = toJsDateSafe(d.dueDate);
      if (due && dateOnly(due) < today) overdueMeetings.push(d.title || 'Untitled');
    });
    if (overdueMeetings.length) {
      sections.push(
        overdueMeetings.length + ' overdue meeting/event' + (overdueMeetings.length === 1 ? '' : 's') +
        ' (' + overdueMeetings.slice(0, 3).join(', ') + ')'
      );
    }

    const activitiesSnap = await projRef.collection('activities').get();
    const overdueActivities = [];
    activitiesSnap.forEach((doc) => {
      const d = doc.data() || {};
      if ((d.status || '').toLowerCase() === 'completed') return;
      const due = toJsDateSafe(d.dueDate || d.due);
      if (due && dateOnly(due) < today) overdueActivities.push(d.title || d.activity || 'Untitled');
    });
    if (overdueActivities.length) {
      sections.push(
        overdueActivities.length + ' overdue activit' + (overdueActivities.length === 1 ? 'y' : 'ies') +
        ' (' + overdueActivities.slice(0, 3).join(', ') + ')'
      );
    }

    const issueLog = Array.isArray(projData.issueLog) ? projData.issueLog : [];
    const overdueIssues = issueLog.filter((r) => {
      const status = (r.status || '').toLowerCase();
      if (status === 'closed' || status === 'resolved') return false;
      const due = toJsDateSafe(r.targetResolutionDate);
      return !!(due && dateOnly(due) < today);
    });
    if (overdueIssues.length) {
      sections.push(
        overdueIssues.length + ' overdue issue' + (overdueIssues.length === 1 ? '' : 's') +
        ' (' + overdueIssues.slice(0, 3).map((r) => r.id || r.description || 'Untitled').join(', ') + ')'
      );
    }

    // "Needs response" — high severity (score >= 15, same threshold
    // riskAssumptions.js already uses for its own high-severity badge),
    // still open, and nobody's set a Response Initiated date yet.
    const riskRegister = Array.isArray(projData.riskRegister) ? projData.riskRegister : [];
    const needsResponseRisks = riskRegister.filter((r) => {
      if ((r.status || '').toLowerCase() === 'closed') return false;
      const score = typeof r.score === 'number' ? r.score : 0;
      return score >= 15 && !r.responseInitiated;
    });
    if (needsResponseRisks.length) {
      sections.push(
        needsResponseRisks.length + ' high-severity risk' + (needsResponseRisks.length === 1 ? '' : 's') +
        ' with no response started (' + needsResponseRisks.slice(0, 3).map((r) => r.id || r.description || 'Untitled').join(', ') + ')'
      );
    }

    if (!sections.length) continue;

    const projectLabel = await getProjectContextLabel(db, biz, bizName);
    const messageBody = 'Daily overdue digest for "' + bizName + '"' + projectLabel + ': ' + sections.join('; ') + '.';
    await sendOwnerSms(notificationPhone, messageBody, 'sendOverdueDigest[' + biz + ']');
  }
});

/**
 * Multi-Project migration mirror (Architecture Spec §04).
 *
 * Every business currently keeps its data at flat legacy paths:
 *   businesses/{biz}/qna|files|activities|milestones/{id}
 *   businesses/{biz}/users/{uid}
 *
 * These functions watch those legacy paths and copy each write into the
 * new project-scoped shape, one-way only (legacy -> nested). Because the
 * trigger path pattern has a fixed segment count, a write to the NESTED
 * path can never itself match a legacy-path trigger — there is no reverse
 * direction, so this cannot loop back on itself.
 *
 * Every business gets exactly one auto-created project during this
 * migration, with a stable, predictable id ('default') rather than a
 * generated one, so the mirror can address it deterministically without
 * a lookup table. Client code continues reading/writing the legacy paths
 * unchanged until the cutover step in Phase 2 — this mirror's only job is
 * to make sure the nested paths are never behind, so that cutover is safe
 * to deploy at any moment.
 */

const DEFAULT_PROJECT_ID = 'default';
const MIRRORED_COLLECTIONS = ['qna', 'files', 'activities', 'milestones'];

async function ensureDefaultProject(db, biz) {
  const projRef = db.collection('businesses').doc(biz).collection('projects').doc(DEFAULT_PROJECT_ID);
  const projSnap = await projRef.get();
  if (projSnap.exists) return;

  const bizSnap = await db.collection('businesses').doc(biz).get();
  const bizData = (bizSnap.exists && bizSnap.data()) || {};

  await projRef.set({
    name: bizData.name || biz,
    projectStatus: bizData.projectStatus || null,
    projectProgress: bizData.projectProgress || null,
    logoUrl: bizData.logoUrl || null,
    createdAt: bizData.createdAt || new Date(),
    migratedFromLegacy: true
  }, { merge: true });
}

// businesses/{biz}/users/{uid} -> businesses/{biz}/projects/default/members/{uid}
// Every existing company member becomes a project member with the base
// 'member' role, preserving equivalent access the moment cutover happens —
// promoting someone to Client PM/Exec Sponsor afterward is a separate,
// explicit owner action (Manage Project Access screen, Phase 3), never
// something this mirror does on its own.
exports.mirrorCompanyMembersToDefaultProject = onDocumentWritten(
  'businesses/{biz}/users/{uid}',
  async (event) => {
    const { biz, uid } = event.params;
    const db = getFirestore();
    const after = event.data && event.data.after;

    const memberRef = db
      .collection('businesses').doc(biz)
      .collection('projects').doc(DEFAULT_PROJECT_ID)
      .collection('members').doc(uid);

    if (!after || !after.exists) {
      await memberRef.delete().catch(() => {});
      return;
    }

    await ensureDefaultProject(db, biz);

    const existing = await memberRef.get();
    const existingRole = existing.exists ? existing.data().role : null;

    await memberRef.set({
      uid,
      email: after.data().email || null,
      role: existingRole || 'member', // never downgrade a role the owner already set
      migratedFromLegacy: true
    }, { merge: true });
  }
);

// businesses/{biz}/{collection}/{id} -> businesses/{biz}/projects/default/{collection}/{id}
MIRRORED_COLLECTIONS.forEach((collectionName) => {
  const fnName = 'mirror_' + collectionName + '_ToDefaultProject';
  exports[fnName] = onDocumentWritten(
    'businesses/{biz}/' + collectionName + '/{docId}',
    async (event) => {
      const { biz, docId } = event.params;
      const db = getFirestore();
      const after = event.data && event.data.after;

      const targetRef = db
        .collection('businesses').doc(biz)
        .collection('projects').doc(DEFAULT_PROJECT_ID)
        .collection(collectionName).doc(docId);

      if (!after || !after.exists) {
        await targetRef.delete().catch(() => {});
        return;
      }

      await ensureDefaultProject(db, biz);
      await targetRef.set(after.data(), { merge: false });
    }
  );
});

// runMultiProjectBackfill (the one-time production backfill for the
// multi-project data separation migration) ran successfully on
// 2026-09-18, was verified against xyz-corporation's data, and was
// removed here afterward — see
// C:\Users\jyach\.claude\plans\imperative-watching-crown.md for the full
// migration plan, if this ever needs to be reconstructed.
