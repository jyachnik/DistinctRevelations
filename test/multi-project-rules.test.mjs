import assert from 'node:assert';
import { test, before, after, beforeEach } from 'node:test';
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import {
  doc, getDoc, getDocs, setDoc, deleteDoc, updateDoc, collection, addDoc,
  collectionGroup, query, where, serverTimestamp,
} from 'firebase/firestore';

const PROJECT_ID = 'distinct-revelations-mp-test';
const OWNER_EMAIL = 'john@distinctrevelations.com';

let testEnv;

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: readFileSync('../Public/firestore.rules', 'utf8'),
      host: '127.0.0.1',
      port: 8080,
    },
  });
});

after(async () => {
  await testEnv.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
});

// biz-a/proj-1 has: memberA (role: member), pmA (role: projectManager),
// sponsorA (role: clientPartner). biz-a/proj-2 exists but nobody from
// proj-1 belongs to it — used to prove project-level isolation within
// the same business. Role vocabulary matches the 5-role system used by
// Public/JS/permissions.js (owner, clientPartner, projectManager, admin,
// member) — "PM"/"sponsor" in these test names refer to the change-request
// signature roles (projectManager files, clientPartner co-signs), not the
// old 'client-pm'/'exec-sponsor' strings the rules used before Phase 1 of
// the multi-project feature.
async function seed() {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();

    await setDoc(doc(db, 'businesses/biz-a'), { name: 'Biz A' });
    await setDoc(doc(db, 'businesses/biz-a/projects/proj-1'), { name: 'Project 1', projectStatus: 'onTrack' });
    await setDoc(doc(db, 'businesses/biz-a/projects/proj-2'), { name: 'Project 2' });

    await setDoc(doc(db, 'businesses/biz-a/projects/proj-1/members/uid-memberA'), { uid: 'uid-memberA', email: 'membera@client.com', role: 'member' });
    await setDoc(doc(db, 'businesses/biz-a/projects/proj-1/members/uid-pmA'), { uid: 'uid-pmA', email: 'pma@client.com', role: 'projectManager' });
    await setDoc(doc(db, 'businesses/biz-a/projects/proj-1/members/uid-sponsorA'), { uid: 'uid-sponsorA', email: 'sponsora@client.com', role: 'clientPartner' });

    await setDoc(doc(db, 'businesses/biz-a/projects/proj-1/activities/act1'), {
      title: 'Kickoff', status: 'In Progress', dueDate: new Date('2026-09-01'),
    });
    await setDoc(doc(db, 'businesses/biz-a/projects/proj-1/milestones/m1'), { title: 'Kickoff call', dueDate: new Date('2026-09-05') });
    await setDoc(doc(db, 'businesses/biz-a/projects/proj-1/qna/q1'), {
      type: 'Question', message: 'hi', createdBy: 'membera@client.com', createdByUid: 'uid-memberA', completed: false,
    });
    await setDoc(doc(db, 'businesses/biz-a/projects/proj-1/files/f1'), {
      fileName: 'a.pdf', owner: 'membera@client.com', ownerUid: 'uid-memberA',
    });
  });
}

function ownerCtx() { return testEnv.authenticatedContext('uid-owner', { email: OWNER_EMAIL }); }
function memberCtx() { return testEnv.authenticatedContext('uid-memberA', { email: 'membera@client.com' }); }
function pmCtx() { return testEnv.authenticatedContext('uid-pmA', { email: 'pma@client.com' }); }
function sponsorCtx() { return testEnv.authenticatedContext('uid-sponsorA', { email: 'sponsora@client.com' }); }
function outsiderCtx() { return testEnv.authenticatedContext('uid-outsider', { email: 'outsider@client.com' }); }

// ---------------------------------------------------------------------------
// Project-level read/write scoping
// ---------------------------------------------------------------------------

test('all three project roles can read project data; a non-member cannot', async () => {
  await seed();
  await assertSucceeds(getDoc(doc(memberCtx().firestore(), 'businesses/biz-a/projects/proj-1/activities/act1')));
  await assertSucceeds(getDoc(doc(pmCtx().firestore(), 'businesses/biz-a/projects/proj-1/activities/act1')));
  await assertSucceeds(getDoc(doc(sponsorCtx().firestore(), 'businesses/biz-a/projects/proj-1/activities/act1')));
  await assertFails(getDoc(doc(outsiderCtx().firestore(), 'businesses/biz-a/projects/proj-1/activities/act1')));
});

test('a project-1 member cannot read project-2 data in the SAME business', async () => {
  await seed();
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'businesses/biz-a/projects/proj-2/activities/other'), { title: 'Not yours', dueDate: new Date() });
  });
  await assertFails(getDoc(doc(memberCtx().firestore(), 'businesses/biz-a/projects/proj-2/activities/other')));
});

test('owner reads and writes across every project without restriction', async () => {
  await seed();
  const db = ownerCtx().firestore();
  await assertSucceeds(updateDoc(doc(db, 'businesses/biz-a/projects/proj-1/activities/act1'), { status: 'Completed' }));
  await assertSucceeds(updateDoc(doc(db, 'businesses/biz-a/projects/proj-1'), { projectStatus: 'critical' }));
});

test('only the owner can create a new project — a member cannot self-service one', async () => {
  await seed();
  await assertFails(setDoc(doc(memberCtx().firestore(), 'businesses/biz-a/projects/proj-3'), { name: 'Project 3' }));
  await assertSucceeds(setDoc(doc(ownerCtx().firestore(), 'businesses/biz-a/projects/proj-3'), { name: 'Project 3' }));
});

// ---------------------------------------------------------------------------
// Project discovery for a non-owner — regression coverage for a real bug
// found manually: a non-owner listing businesses/{biz}/projects directly
// (or querying collectionGroup('members')) is denied OUTRIGHT by Firestore,
// even when every document that would be returned is one they can actually
// read — Firestore refuses to run a list/collectionGroup query unless it can
// prove from the query's own shape (not per-document rule evaluation) that
// every possible result is allowed, and an exists()-based membership check
// doesn't qualify. select-project.js works around this by reading project
// ids off the user's own businesses/{biz}/users/{uid} doc (a plain get(),
// always safe) instead of listing the projects collection.
// ---------------------------------------------------------------------------

test('a non-owner CANNOT list the whole projects collection, even if a member of most of it', async () => {
  await seed();
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    // A third project in the same business that memberA does NOT belong to.
    await setDoc(doc(ctx.firestore(), 'businesses/biz-a/projects/proj-3'), { name: 'Project 3' });
  });
  await assertFails(getDocs(collection(memberCtx().firestore(), 'businesses/biz-a/projects')));
});

test('a non-owner CANNOT discover their projects via a collectionGroup(members) query either', async () => {
  await seed();
  const q = query(collectionGroup(memberCtx().firestore(), 'members'), where('uid', '==', 'uid-memberA'));
  await assertFails(getDocs(q));
});

test('a non-owner CAN read their own businesses/{biz}/users/{uid} doc, and CAN get() a project they belong to directly', async () => {
  await seed();
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'businesses/biz-a/users/uid-memberA'), {
      uid: 'uid-memberA', email: 'membera@client.com', projectIds: ['proj-1'],
    });
  });
  const db = memberCtx().firestore();
  await assertSucceeds(getDoc(doc(db, 'businesses/biz-a/users/uid-memberA')));
  await assertSucceeds(getDoc(doc(db, 'businesses/biz-a/projects/proj-1')));
});

// ---------------------------------------------------------------------------
// Role boundaries: Client PM cannot write schedule data directly
// ---------------------------------------------------------------------------

test('Client PM CANNOT directly edit an activity or milestone (must go through a change request)', async () => {
  await seed();
  const db = pmCtx().firestore();
  await assertFails(updateDoc(doc(db, 'businesses/biz-a/projects/proj-1/activities/act1'), { status: 'Completed' }));
  await assertFails(updateDoc(doc(db, 'businesses/biz-a/projects/proj-1/milestones/m1'), { title: 'Renamed' }));
});

test('a plain member also cannot directly edit an activity or milestone', async () => {
  await seed();
  const db = memberCtx().firestore();
  await assertFails(updateDoc(doc(db, 'businesses/biz-a/projects/proj-1/activities/act1'), { status: 'Completed' }));
});

test('exec sponsor cannot edit schedule data either — view-only plus decisions', async () => {
  await seed();
  const db = sponsorCtx().firestore();
  await assertFails(updateDoc(doc(db, 'businesses/biz-a/projects/proj-1/activities/act1'), { status: 'Completed' }));
});

