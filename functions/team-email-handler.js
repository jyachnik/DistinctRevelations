'use strict';
/* ============================================================================
   team-email-handler.js — the logic behind the sendTeamEmail Cloud Function,
   written with its dependencies injected (db, sendMail, clock) so its
   behavior can be tested with a fake database and a fake mail sender —
   same shape as ask-handler.js's handleAsk.

     - only the Owner may send (Team Directory writes are owner-only, see
       firestore.rules)
     - each recipient is sent to independently: one failed address never
       blocks the others, and each gets its own recorded success/failure
     - every send action is logged (teamEmailLog) and each successfully-
       emailed directory row gets a denormalized lastEmailedAt/lastEmailStatus
   ============================================================================ */

class TeamEmailError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const MAX_RECIPIENTS = 50;

async function handleSendTeamEmail({ db, auth, data, owners, sendMail, now = new Date() }) {
  if (!auth || !auth.uid) throw new TeamEmailError('unauthenticated', 'Please sign in.');
  const email = String((auth.token && auth.token.email) || '').toLowerCase();
  if (!owners.includes(email)) throw new TeamEmailError('permission-denied', 'Only the Owner can send email from the Team Directory.');

  const bizKey = data && data.bizKey, projKey = data && data.projKey;
  if (typeof bizKey !== 'string' || !bizKey || typeof projKey !== 'string' || !projKey) {
    throw new TeamEmailError('invalid-argument', 'A company and project are required.');
  }
  const recipients = Array.isArray(data && data.recipients) ? data.recipients : [];
  const subject = String((data && data.subject) || '').trim();
  const body = String((data && data.body) || '').trim();
  if (!recipients.length) throw new TeamEmailError('invalid-argument', 'Choose at least one recipient.');
  if (recipients.length > MAX_RECIPIENTS) throw new TeamEmailError('invalid-argument', 'Too many recipients in one send (max ' + MAX_RECIPIENTS + ').');
  if (!subject) throw new TeamEmailError('invalid-argument', 'A subject is required.');
  if (!body) throw new TeamEmailError('invalid-argument', 'A message is required.');

  const projRef = db.collection('businesses').doc(bizKey).collection('projects').doc(projKey);

  // Sent one at a time (not one call with multiple "to" addresses) so each recipient's
  // success/failure is independently attributable and recipients never see each other's address.
  const results = [];
  for (const r of recipients) {
    const to = String((r && r.email) || '').trim();
    const id = r && r.id, name = (r && r.name) || to;
    if (!to) { results.push({ id: id, name: name, email: to, status: 'failed', error: 'No email address on file.' }); continue; }
    try {
      await sendMail({ to: to, subject: subject, text: body });
      results.push({ id: id, name: name, email: to, status: 'sent' });
    } catch (err) {
      results.push({ id: id, name: name, email: to, status: 'failed', error: (err && err.message) || 'Send failed.' });
    }
  }

  const logRef = projRef.collection('teamEmailLog').doc();
  await logRef.set({ subject: subject, body: body, recipients: results, sentBy: email, sentAt: now });

  // Best-effort per-row convenience field — a failure here doesn't undo the send or fail the call.
  await Promise.all(results.filter(function (r) { return r.status === 'sent' && r.id; }).map(function (r) {
    return projRef.collection('teamDirectory').doc(r.id).update({ lastEmailedAt: now, lastEmailStatus: 'sent' }).catch(function () {});
  }));

  const sent = results.filter(function (r) { return r.status === 'sent'; }).length;
  return { sent: sent, failed: results.length - sent, logId: logRef.id, results: results };
}

module.exports = { handleSendTeamEmail: handleSendTeamEmail, TeamEmailError: TeamEmailError };
