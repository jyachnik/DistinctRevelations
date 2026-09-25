import { test, before, after, beforeEach } from 'node:test';
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import {
  doc, setDoc, getDoc, deleteDoc, updateDoc, collection, addDoc, getDocs,
} from 'firebase/firestore';

const PROJECT_ID = 'distinct-revelations-test';
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

// ---------------------------------------------------------------------------
// Seed helper: bypasses rules entirely (admin SDK context) to set up fixture
// data the way the real app would leave it.
// ---------------------------------------------------------------------------
async function seed() {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();

    // Business A, with memberA as its only member.
    await setDoc(doc(db, 'businesses/biz-a'), { name: 'Biz A', nameLower: 'biz a', projectStatus: 'onTrack' });
    await setDoc(doc(db, 'businesses/biz-a/users/uid-memberA'), { uid: 'uid-memberA', email: 'membera@client.com', role: 'member' });

    // Business B, with memberB as its only member.
    await setDoc(doc(db, 'businesses/biz-b'), { name: 'Biz B', nameLower: 'biz b', projectStatus: 'onTrack' });
    await setDoc(doc(db, 'businesses/biz-b/users/uid-memberB'), { uid: 'uid-memberB', email: 'memberb@client.com', role: 'member' });

    // A qna item in biz-a created by memberA.
    await setDoc(doc(db, 'businesses/biz-a/qna/qna1'), {
      type: 'Question', message: 'hi', createdBy: 'membera@client.com', createdByUid: 'uid-memberA', completed: false,
    });

    // A file in biz-a uploaded by memberA.
    await setDoc(doc(db, 'businesses/biz-a/files/file1'), {
      fileName: 'a.pdf', owner: 'membera@client.com', ownerUid: 'uid-memberA',
    });

    // An activity entry in biz-a (owner-authored).
    await setDoc(doc(db, 'businesses/biz-a/activities/act1'), {
      title: 'Kickoff', status: 'Completed', createdBy: OWNER_EMAIL,
    });

    // A milestone in biz-a.
    await setDoc(doc(db, 'businesses/biz-a/milestones/m1'), { title: 'Kickoff call', status: 'On-site' });
  });
}

function ownerCtx() {
  return testEnv.authenticatedContext('uid-owner', { email: OWNER_EMAIL });
}
function memberACtx() {
  return testEnv.authenticatedContext('uid-memberA', { email: 'membera@client.com' });
}
function memberBCtx() {
  return testEnv.authenticatedContext('uid-memberB', { email: 'memberb@client.com' });
}
function anonCtx() {
  return testEnv.unauthenticatedContext();
}

// ---------------------------------------------------------------------------
// Business-level access scoping
// ---------------------------------------------------------------------------

test('signed-out user cannot read a business doc', async () => {
  await seed();
  const db = anonCtx().firestore();
  await assertFails(getDoc(doc(db, 'businesses/biz-a')));
});

test('member of biz-a can read biz-a', async () => {
  await seed();
  const db = memberACtx().firestore();
  await assertSucceeds(getDoc(doc(db, 'businesses/biz-a')));
});

test('member of biz-a CANNOT read biz-b (cross-business access blocked)', async () => {
  await seed();
  const db = memberACtx().firestore();
  await assertFails(getDoc(doc(db, 'businesses/biz-b')));
});

test('owner can read both biz-a and biz-b', async () => {
  await seed();
  const db = ownerCtx().firestore();
  await assertSucceeds(getDoc(doc(db, 'businesses/biz-a')));
  await assertSucceeds(getDoc(doc(db, 'businesses/biz-b')));
});

test('member of biz-a cannot write biz-a business metadata (owner-only)', async () => {
  await seed();
  const db = memberACtx().firestore();
  await assertFails(updateDoc(doc(db, 'businesses/biz-a'), { projectStatus: 'critical' }));
});

test('owner CAN write business metadata (projectStatus/projectProgress)', async () => {
  await seed();
  const db = ownerCtx().firestore();
  await assertSucceeds(updateDoc(doc(db, 'businesses/biz-a'), { projectStatus: 'critical' }));
});

test('a non-owner CANNOT create a brand-new business (self-service signup retired)', async () => {
  await seed();
  const db = memberACtx().firestore();
  await assertFails(setDoc(doc(db, 'businesses/brand-new-co'), { name: 'Brand New Co', nameLower: 'brand new co' }));
});

test('only the owner can create a brand-new business (Create Account tool)', async () => {
  await seed();
  const db = ownerCtx().firestore();
  await assertSucceeds(setDoc(doc(db, 'businesses/brand-new-co'), { name: 'Brand New Co', nameLower: 'brand new co' }));
});

// ---------------------------------------------------------------------------
// Membership roster (businesses/{biz}/users/{uid})
// ---------------------------------------------------------------------------

test('a user can no longer create their OWN membership record under a business (self-service signup retired)', async () => {
  await seed();
  const db = memberACtx().firestore();
  await assertFails(setDoc(doc(db, 'businesses/biz-a/users/uid-memberA2'), { uid: 'uid-memberA2', email: 'membera2@client.com', role: 'member' }));
});