// ---------------------------------------------------------------------------
// Q&A / Files: same "own artifact only" model as legacy, now project-scoped
// ---------------------------------------------------------------------------

test('Client PM can create and edit their own Q&A item', async () => {
  await seed();
  const db = pmCtx().firestore();
  const ref = await addDoc(collection(db, 'businesses/biz-a/projects/proj-1/qna'), {
    type: 'Task', message: 'from pm', createdBy: 'pma@client.com', createdByUid: 'uid-pmA', completed: false,
  });
  await assertSucceeds(updateDoc(ref, { completed: true }));
});

test('member cannot delete a file they did not upload, even within their own project', async () => {
  await seed();
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'businesses/biz-a/projects/proj-1/members/uid-memberA2'), { uid: 'uid-memberA2', email: 'membera2@client.com', role: 'member' });
  });
  const db = testEnv.authenticatedContext('uid-memberA2', { email: 'membera2@client.com' }).firestore();
  await assertFails(deleteDoc(doc(db, 'businesses/biz-a/projects/proj-1/files/f1')));
});

// ---------------------------------------------------------------------------
// Change requests (Change Control Log) — log-only: any project member (or the
// owner) can submit; owner/sponsor each record their own decision once.
// ---------------------------------------------------------------------------

const CR = 'businesses/biz-a/projects/proj-1/changeRequests';

function newRequest(uid, email, extra = {}) {
  return {
    title: 'Extend UAT by one week',
    description: 'Testers unavailable',
    reason: 'Resource conflict',
    changeType: 'Schedule',
    priority: 'High',
    scheduleImpactDays: 5,
    costImpact: 0,
    linkedItemType: 'activity',
    linkedItemId: 'act1',
    linkedItemTitle: 'Kickoff',
    needsSponsorApproval: false,
    proposedBy: email,
    proposedByUid: uid,
    createdAt: serverTimestamp(),
    ownerDecision: 'pending',
    sponsorDecision: 'n/a',
    ...extra,
  };
}

async function seedRequest(id, extra = {}) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `${CR}/${id}`), {
      ...newRequest('uid-memberA', 'membera@client.com'), createdAt: new Date(), ...extra,
    });
  });
}

test('a plain member, a PM and the owner can each submit a change request', async () => {
  await seed();
  await assertSucceeds(setDoc(doc(memberCtx().firestore(), `${CR}/m1`), newRequest('uid-memberA', 'membera@client.com')));
  await assertSucceeds(setDoc(doc(pmCtx().firestore(), `${CR}/p1`), newRequest('uid-pmA', 'pma@client.com')));
  await assertSucceeds(setDoc(doc(ownerCtx().firestore(), `${CR}/o1`), newRequest('uid-owner', OWNER_EMAIL)));
});

test('a non-member cannot submit or read change requests', async () => {
  await seed();
  await seedRequest('x1');
  await assertFails(setDoc(doc(outsiderCtx().firestore(), `${CR}/out1`), newRequest('uid-outsider', 'outsider@client.com')));
  await assertFails(getDoc(doc(outsiderCtx().firestore(), `${CR}/x1`)));
  await assertSucceeds(getDoc(doc(memberCtx().firestore(), `${CR}/x1`)));
});

test('cannot forge a request as already decided, or on behalf of someone else', async () => {
  await seed();
  const db = memberCtx().firestore();
  await assertFails(setDoc(doc(db, `${CR}/f1`), newRequest('uid-memberA', 'membera@client.com', { ownerDecision: 'approved' })));
  await assertFails(setDoc(doc(db, `${CR}/f2`), newRequest('uid-pmA', 'pma@client.com')));
  await assertFails(setDoc(doc(db, `${CR}/f3`), newRequest('uid-memberA', 'membera@client.com', { needsSponsorApproval: true, sponsorDecision: 'n/a' })));
});

test('sponsorDecision must start pending when sponsor approval is requested', async () => {
  await seed();
  await assertSucceeds(setDoc(doc(memberCtx().firestore(), `${CR}/s1`),
    newRequest('uid-memberA', 'membera@client.com', { needsSponsorApproval: true, sponsorDecision: 'pending' })));
});

test('only the owner can record the owner decision, only once, and not touch sponsor fields', async () => {
  await seed();
  await seedRequest('d1');
  await assertFails(updateDoc(doc(pmCtx().firestore(), `${CR}/d1`), { ownerDecision: 'approved', ownerDecidedAt: serverTimestamp(), ownerDecidedBy: 'pma@client.com' }));
  const db = ownerCtx().firestore();
  await assertFails(updateDoc(doc(db, `${CR}/d1`), { ownerDecision: 'approved', sponsorDecision: 'approved', ownerDecidedAt: serverTimestamp(), ownerDecidedBy: OWNER_EMAIL }));
  await assertSucceeds(updateDoc(doc(db, `${CR}/d1`), { ownerDecision: 'approved', ownerDecidedAt: serverTimestamp(), ownerDecidedBy: OWNER_EMAIL, ownerComment: 'ok' }));
  // Final: cannot flip it afterward.
  await assertFails(updateDoc(doc(db, `${CR}/d1`), { ownerDecision: 'rejected', ownerDecidedAt: serverTimestamp(), ownerDecidedBy: OWNER_EMAIL }));
});

test('exec sponsor can decide only when sponsor approval was requested, and only once', async () => {
  await seed();
  await seedRequest('sp1', { needsSponsorApproval: true, sponsorDecision: 'pending' });
  await seedRequest('sp2');
  const db = sponsorCtx().firestore();
  const decide = (id) => updateDoc(doc(db, `${CR}/${id}`), { sponsorDecision: 'approved', sponsorDecidedAt: serverTimestamp(), sponsorDecidedBy: 'sponsora@client.com' });
  await assertFails(decide('sp2'));
  await assertSucceeds(decide('sp1'));
  await assertFails(updateDoc(doc(db, `${CR}/sp1`), { sponsorDecision: 'rejected', sponsorDecidedAt: serverTimestamp(), sponsorDecidedBy: 'sponsora@client.com' }));
  // A plain member can't record the sponsor decision.
  await seedRequest('sp3', { needsSponsorApproval: true, sponsorDecision: 'pending' });
  await assertFails(updateDoc(doc(memberCtx().firestore(), `${CR}/sp3`), { sponsorDecision: 'approved', sponsorDecidedAt: serverTimestamp(), sponsorDecidedBy: 'membera@client.com' }));
});

test('submitter can edit content while undecided but not decisions; not after a decision', async () => {
  await seed();
  await seedRequest('e1');
  const db = memberCtx().firestore();
  await assertSucceeds(updateDoc(doc(db, `${CR}/e1`), { title: 'Extend UAT by two weeks', scheduleImpactDays: 10 }));
  await assertFails(updateDoc(doc(db, `${CR}/e1`), { ownerDecision: 'approved' }));
  await assertFails(updateDoc(doc(db, `${CR}/e1`), { needsSponsorApproval: true }));
  await assertFails(updateDoc(doc(pmCtx().firestore(), `${CR}/e1`), { title: 'Not mine' }));
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await updateDoc(doc(ctx.firestore(), `${CR}/e1`), { ownerDecision: 'approved' });
  });
  await assertFails(updateDoc(doc(db, `${CR}/e1`), { title: 'Too late' }));
});

test('submitter can withdraw while undecided; owner can delete any; others cannot', async () => {
  await seed();
  await seedRequest('w1');
  await seedRequest('w2');
  await assertFails(deleteDoc(doc(pmCtx().firestore(), `${CR}/w1`)));
  await assertSucceeds(deleteDoc(doc(memberCtx().firestore(), `${CR}/w1`)));
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await updateDoc(doc(ctx.firestore(), `${CR}/w2`), { ownerDecision: 'approved' });
  });
  await assertFails(deleteDoc(doc(memberCtx().firestore(), `${CR}/w2`)));
  await assertSucceeds(deleteDoc(doc(ownerCtx().firestore(), `${CR}/w2`)));
});


// ---------------------------------------------------------------------------
// Decision Log — owner-only writes; project members can read
// ---------------------------------------------------------------------------

test('decision log: owner writes; a member can read but not create/update/delete; a non-member cannot read', async () => {
  await seed();
  const path = 'businesses/biz-a/projects/proj-1/decisions/dec1';
  await assertSucceeds(setDoc(doc(ownerCtx().firestore(), path), { title: 'Use vendor B', status: 'Decided' }));
  await assertSucceeds(getDoc(doc(memberCtx().firestore(), path)));
  await assertFails(getDoc(doc(outsiderCtx().firestore(), path)));
  await assertFails(setDoc(doc(memberCtx().firestore(), 'businesses/biz-a/projects/proj-1/decisions/dec2'), { title: 'Nope' }));
  await assertFails(updateDoc(doc(memberCtx().firestore(), path), { status: 'Reversed' }));
  await assertFails(deleteDoc(doc(memberCtx().firestore(), path)));
  await assertSucceeds(updateDoc(doc(ownerCtx().firestore(), path), { status: 'Superseded' }));
  await assertSucceeds(deleteDoc(doc(ownerCtx().firestore(), path)));
});


// ---------------------------------------------------------------------------
// Team Directory — owner-only writes; project members can read. Email log — owner-only read+write.
// ---------------------------------------------------------------------------

test('team directory: owner writes; a member can read but not create/update/delete; a non-member cannot read', async () => {
  await seed();
  const path = 'businesses/biz-a/projects/proj-1/teamDirectory/td1';
  await assertSucceeds(setDoc(doc(ownerCtx().firestore(), path), { name: 'Priya', role: 'Developer', email: 'priya@x.com', version: 1, versions: [] }));
  await assertSucceeds(getDoc(doc(memberCtx().firestore(), path)));
  await assertFails(getDoc(doc(outsiderCtx().firestore(), path)));
  await assertFails(setDoc(doc(memberCtx().firestore(), 'businesses/biz-a/projects/proj-1/teamDirectory/td2'), { name: 'Nope' }));
  await assertFails(updateDoc(doc(memberCtx().firestore(), path), { role: 'Hijacked' }));
  await assertFails(deleteDoc(doc(memberCtx().firestore(), path)));
  await assertSucceeds(updateDoc(doc(ownerCtx().firestore(), path), { role: 'Lead Developer', version: 2, versions: [{ version: 1, role: 'Developer' }] }));
  await assertSucceeds(deleteDoc(doc(ownerCtx().firestore(), path)));
});

test('communications plan: owner writes; a member can read but not create/update/delete; a non-member cannot read', async () => {
  await seed();
  const path = 'businesses/biz-a/projects/proj-1/communicationsPlan/cp1';
  await assertSucceeds(setDoc(doc(ownerCtx().firestore(), path), { audience: 'Executive Sponsor', frequency: 'Monthly', channel: 'Status Report', version: 1, versions: [] }));
  await assertSucceeds(getDoc(doc(memberCtx().firestore(), path)));
  await assertFails(getDoc(doc(outsiderCtx().firestore(), path)));
  await assertFails(setDoc(doc(memberCtx().firestore(), 'businesses/biz-a/projects/proj-1/communicationsPlan/cp2'), { audience: 'Nope' }));
  await assertFails(updateDoc(doc(memberCtx().firestore(), path), { frequency: 'Hijacked' }));
  await assertFails(deleteDoc(doc(memberCtx().firestore(), path)));
  await assertSucceeds(updateDoc(doc(ownerCtx().firestore(), path), { frequency: 'Weekly', version: 2, versions: [{ version: 1, frequency: 'Monthly' }] }));
  await assertSucceeds(deleteDoc(doc(ownerCtx().firestore(), path)));
});

test('team email log: owner-only read and write; a member (even one who was a recipient) cannot read it', async () => {
  await seed();
  const path = 'businesses/biz-a/projects/proj-1/teamEmailLog/log1';
  await assertSucceeds(setDoc(doc(ownerCtx().firestore(), path), { subject: 'Hi', body: 'Team update', recipients: [{ email: 'membera@client.com', status: 'sent' }], sentBy: OWNER_EMAIL }));
  await assertSucceeds(getDoc(doc(ownerCtx().firestore(), path)));
  await assertFails(getDoc(doc(memberCtx().firestore(), path)));
  await assertFails(setDoc(doc(memberCtx().firestore(), 'businesses/biz-a/projects/proj-1/teamEmailLog/log2'), { subject: 'x' }));
  await assertFails(deleteDoc(doc(memberCtx().firestore(), path)));
  await assertSucceeds(deleteDoc(doc(ownerCtx().firestore(), path)));
});

test('benefits realization: owner writes; a member can read but not create/update/delete; a non-member cannot read', async () => {
  await seed();
  const path = 'businesses/biz-a/projects/proj-1/benefitsRealization/kpi1';
  await assertSucceeds(setDoc(doc(ownerCtx().firestore(), path), { title: 'Faster resolution', kpiMetric: 'Avg. resolution time', baselineValue: 48, targetValue: 24, readings: [] }));
  await assertSucceeds(getDoc(doc(memberCtx().firestore(), path)));
  await assertFails(getDoc(doc(outsiderCtx().firestore(), path)));
  await assertFails(setDoc(doc(memberCtx().firestore(), 'businesses/biz-a/projects/proj-1/benefitsRealization/kpi2'), { title: 'Nope' }));
  await assertFails(updateDoc(doc(memberCtx().firestore(), path), { title: 'Hijacked' }));
  await assertFails(deleteDoc(doc(memberCtx().firestore(), path)));
  await assertSucceeds(updateDoc(doc(ownerCtx().firestore(), path), { readings: [{ value: 39, date: new Date().toISOString(), note: '' }] }));
  await assertSucceeds(deleteDoc(doc(ownerCtx().firestore(), path)));
});

test('project closure: owner writes the checklist doc and saved reports; a member can read but not write; a non-member cannot read', async () => {
  await seed();
  const closurePath = 'businesses/biz-a/projects/proj-1/projectClosure/main';
  await assertSucceeds(setDoc(doc(ownerCtx().firestore(), closurePath), { checklist: [{ id: 'deliverables', label: 'All deliverables accepted', checked: false }] }));
  await assertSucceeds(getDoc(doc(memberCtx().firestore(), closurePath)));
  await assertFails(getDoc(doc(outsiderCtx().firestore(), closurePath)));
  await assertFails(updateDoc(doc(memberCtx().firestore(), closurePath), { checklist: [] }));
  await assertSucceeds(updateDoc(doc(ownerCtx().firestore(), closurePath), { checklist: [{ id: 'deliverables', label: 'All deliverables accepted', checked: true }] }));

  const reportPath = 'businesses/biz-a/projects/proj-1/closureReports/rep1';
  await assertSucceeds(setDoc(doc(ownerCtx().firestore(), reportPath), { savedAt: new Date().toISOString(), savedBy: OWNER_EMAIL, checklist: [], rollup: { groups: [] } }));
  await assertSucceeds(getDoc(doc(memberCtx().firestore(), reportPath)));
  await assertFails(getDoc(doc(outsiderCtx().firestore(), reportPath)));
  await assertFails(setDoc(doc(memberCtx().firestore(), 'businesses/biz-a/projects/proj-1/closureReports/rep2'), { savedBy: 'x' }));
  await assertFails(deleteDoc(doc(memberCtx().firestore(), reportPath)));
  await assertSucceeds(deleteDoc(doc(ownerCtx().firestore(), reportPath)));
});

test('glossary: owner writes; a member can read but not create/update/delete; a non-member cannot read', async () => {
  await seed();
  const path = 'businesses/biz-a/projects/proj-1/glossary/term1';
  await assertSucceeds(setDoc(doc(ownerCtx().firestore(), path), { term: 'SPI', definition: 'Schedule Performance Index', type: 'Acronym' }));
  await assertSucceeds(getDoc(doc(memberCtx().firestore(), path)));
  await assertFails(getDoc(doc(outsiderCtx().firestore(), path)));
  await assertFails(setDoc(doc(memberCtx().firestore(), 'businesses/biz-a/projects/proj-1/glossary/term2'), { term: 'Nope' }));
  await assertFails(updateDoc(doc(memberCtx().firestore(), path), { definition: 'Hijacked' }));
  await assertFails(deleteDoc(doc(memberCtx().firestore(), path)));
  await assertSucceeds(updateDoc(doc(ownerCtx().firestore(), path), { definition: 'Schedule Performance Index — EV/PV' }));
  await assertSucceeds(deleteDoc(doc(ownerCtx().firestore(), path)));
});