test('only the owner can create a membership record now (Create Account tool)', async () => {
  await seed();
  const db = ownerCtx().firestore();
  await assertSucceeds(setDoc(doc(db, 'businesses/biz-a/users/uid-memberA2'), { uid: 'uid-memberA2', email: 'membera2@client.com', role: 'member' }));
});

test('a user CANNOT create a membership record for someone else', async () => {
  await seed();
  const db = memberACtx().firestore();
  await assertFails(setDoc(doc(db, 'businesses/biz-a/users/uid-someoneElse'), { uid: 'uid-someoneElse', email: 'x@y.com', role: 'member' }));
});

test('member of biz-b cannot read the biz-a membership roster', async () => {
  await seed();
  const db = memberBCtx().firestore();
  await assertFails(getDocs(collection(db, 'businesses/biz-a/users')));
});

// ---------------------------------------------------------------------------
// Q&A: cross-business + own-artifact-only edit/delete
// ---------------------------------------------------------------------------

test('member of biz-a can create a qna item in biz-a', async () => {
  await seed();
  const db = memberACtx().firestore();
  await assertSucceeds(addDoc(collection(db, 'businesses/biz-a/qna'), {
    type: 'Question', message: 'new q', createdBy: 'membera@client.com', createdByUid: 'uid-memberA', completed: false,
  }));
});

test('member of biz-b CANNOT create a qna item in biz-a (wrong business)', async () => {
  await seed();
  const db = memberBCtx().firestore();
  await assertFails(addDoc(collection(db, 'businesses/biz-a/qna'), {
    type: 'Question', message: 'sneaky', createdBy: 'memberb@client.com', createdByUid: 'uid-memberB', completed: false,
  }));
});

test('member CAN edit/delete a qna item they created', async () => {
  await seed();
  const db = memberACtx().firestore();
  await assertSucceeds(updateDoc(doc(db, 'businesses/biz-a/qna/qna1'), { completed: true }));
});

test('member CANNOT edit/delete a qna item someone else in the SAME business created', async () => {
  await seed();
  // Add a second member to biz-a who did not create qna1.
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'businesses/biz-a/users/uid-memberA2'), { uid: 'uid-memberA2', email: 'membera2@client.com', role: 'member' });
  });
  const db = testEnv.authenticatedContext('uid-memberA2', { email: 'membera2@client.com' }).firestore();
  await assertFails(updateDoc(doc(db, 'businesses/biz-a/qna/qna1'), { completed: true }));
  await assertFails(deleteDoc(doc(db, 'businesses/biz-a/qna/qna1')));
});

test('owner CAN edit/delete any qna item regardless of creator', async () => {
  await seed();
  const db = ownerCtx().firestore();
  await assertSucceeds(updateDoc(doc(db, 'businesses/biz-a/qna/qna1'), { completed: true }));
});

// ---------------------------------------------------------------------------
// Files: cross-business + own-artifact-only edit/delete (uid-based)
// ---------------------------------------------------------------------------

test('member of biz-b cannot read biz-a files', async () => {
  await seed();
  const db = memberBCtx().firestore();
  await assertFails(getDoc(doc(db, 'businesses/biz-a/files/file1')));
});

test('member CAN delete their OWN file (matched by ownerUid)', async () => {
  await seed();
  const db = memberACtx().firestore();
  await assertSucceeds(deleteDoc(doc(db, 'businesses/biz-a/files/file1')));
});

test('a different member of the SAME business CANNOT delete a file they did not upload', async () => {
  await seed();
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'businesses/biz-a/users/uid-memberA2'), { uid: 'uid-memberA2', email: 'membera2@client.com', role: 'member' });
  });
  const db = testEnv.authenticatedContext('uid-memberA2', { email: 'membera2@client.com' }).firestore();
  await assertFails(deleteDoc(doc(db, 'businesses/biz-a/files/file1')));
});

// ---------------------------------------------------------------------------
// Activities + Milestones: owner-managed, member read-only
// ---------------------------------------------------------------------------

test('member can READ activities in their business', async () => {
  await seed();
  const db = memberACtx().firestore();
  await assertSucceeds(getDoc(doc(db, 'businesses/biz-a/activities/act1')));
});

test('member CANNOT create/edit/delete activities (owner-only feature)', async () => {
  await seed();
  const db = memberACtx().firestore();
  await assertFails(updateDoc(doc(db, 'businesses/biz-a/activities/act1'), { status: 'In Progress' }));
  await assertFails(addDoc(collection(db, 'businesses/biz-a/activities'), { title: 'sneaky', status: 'Not Started', createdBy: 'membera@client.com' }));
});

test('member CANNOT create/edit/delete milestones (owner-only feature)', async () => {
  await seed();
  const db = memberACtx().firestore();
  await assertFails(updateDoc(doc(db, 'businesses/biz-a/milestones/m1'), { status: 'Virtual' }));
});

test('owner CAN manage activities and milestones', async () => {
  await seed();
  const db = ownerCtx().firestore();
  await assertSucceeds(updateDoc(doc(db, 'businesses/biz-a/activities/act1'), { status: 'In Progress' }));
  await assertSucceeds(updateDoc(doc(db, 'businesses/biz-a/milestones/m1'), { status: 'Virtual' }));
});