test('needs-attention ack: owner writes; a member can read but not create/update/delete; a non-member cannot read', async () => {
  await seed();
  const path = 'businesses/biz-a/projects/proj-1/needsAttentionAck/risks__R-001';
  await assertSucceeds(setDoc(doc(ownerCtx().firestore(), path), { group: 'risks', itemId: 'R-001', reviewedBy: OWNER_EMAIL }));
  await assertSucceeds(getDoc(doc(memberCtx().firestore(), path)));
  await assertFails(getDoc(doc(outsiderCtx().firestore(), path)));
  await assertFails(setDoc(doc(memberCtx().firestore(), 'businesses/biz-a/projects/proj-1/needsAttentionAck/risks__R-002'), { group: 'risks' }));
  await assertFails(updateDoc(doc(memberCtx().firestore(), path), { reviewedBy: 'hijacked@example.com' }));
  await assertFails(deleteDoc(doc(memberCtx().firestore(), path)));
  await assertSucceeds(deleteDoc(doc(ownerCtx().firestore(), path)));
});

test('needs-attention reports: owner writes; a member can read but not create/update/delete; a non-member cannot read', async () => {
  await seed();
  const path = 'businesses/biz-a/projects/proj-1/needsAttentionReports/rep1';
  await assertSucceeds(setDoc(doc(ownerCtx().firestore(), path), { generatedBy: OWNER_EMAIL, items: [] }));
  await assertSucceeds(getDoc(doc(memberCtx().firestore(), path)));
  await assertFails(getDoc(doc(outsiderCtx().firestore(), path)));
  await assertFails(setDoc(doc(memberCtx().firestore(), 'businesses/biz-a/projects/proj-1/needsAttentionReports/rep2'), { items: [] }));
  await assertFails(updateDoc(doc(memberCtx().firestore(), path), { generatedBy: 'hijacked@example.com' }));
  await assertFails(deleteDoc(doc(memberCtx().firestore(), path)));
  await assertSucceeds(deleteDoc(doc(ownerCtx().firestore(), path)));
});

test('team charter: owner writes; a member can read but not create/update/delete; a non-member cannot read', async () => {
  await seed();
  const path = 'businesses/biz-a/projects/proj-1/teamCharter/main';
  await assertSucceeds(setDoc(doc(ownerCtx().firestore(), path), { mission: 'Ship reliably.' }));
  await assertSucceeds(getDoc(doc(memberCtx().firestore(), path)));
  await assertFails(getDoc(doc(outsiderCtx().firestore(), path)));
  await assertFails(setDoc(doc(memberCtx().firestore(), path), { mission: 'Hijacked' }));
  await assertFails(updateDoc(doc(memberCtx().firestore(), path), { mission: 'Hijacked' }));
  await assertFails(deleteDoc(doc(memberCtx().firestore(), path)));
  await assertSucceeds(updateDoc(doc(ownerCtx().firestore(), path), { mission: 'Ship reliably, together.' }));
  await assertSucceeds(deleteDoc(doc(ownerCtx().firestore(), path)));
});

test('baseline changes: owner writes; a member can read but not create/update/delete; a non-member cannot read', async () => {
  await seed();
  const path = 'businesses/biz-a/projects/proj-1/baselineChanges/bc1';
  await assertSucceeds(setDoc(doc(ownerCtx().firestore(), path), { title: 'Q3 Rebaseline', reason: 'Scope addition', approvedBy: OWNER_EMAIL }));
  await assertSucceeds(getDoc(doc(memberCtx().firestore(), path)));
  await assertFails(getDoc(doc(outsiderCtx().firestore(), path)));
  await assertFails(setDoc(doc(memberCtx().firestore(), 'businesses/biz-a/projects/proj-1/baselineChanges/bc2'), { title: 'Nope' }));
  await assertFails(updateDoc(doc(memberCtx().firestore(), path), { title: 'Hijacked' }));
  await assertFails(deleteDoc(doc(memberCtx().firestore(), path)));
  await assertSucceeds(updateDoc(doc(ownerCtx().firestore(), path), { title: 'Q3 Rebaseline (revised)' }));
  await assertSucceeds(deleteDoc(doc(ownerCtx().firestore(), path)));
});

test('risk reserve + draws: owner writes; a member can read but not create/update/delete; a non-member cannot read', async () => {
  await seed();
  const reservePath = 'businesses/biz-a/projects/proj-1/riskReserve/main';
  await assertSucceeds(setDoc(doc(ownerCtx().firestore(), reservePath), { totalAmount: 50000, setBy: OWNER_EMAIL }));
  await assertSucceeds(getDoc(doc(memberCtx().firestore(), reservePath)));
  await assertFails(getDoc(doc(outsiderCtx().firestore(), reservePath)));
  await assertFails(updateDoc(doc(memberCtx().firestore(), reservePath), { totalAmount: 1 }));
  await assertSucceeds(updateDoc(doc(ownerCtx().firestore(), reservePath), { totalAmount: 60000 }));

  const drawPath = 'businesses/biz-a/projects/proj-1/reserveDraws/d1';
  await assertSucceeds(setDoc(doc(ownerCtx().firestore(), drawPath), { amount: 5000, date: new Date().toISOString(), note: 'Vendor delay' }));
  await assertSucceeds(getDoc(doc(memberCtx().firestore(), drawPath)));
  await assertFails(getDoc(doc(outsiderCtx().firestore(), drawPath)));
  await assertFails(setDoc(doc(memberCtx().firestore(), 'businesses/biz-a/projects/proj-1/reserveDraws/d2'), { amount: 1 }));
  await assertFails(deleteDoc(doc(memberCtx().firestore(), drawPath)));
  await assertSucceeds(deleteDoc(doc(ownerCtx().firestore(), drawPath)));
});

test('cost of quality: owner writes; a member can read but not create/update/delete; a non-member cannot read', async () => {
  await seed();
  const path = 'businesses/biz-a/projects/proj-1/costOfQuality/coq1';
  await assertSucceeds(setDoc(doc(ownerCtx().firestore(), path), { category: 'Prevention', description: 'QA training', amount: 2000, date: new Date().toISOString() }));
  await assertSucceeds(getDoc(doc(memberCtx().firestore(), path)));
  await assertFails(getDoc(doc(outsiderCtx().firestore(), path)));
  await assertFails(setDoc(doc(memberCtx().firestore(), 'businesses/biz-a/projects/proj-1/costOfQuality/coq2'), { category: 'Nope' }));
  await assertFails(deleteDoc(doc(memberCtx().firestore(), path)));
  await assertSucceeds(deleteDoc(doc(ownerCtx().firestore(), path)));
});

test('discrepancy reports: owner-only for read AND write; a member cannot even read it', async () => {
  await seed();
  const path = 'businesses/biz-a/projects/proj-1/discrepancyReports/rep1';
  await assertSucceeds(setDoc(doc(ownerCtx().firestore(), path), { generatedAt: new Date().toISOString(), generatedBy: OWNER_EMAIL, findings: [{ id: 'f1', summary: 'x', fixed: false }] }));
  await assertSucceeds(getDoc(doc(ownerCtx().firestore(), path)));
  await assertFails(getDoc(doc(memberCtx().firestore(), path)));
  await assertFails(getDoc(doc(outsiderCtx().firestore(), path)));
  await assertFails(setDoc(doc(memberCtx().firestore(), 'businesses/biz-a/projects/proj-1/discrepancyReports/rep2'), { generatedBy: 'x' }));
  await assertFails(updateDoc(doc(memberCtx().firestore(), path), { findings: [] }));
  await assertFails(deleteDoc(doc(memberCtx().firestore(), path)));
  await assertSucceeds(updateDoc(doc(ownerCtx().firestore(), path), { findings: [{ id: 'f1', summary: 'x', fixed: true }] }));
  await assertSucceeds(deleteDoc(doc(ownerCtx().firestore(), path)));
});

test('requirements: owner writes; a member can read but not create/update/delete; a non-member cannot read', async () => {
  await seed();
  const path = 'businesses/biz-a/projects/proj-1/requirements/req1';
  await assertSucceeds(setDoc(doc(ownerCtx().firestore(), path), { reqId: 'REQ-001', description: 'Users can reset their own password.', priority: 'High', status: 'Not Started' }));
  await assertSucceeds(getDoc(doc(memberCtx().firestore(), path)));
  await assertFails(getDoc(doc(outsiderCtx().firestore(), path)));
  await assertFails(setDoc(doc(memberCtx().firestore(), 'businesses/biz-a/projects/proj-1/requirements/req2'), { reqId: 'Nope' }));
  await assertFails(updateDoc(doc(memberCtx().firestore(), path), { status: 'Hijacked' }));
  await assertFails(deleteDoc(doc(memberCtx().firestore(), path)));
  await assertSucceeds(updateDoc(doc(ownerCtx().firestore(), path), { status: 'Met' }));
  await assertSucceeds(deleteDoc(doc(ownerCtx().firestore(), path)));
});

test('communications log: owner writes; a member can read but not create/update/delete; a non-member cannot read', async () => {
  await seed();
  const path = 'businesses/biz-a/projects/proj-1/communicationsLog/log1';
  await assertSucceeds(setDoc(doc(ownerCtx().firestore(), path), { planItemId: 'cp1', planItemLabel: 'Sponsor — Monthly update', dateSent: new Date().toISOString(), channel: 'Email' }));
  await assertSucceeds(getDoc(doc(memberCtx().firestore(), path)));
  await assertFails(getDoc(doc(outsiderCtx().firestore(), path)));
  await assertFails(setDoc(doc(memberCtx().firestore(), 'businesses/biz-a/projects/proj-1/communicationsLog/log2'), { channel: 'Nope' }));
  await assertFails(deleteDoc(doc(memberCtx().firestore(), path)));
  await assertSucceeds(deleteDoc(doc(ownerCtx().firestore(), path)));
});


// Decision Log — Client Partner / Project Manager write per the Permissions
// matrix (reportPermissions.decisionLogCard.actions.<add|edit|delete>.<role>).
test('decision log: PM and sponsor can write only the actions granted to their role; member/outsider never', async () => {
  await seed();
  const pmDb = pmCtx().firestore(), sponsorDb = sponsorCtx().firestore();
  const memberDb = memberCtx().firestore(), outsiderDb = outsiderCtx().firestore();
  const dec = (id) => `businesses/biz-a/projects/proj-1/decisions/${id}`;
  // Nothing granted yet -> nobody but the owner can write.
  await assertFails(setDoc(doc(pmDb, dec('d0')), { title: 'x' }));

  await testEnv.withSecurityRulesDisabled(async (c) => {
    const adb = c.firestore();
    await setDoc(doc(adb, dec('existing')), { title: 'Existing', status: 'Proposed' });
    await updateDoc(doc(adb, 'businesses/biz-a/projects/proj-1'), {
      reportPermissions: { decisionLogCard: { actions: {
        add:    { projectManager: true, clientPartner: true, member: true },
        edit:   { projectManager: true, clientPartner: false },
        delete: { projectManager: false, clientPartner: true },
      } } },
    });
  });

  // Add: PM + sponsor yes; member is never allowed even if the box were set.
  await assertSucceeds(setDoc(doc(pmDb, dec('d1')), { title: 'PM decision' }));
  await assertSucceeds(setDoc(doc(sponsorDb, dec('d2')), { title: 'Sponsor decision' }));
  await assertFails(setDoc(doc(memberDb, dec('d3')), { title: 'Member decision' }));
  await assertFails(setDoc(doc(outsiderDb, dec('d4')), { title: 'Outsider' }));

  // Edit: PM yes, sponsor no.
  await assertSucceeds(updateDoc(doc(pmDb, dec('existing')), { status: 'Decided' }));
  await assertFails(updateDoc(doc(sponsorDb, dec('existing')), { status: 'Reversed' }));

  // Delete: sponsor yes, PM no.
  await assertFails(deleteDoc(doc(pmDb, dec('existing'))));
  await assertSucceeds(deleteDoc(doc(sponsorDb, dec('existing'))));
});


// Lessons Learned — any member logs; only the owner or the author edits/deletes
test('lessons learned: any member can log one (author-stamped); only the author or owner can edit/delete; author stamp is immutable', async () => {
  await seed();
  const L = (id) => `businesses/biz-a/projects/proj-1/lessonsLearned/${id}`;
  const memberDb = memberCtx().firestore();
  const pmDb = pmCtx().firestore();
  const outsiderDb = outsiderCtx().firestore();
  const mine = () => ({
    title: 'Vendor slipped', createdBy: 'membera@client.com', createdByUid: 'uid-memberA', createdAt: serverTimestamp(),
  });

  await assertSucceeds(setDoc(doc(memberDb, L('l1')), mine()));
  // Can't forge the author or omit the timestamp; outsider can't log at all.
  await assertFails(setDoc(doc(pmDb, L('l2')), { ...mine(), createdAt: serverTimestamp() })); // pm claiming member's uid
  await assertFails(setDoc(doc(memberDb, L('l3')), { title: 'x', createdBy: 'membera@client.com', createdByUid: 'uid-memberA' }));
  await assertFails(setDoc(doc(outsiderDb, L('l4')), { title: 'x', createdBy: 'outsider@client.com', createdByUid: 'uid-outsider', createdAt: serverTimestamp() }));

  // Everyone in the project can read it; the author edits, others can't.
  await assertSucceeds(getDoc(doc(pmDb, L('l1'))));
  await assertSucceeds(updateDoc(doc(memberDb, L('l1')), { status: 'Actioned' }));
  await assertFails(updateDoc(doc(pmDb, L('l1')), { status: 'Closed' }));
  await assertFails(updateDoc(doc(memberDb, L('l1')), { createdByUid: 'uid-pmA' }));

  // Owner can edit any; a non-author can't delete; the author can.
  await assertSucceeds(updateDoc(doc(ownerCtx().firestore(), L('l1')), { status: 'Closed' }));
  await assertFails(deleteDoc(doc(pmDb, L('l1'))));
  await assertSucceeds(deleteDoc(doc(memberDb, L('l1'))));
});


// Dependencies — same matrix-driven access as the Decision Log, but keyed to
// its own card id (a grant on the Decision Log must not leak into it).
test('dependencies: PM/sponsor write only what dependenciesCard grants them; a decisionLogCard grant does not carry over', async () => {
  await seed();
  const dep = (id) => `businesses/biz-a/projects/proj-1/dependencies/${id}`;
  const pmDb = pmCtx().firestore(), sponsorDb = sponsorCtx().firestore();
  const memberDb = memberCtx().firestore(), outsiderDb = outsiderCtx().firestore();

  await testEnv.withSecurityRulesDisabled(async (c) => {
    const adb = c.firestore();
    await setDoc(doc(adb, dep('existing')), { title: 'A -> B', status: 'Open' });
    await updateDoc(doc(adb, 'businesses/biz-a/projects/proj-1'), {
      reportPermissions: {
        // Only the Decision Log is granted at first.
        decisionLogCard: { actions: { add: { projectManager: true }, edit: { projectManager: true }, delete: { projectManager: true } } },
        dependenciesCard: { actions: {
          add:    { projectManager: true, clientPartner: true, member: true },
          edit:   { projectManager: true, clientPartner: false },
          delete: { projectManager: false, clientPartner: true },
        } },
      },
    });
  });

  await assertSucceeds(getDoc(doc(memberDb, dep('existing'))));
  await assertFails(getDoc(doc(outsiderDb, dep('existing'))));
  await assertSucceeds(setDoc(doc(pmDb, dep('d1')), { title: 'PM dep' }));
  await assertSucceeds(setDoc(doc(sponsorDb, dep('d2')), { title: 'Sponsor dep' }));
  await assertFails(setDoc(doc(memberDb, dep('d3')), { title: 'Member dep' }));
  await assertSucceeds(updateDoc(doc(pmDb, dep('existing')), { status: 'At Risk' }));
  await assertFails(updateDoc(doc(sponsorDb, dep('existing')), { status: 'Blocked' }));
  await assertFails(deleteDoc(doc(pmDb, dep('existing'))));
  await assertSucceeds(deleteDoc(doc(sponsorDb, dep('existing'))));
  await assertSucceeds(setDoc(doc(ownerCtx().firestore(), dep('o1')), { title: 'Owner dep' }));

  // Remove the dependenciesCard grants: the still-granted decisionLogCard must not help.
  await testEnv.withSecurityRulesDisabled(async (c) => {
    await updateDoc(doc(c.firestore(), 'businesses/biz-a/projects/proj-1'), { 'reportPermissions.dependenciesCard': { actions: {} } });
  });
  await assertFails(setDoc(doc(pmCtx().firestore(), dep('d9')), { title: 'nope' }));
});


// Deliverable sign-off — matrix-driven create/edit, Client Partner decides once,
// resubmission archives a round, decided records are protected.
test('signoff: items start pending; only the Client Partner (or owner) decides, once; edits/resubmits/deletes follow the rules', async () => {
  await seed();
  const SO = (id) => `businesses/biz-a/projects/proj-1/signoffs/${id}`;
  const pmDb = pmCtx().firestore(), spDb = sponsorCtx().firestore();
  const memberDb = memberCtx().firestore(), outsiderDb = outsiderCtx().firestore();
  const ownerDb = ownerCtx().firestore();
  const fresh = (extra = {}) => ({ title: 'Design approval', kind: 'Milestone', decision: 'pending', round: 1, history: [], ...extra });

  await testEnv.withSecurityRulesDisabled(async (c) => {
    await updateDoc(doc(c.firestore(), 'businesses/biz-a/projects/proj-1'), {
      reportPermissions: { deliverableSignoffCard: { actions: {
        add:    { projectManager: true, clientPartner: false, member: true },
        edit:   { projectManager: true, clientPartner: false },
        delete: { projectManager: true, clientPartner: false },
      } } },
    });
  });

  // ---- create: PM may (granted), always pending/round 1; sponsor/member/outsider may not
  await assertSucceeds(setDoc(doc(pmDb, SO('a')), fresh()));
  await assertFails(setDoc(doc(pmDb, SO('b')), fresh({ decision: 'accepted' })));   // can't self-accept
  await assertFails(setDoc(doc(pmDb, SO('c')), fresh({ round: 2 })));
  await assertFails(setDoc(doc(pmDb, SO('d')), fresh({ history: [{ round: 1 }] })));
  await assertFails(setDoc(doc(spDb, SO('e')), fresh()));                            // sponsor's add is off
  await assertFails(setDoc(doc(memberDb, SO('f')), fresh()));                        // member never (not a writer role)
  await assertFails(setDoc(doc(outsiderDb, SO('g')), fresh()));
  await assertSucceeds(getDoc(doc(memberDb, SO('a'))));
  await assertFails(getDoc(doc(outsiderDb, SO('a'))));

  // ---- content edit while pending: PM yes; but not the decision fields; sponsor can't edit content
  await assertSucceeds(updateDoc(doc(pmDb, SO('a')), { acceptanceCriteria: 'Signed by client', dueDate: new Date('2026-10-01') }));
  await assertFails(updateDoc(doc(pmDb, SO('a')), { decision: 'accepted', decidedBy: 'pma@client.com', decidedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(spDb, SO('a')), { acceptanceCriteria: 'Changed by sponsor' }));

  // ---- decision: only the Client Partner (or owner); needs correct stamps; once
  await assertFails(updateDoc(doc(pmDb, SO('a')), { decision: 'accepted', decidedAt: serverTimestamp(), decidedBy: 'pma@client.com' }));
  await assertFails(updateDoc(doc(spDb, SO('a')), { decision: 'accepted', decidedAt: serverTimestamp(), decidedBy: 'someone@else.com' })); // forged
  await assertFails(updateDoc(doc(spDb, SO('a')), { decision: 'maybe', decidedAt: serverTimestamp(), decidedBy: 'sponsora@client.com' }));
  await assertSucceeds(updateDoc(doc(spDb, SO('a')), { decision: 'rejected', decidedAt: serverTimestamp(), decidedBy: 'sponsora@client.com', decisionComment: 'Missing section 3' }));
  await assertFails(updateDoc(doc(spDb, SO('a')), { decision: 'accepted', decidedAt: serverTimestamp(), decidedBy: 'sponsora@client.com' })); // not twice

  // ---- after a decision the content is frozen for editors; delete blocked for the PM
  await assertFails(updateDoc(doc(pmDb, SO('a')), { acceptanceCriteria: 'sneaky rewrite' }));
  await assertFails(deleteDoc(doc(pmDb, SO('a'))));

  // ---- resubmit: PM archives the round (round+1, history+1, back to pending); sponsor (edit off) can't
  const round1 = { round: 1, decision: 'rejected', comment: 'Missing section 3', decidedBy: 'sponsora@client.com', decidedAt: new Date() };
  const resubmit = (n = 2, hist = [round1]) => ({ decision: 'pending', decidedAt: null, decidedBy: null, decisionComment: '',
    round: n, history: hist, resubmittedAt: serverTimestamp(), resubmittedBy: 'pma@client.com' });
  await assertFails(updateDoc(doc(spDb, SO('a')), resubmit()));
  await assertFails(updateDoc(doc(pmDb, SO('a')), resubmit(3)));              // round must be +1
  await assertFails(updateDoc(doc(pmDb, SO('a')), resubmit(2, [])));           // must archive the round
  await assertSucceeds(updateDoc(doc(pmDb, SO('a')), resubmit()));

  // ---- second round: accepted; then it cannot be resubmitted; only the owner can delete it
  await assertSucceeds(updateDoc(doc(spDb, SO('a')), { decision: 'accepted', decidedAt: serverTimestamp(), decidedBy: 'sponsora@client.com', decisionComment: '' }));
  await assertFails(updateDoc(doc(pmDb, SO('a')), resubmit(3, [round1, round1])));
  await assertFails(deleteDoc(doc(pmDb, SO('a'))));
  await assertSucceeds(deleteDoc(doc(ownerDb, SO('a'))));

  // ---- pending items: PM (delete granted) can delete; owner can record a decision directly
  await assertSucceeds(setDoc(doc(pmDb, SO('h')), fresh()));
  await assertSucceeds(deleteDoc(doc(pmDb, SO('h'))));
  await assertSucceeds(setDoc(doc(ownerDb, SO('i')), fresh()));
  await assertSucceeds(updateDoc(doc(ownerDb, SO('i')), { decision: 'accepted', decidedAt: serverTimestamp(), decidedBy: OWNER_EMAIL }));
});


// Procurement — vendors + purchases share the 'procurementCard' grants.
test('procurement: vendors and purchases follow the procurementCard matrix per action; other cards\' grants do not leak', async () => {
  await seed();
  const V = (id) => `businesses/biz-a/projects/proj-1/vendors/${id}`;
  const PU = (id) => `businesses/biz-a/projects/proj-1/purchases/${id}`;
  const pmDb = pmCtx().firestore(), spDb = sponsorCtx().firestore();
  const memberDb = memberCtx().firestore(), outsiderDb = outsiderCtx().firestore();

  await testEnv.withSecurityRulesDisabled(async (c) => {
    const adb = c.firestore();
    await setDoc(doc(adb, V('v0')), { name: 'Existing vendor' });
    await setDoc(doc(adb, PU('p0')), { item: 'Existing purchase', contractValue: 1000 });
    await updateDoc(doc(adb, 'businesses/biz-a/projects/proj-1'), {
      reportPermissions: {
        decisionLogCard: { actions: { add: { projectManager: true, clientPartner: true }, edit: { projectManager: true }, delete: { projectManager: true } } },
        procurementCard: { actions: {
          add:    { projectManager: true, clientPartner: true },
          edit:   { projectManager: true, clientPartner: false },
          delete: { projectManager: false, clientPartner: true },
        } },
      },
    });
  });

  // read: any member; never an outsider
  await assertSucceeds(getDoc(doc(memberDb, V('v0'))));
  await assertSucceeds(getDoc(doc(memberDb, PU('p0'))));
  await assertFails(getDoc(doc(outsiderDb, V('v0'))));
  await assertFails(getDoc(doc(outsiderDb, PU('p0'))));

  // add: PM + sponsor yes (both collections); member no
  await assertSucceeds(setDoc(doc(pmDb, V('v1')), { name: 'Acme' }));
  await assertSucceeds(setDoc(doc(spDb, PU('p1')), { item: 'Servers', vendorId: 'v1' }));
  await assertFails(setDoc(doc(memberDb, V('v2')), { name: 'Nope' }));
  await assertFails(setDoc(doc(memberDb, PU('p2')), { item: 'Nope' }));

  // edit: PM yes, sponsor no
  await assertSucceeds(updateDoc(doc(pmDb, V('v0')), { category: 'Software' }));
  await assertSucceeds(updateDoc(doc(pmDb, PU('p0')), { status: 'Contracted', paidAmount: 250 }));
  await assertFails(updateDoc(doc(spDb, PU('p0')), { status: 'Closed' }));

  // delete: sponsor yes, PM no
  await assertFails(deleteDoc(doc(pmDb, PU('p0'))));
  await assertSucceeds(deleteDoc(doc(spDb, PU('p0'))));
  await assertFails(deleteDoc(doc(pmDb, V('v0'))));
  await assertSucceeds(deleteDoc(doc(spDb, V('v0'))));

  // grants on ANOTHER card (decisionLogCard: PM has add/edit/delete) must not help here
  await testEnv.withSecurityRulesDisabled(async (c) => {
    await updateDoc(doc(c.firestore(), 'businesses/biz-a/projects/proj-1'), { 'reportPermissions.procurementCard': { actions: {} } });
  });
  await assertFails(setDoc(doc(pmCtx().firestore(), PU('p9')), { item: 'nope' }));
  await assertSucceeds(setDoc(doc(ownerCtx().firestore(), PU('o1')), { item: 'Owner purchase' }));
});


// Saved status reports — readable only by the owner and the roles in allowedRoles.
test('status reports: a role reads/lists only reports whose allowedRoles include it; create is stamped; immutable; delete by owner/creator', async () => {
  await seed();
  const R = (id) => `businesses/biz-a/projects/proj-1/statusReports/${id}`;
  const col = 'businesses/biz-a/projects/proj-1/statusReports';
  const pmDb = pmCtx().firestore(), spDb = sponsorCtx().firestore();
  const memberDb = memberCtx().firestore(), outsiderDb = outsiderCtx().firestore();
  const ownerDb = ownerCtx().firestore();
  const base = (id, roles, over = {}) => ({
    fileName: 'Status.pdf', sections: ['projectStatusCard'], allowedRoles: roles,
    storagePath: `reports/biz-a/proj-1/${id}`,
    createdBy: OWNER_EMAIL, createdByUid: 'uid-owner', createdAt: new Date(), ...over,
  });

  await testEnv.withSecurityRulesDisabled(async (c) => {
    const adb = c.firestore();
    await setDoc(doc(adb, R('full')),   base('full',   ['projectManager', 'clientPartner']));   // budget-level report
    await setDoc(doc(adb, R('shared')), base('shared', ['projectManager', 'clientPartner', 'member']));
  });

  // single-document reads
  await assertSucceeds(getDoc(doc(pmDb, R('full'))));
  await assertFails(getDoc(doc(memberDb, R('full'))));     // member not in allowedRoles
  await assertSucceeds(getDoc(doc(memberDb, R('shared'))));
  await assertFails(getDoc(doc(outsiderDb, R('shared'))));
  await assertSucceeds(getDoc(doc(ownerDb, R('full'))));

  // the LIST each role actually runs
  const listFor = (db, role) => getDocs(query(collection(db, col), where('allowedRoles', 'array-contains', role)));
  const memberList = await assertSucceeds(listFor(memberDb, 'member'));
  assert.deepStrictEqual(memberList.docs.map((d) => d.id), ['shared']);
  const pmList = await assertSucceeds(listFor(pmDb, 'projectManager'));
  assert.deepStrictEqual(pmList.docs.map((d) => d.id).sort(), ['full', 'shared']);
  await assertFails(listFor(memberDb, 'projectManager'));  // can't ask for another role's reports
  await assertFails(getDocs(collection(memberDb, col)));    // unfiltered list is refused for a member
  await assertSucceeds(getDocs(collection(ownerDb, col)));  // owner sees everything

  // create: must be stamped as the caller, at server time, with the right storage path
  const mine = (id, extra = {}) => ({
    fileName: 'X.pdf', sections: ['projectStatusCard'], allowedRoles: ['member'],
    storagePath: `reports/biz-a/proj-1/${id}`, createdBy: 'membera@client.com', createdByUid: 'uid-memberA',
    createdAt: serverTimestamp(), ...extra,
  });
  await assertSucceeds(setDoc(doc(memberDb, R('m1')), mine('m1')));
  await assertFails(setDoc(doc(memberDb, R('m2')), mine('m2', { createdByUid: 'uid-pmA' })));       // forged author
  await assertFails(setDoc(doc(memberDb, R('m3')), mine('m3', { createdBy: 'pma@client.com' })));
  await assertFails(setDoc(doc(memberDb, R('m4')), mine('m4', { storagePath: 'reports/biz-a/proj-1/other' })));
  await assertFails(setDoc(doc(memberDb, R('m5')), mine('m5', { createdAt: new Date() })));         // client-side time
  await assertFails(setDoc(doc(memberDb, R('m6')), mine('m6', { allowedRoles: 'member' })));        // must be a list
  await assertFails(setDoc(doc(outsiderDb, R('m7')), mine('m7', { createdByUid: 'uid-outsider', createdBy: 'outsider@client.com' })));

  // immutable; delete only by owner or the creator
  await assertFails(updateDoc(doc(memberDb, R('m1')), { fileName: 'renamed.pdf' }));
  await assertFails(updateDoc(doc(ownerDb, R('m1')), { fileName: 'renamed.pdf' }));
  await assertFails(deleteDoc(doc(pmDb, R('m1'))));
  await assertSucceeds(deleteDoc(doc(memberDb, R('m1'))));
  await assertSucceeds(deleteDoc(doc(ownerDb, R('full'))));
});


// Project Documents import: the owner can create a HISTORICAL change request (already decided, original
// dates); nobody else can — members still can only submit a fresh, undecided request.
test('change requests: owner may import a decided historical request; members and sponsors still cannot', async () => {
  await seed();
  const CRp = (id) => `businesses/biz-a/projects/proj-1/changeRequests/${id}`;
  const historical = {
    title: 'Reduced AI scope', needsSponsorApproval: true, proposedBy: 'Imported', proposedByUid: '',
    createdAt: new Date('2026-02-10'), ownerDecision: 'approved', ownerDecidedAt: new Date('2026-02-10'),
    ownerDecidedBy: 'Imported change log', sponsorDecision: 'approved', source: 'import',
  };
  await assertSucceeds(setDoc(doc(ownerCtx().firestore(), CRp('imp_CR-001')), historical));
  await assertFails(setDoc(doc(memberCtx().firestore(), CRp('m1')), { ...historical, proposedBy: 'membera@client.com', proposedByUid: 'uid-memberA' }));
  await assertFails(setDoc(doc(sponsorCtx().firestore(), CRp('s1')), historical));
  // an ordinary member submission (pending, stamped as themselves, server time) is unchanged
  await assertSucceeds(setDoc(doc(memberCtx().firestore(), CRp('m2')), {
    title: 'New request', needsSponsorApproval: false, proposedBy: 'membera@client.com', proposedByUid: 'uid-memberA',
    createdAt: serverTimestamp(), ownerDecision: 'pending', sponsorDecision: 'n/a',
  }));
  // owner still cannot create one without a title
  await assertFails(setDoc(doc(ownerCtx().firestore(), CRp('bad')), { ...historical, title: '' }));
});


// Document Register — role-limited metadata, owner-only text, owner-only writes.
test('documents: a role lists only documents whose allowedRoles include it; the extracted text is owner-only; only the owner writes', async () => {
  await seed();
  const DOC = (id) => `businesses/biz-a/projects/proj-1/documents/${id}`;
  const TXT = (id) => `businesses/biz-a/projects/proj-1/documentText/${id}`;
  const col = 'businesses/biz-a/projects/proj-1/documents';
  const pmDb = pmCtx().firestore(), spDb = sponsorCtx().firestore(), memberDb = memberCtx().firestore(), outsiderDb = outsiderCtx().firestore(), ownerDb = ownerCtx().firestore();

  await testEnv.withSecurityRulesDisabled(async (c) => {
    const adb = c.firestore();
    await setDoc(doc(adb, DOC('bizcase')), { title: 'Business Case', allowedRoles: ['clientPartner'] });                      // sensitive
    await setDoc(doc(adb, DOC('charter')), { title: 'Project Charter', allowedRoles: ['clientPartner', 'projectManager', 'member'] });
    await setDoc(doc(adb, TXT('charter')), { sections: [{ title: 'Purpose', text: 'Purpose\nWhy we exist' }] });
  });

  // single reads
  await assertSucceeds(getDoc(doc(spDb, DOC('bizcase'))));
  await assertFails(getDoc(doc(pmDb, DOC('bizcase'))));
  await assertFails(getDoc(doc(memberDb, DOC('bizcase'))));
  await assertSucceeds(getDoc(doc(memberDb, DOC('charter'))));
  await assertFails(getDoc(doc(outsiderDb, DOC('charter'))));
  await assertSucceeds(getDoc(doc(ownerDb, DOC('bizcase'))));

  // the list each role runs
  const listFor = (db, role) => getDocs(query(collection(db, col), where('allowedRoles', 'array-contains', role)));
  assert.deepStrictEqual((await assertSucceeds(listFor(memberDb, 'member'))).docs.map((d) => d.id), ['charter']);
  assert.deepStrictEqual((await assertSucceeds(listFor(pmDb, 'projectManager'))).docs.map((d) => d.id), ['charter']);
  assert.deepStrictEqual((await assertSucceeds(listFor(spDb, 'clientPartner'))).docs.map((d) => d.id).sort(), ['bizcase', 'charter']);
  await assertFails(listFor(memberDb, 'clientPartner'));                      // can't ask for another role's documents
  await assertFails(getDocs(collection(memberDb, col)));                      // unfiltered list refused
  await assertSucceeds(getDocs(collection(ownerDb, col)));

  // extracted text: owner only — even a role that may read the document cannot read its text
  await assertSucceeds(getDoc(doc(ownerDb, TXT('charter'))));
  await assertFails(getDoc(doc(spDb, TXT('charter'))));
  await assertFails(getDoc(doc(memberDb, TXT('charter'))));
  await assertFails(setDoc(doc(spDb, TXT('x')), { sections: [] }));

  // writes: owner only
  await assertSucceeds(setDoc(doc(ownerDb, DOC('new')), { title: 'New', allowedRoles: ['member'] }));
  await assertSucceeds(updateDoc(doc(ownerDb, DOC('new')), { allowedRoles: ['member', 'projectManager'] }));
  await assertFails(setDoc(doc(spDb, DOC('mine')), { title: 'Mine', allowedRoles: ['clientPartner'] }));
  await assertFails(updateDoc(doc(spDb, DOC('bizcase')), { allowedRoles: ['member'] }));   // a role can't widen its own visibility
  await assertFails(deleteDoc(doc(pmDb, DOC('charter'))));
  await assertSucceeds(deleteDoc(doc(ownerDb, DOC('new'))));
});


// Project Documents "share privately" — only the owner and the named recipient may ever read one.
test('privateFiles: only the owner and sharedWithUid can read; only the owner writes', async () => {
  await seed();
  const PF = (id) => `businesses/biz-a/projects/proj-1/privateFiles/${id}`;
  const pmDb = pmCtx().firestore(), memberDb = memberCtx().firestore(), outsiderDb = outsiderCtx().firestore(), ownerDb = ownerCtx().firestore();

  await testEnv.withSecurityRulesDisabled(async (c) => {
    await setDoc(doc(c.firestore(), PF('f1')), {
      fileName: 'private.docx', sharedWithUid: 'uid-memberA', sharedWithEmail: 'membera@client.com', createdBy: OWNER_EMAIL,
    });
  });

  // reads: owner and the named recipient only
  await assertSucceeds(getDoc(doc(ownerDb, PF('f1'))));
  await assertSucceeds(getDoc(doc(memberDb, PF('f1'))));
  await assertFails(getDoc(doc(pmDb, PF('f1'))));           // a different project member — not the recipient
  await assertFails(getDoc(doc(outsiderDb, PF('f1'))));

  // writes: owner only, even for the recipient
  await assertSucceeds(setDoc(doc(ownerDb, PF('f2')), { fileName: 'x.docx', sharedWithUid: 'uid-pmA' }));
  await assertFails(setDoc(doc(memberDb, PF('f3')), { fileName: 'y.docx', sharedWithUid: 'uid-memberA' }));
  await assertFails(updateDoc(doc(memberDb, PF('f1')), { sharedWithUid: 'uid-pmA' }));   // recipient can't reassign it to themself-elsewhere
  await assertFails(updateDoc(doc(ownerDb, PF('f1')), { sharedWithUid: 'uid-pmA' }));    // updates blocked outright, even for the owner
  await assertFails(deleteDoc(doc(memberDb, PF('f1'))));
  await assertSucceeds(deleteDoc(doc(ownerDb, PF('f1'))));
});


// ---------------------------------------------------------------------------
// eventTaskLibrary — global, owner-managed
// ---------------------------------------------------------------------------

test('any signed-in user can read the global task library; only owner can write it', async () => {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'eventTaskLibrary/EVT-0001'), { eventType: 'Corporate Outing', taskName: 'Research Destinations' });
  });
  await assertSucceeds(getDoc(doc(memberCtx().firestore(), 'eventTaskLibrary/EVT-0001')));
  await assertFails(setDoc(doc(memberCtx().firestore(), 'eventTaskLibrary/EVT-0002'), { eventType: 'x' }));
  await assertSucceeds(setDoc(doc(ownerCtx().firestore(), 'eventTaskLibrary/EVT-0002'), { eventType: 'x' }));
});


// Ask the Project conversations — kept by their author; owner reads all; ended chats are frozen.
test('ask chats: author continues own open chat; owner reads every role; role/author are stamped; ended is frozen; delete owner-only', async () => {
  await seed();
  const C = (id) => `businesses/biz-a/projects/proj-1/askChats/${id}`;
  const col = 'businesses/biz-a/projects/proj-1/askChats';
  const pmDb = pmCtx().firestore(), memberDb = memberCtx().firestore();
  const outsiderDb = outsiderCtx().firestore(), ownerDb = ownerCtx().firestore();
  const mk = (uid, email, role, over = {}) => ({ uid, email, role, title: 'Scope?', status: 'open', messages: [{ r: 'user', t: 'hi' }], createdAt: new Date(), updatedAt: new Date(), ...over });

  // create: only as yourself, with your real role
  await assertSucceeds(setDoc(doc(memberDb, C('m1')), mk('uid-memberA', 'membera@client.com', 'member')));
  await assertFails(setDoc(doc(memberDb, C('m2')), mk('uid-memberA', 'membera@client.com', 'projectManager')));   // role forged
  await assertFails(setDoc(doc(memberDb, C('m3')), mk('uid-pmA', 'membera@client.com', 'member')));               // author forged
  await assertFails(setDoc(doc(memberDb, C('m4')), mk('uid-memberA', 'pma@client.com', 'member')));               // email forged
  await assertFails(setDoc(doc(memberDb, C('m5')), mk('uid-memberA', 'membera@client.com', 'member', { status: 'ended' })));
  await assertFails(setDoc(doc(outsiderDb, C('o1')), mk('uid-outsider', 'outsider@client.com', 'member')));      // not on the project
  await assertSucceeds(setDoc(doc(pmDb, C('p1')), mk('uid-pmA', 'pma@client.com', 'projectManager')));
  await assertSucceeds(setDoc(doc(ownerDb, C('w1')), mk('uid-owner', OWNER_EMAIL, 'owner')));

  // read: own only for a member; owner reads all
  await assertSucceeds(getDoc(doc(memberDb, C('m1'))));
  await assertFails(getDoc(doc(memberDb, C('p1'))));                    // another role's chat
  await assertFails(getDoc(doc(outsiderDb, C('m1'))));
  await assertSucceeds(getDoc(doc(ownerDb, C('p1'))));
  const mine = await assertSucceeds(getDocs(query(collection(memberDb, col), where('uid', '==', 'uid-memberA'))));
  assert.deepStrictEqual(mine.docs.map((d) => d.id), ['m1']);
  await assertFails(getDocs(collection(memberDb, col)));                // unfiltered list refused
  await assertFails(getDocs(query(collection(memberDb, col), where('uid', '==', 'uid-pmA'))));
  const all = await assertSucceeds(getDocs(collection(ownerDb, col)));
  assert.deepStrictEqual(all.docs.map((d) => d.id).sort(), ['m1', 'p1', 'w1']);

  // continue own open chat; can't change author/role; can't touch someone else's
  await assertSucceeds(updateDoc(doc(memberDb, C('m1')), { messages: [{ r: 'user', t: 'hi' }, { r: 'bot', t: 'hello' }], updatedAt: new Date() }));
  await assertFails(updateDoc(doc(memberDb, C('m1')), { role: 'projectManager' }));
  await assertFails(updateDoc(doc(memberDb, C('m1')), { uid: 'uid-pmA' }));
  await assertFails(updateDoc(doc(memberDb, C('p1')), { title: 'hijack' }));
  await assertFails(updateDoc(doc(ownerDb, C('p1')), { title: 'owner edits' }));   // the owner reads others' chats, doesn't rewrite them

  // ending freezes it
  await assertSucceeds(updateDoc(doc(memberDb, C('m1')), { status: 'ended', endedAt: new Date() }));
  await assertFails(updateDoc(doc(memberDb, C('m1')), { messages: [{ r: 'user', t: 'more' }] }));
  await assertSucceeds(getDoc(doc(memberDb, C('m1'))));                 // still readable

  // delete: owner only
  await assertFails(deleteDoc(doc(memberDb, C('m1'))));
  await assertSucceeds(deleteDoc(doc(ownerDb, C('m1'))));
});
