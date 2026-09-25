import { test, before, after } from 'node:test';
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import { ref, uploadBytes, getBytes, deleteObject, getMetadata } from 'firebase/storage';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const PROJECT_ID = 'distinct-revelations-storage-test';
const OWNER_EMAIL = 'john@distinctrevelations.com';
const bytes = new Uint8Array([1, 2, 3, 4]);

let testEnv;
let adminDb;

before(async () => {
  // Storage-only rules test environment (client SDK). Seeding is done
  // separately via firebase-admin below — mixing ctx.firestore() from
  // rules-unit-testing with a storage-only testEnv corrupts the underlying
  // Firebase App state, even though the actual cross-service
  // firestore.exists() check inside storage.rules works fine on its own.
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    storage: {
      rules: readFileSync('../Public/storage.rules', 'utf8'),
      host: '127.0.0.1',
      port: 9199,
    },
  });

  process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
  const adminApp = initializeApp({ projectId: PROJECT_ID }, 'storage-test-admin');
  adminDb = getFirestore(adminApp);

  // Seed membership rosters (admin SDK always bypasses rules).
  await adminDb.doc('businesses/biz-a/users/uid-memberA').set({ uid: 'uid-memberA', email: 'membera@client.com', role: 'member' });
  await adminDb.doc('businesses/biz-a/users/uid-memberA2').set({ uid: 'uid-memberA2', email: 'membera2@client.com', role: 'member' });
  await adminDb.doc('businesses/biz-b/users/uid-memberB').set({ uid: 'uid-memberB', email: 'memberb@client.com', role: 'member' });
});

after(async () => {
  await testEnv.cleanup();
});

function ownerCtx() {
  return testEnv.authenticatedContext('uid-owner', { email: OWNER_EMAIL });
}
function memberACtx() {
  return testEnv.authenticatedContext('uid-memberA', { email: 'membera@client.com' });
}
function memberA2Ctx() {
  return testEnv.authenticatedContext('uid-memberA2', { email: 'membera2@client.com' });
}
function memberBCtx() {
  return testEnv.authenticatedContext('uid-memberB', { email: 'memberb@client.com' });
}
function anonCtx() {
  return testEnv.unauthenticatedContext();
}

// The Storage emulator can lag briefly before a just-written object's custom
// metadata is visible to rule evaluation (resource.metadata) on a *different*
// request. Reading metadata back once after upload is a real network
// round-trip against the emulator's store and reliably clears that lag.
async function uploadAndSync(storageRef, data, metadata) {
  await uploadBytes(storageRef, data, metadata);
  await getMetadata(storageRef);
}

test('signed-out user cannot upload to any business file path', async () => {
  const storage = anonCtx().storage();
  const r = ref(storage, 'files/biz-a/test.txt');
  await assertFails(uploadBytes(r, bytes));
});

test('member of biz-a CAN upload into files/biz-a/...', async () => {
  const storage = memberACtx().storage();
  const r = ref(storage, 'files/biz-a/hello.txt');
  await assertSucceeds(uploadBytes(r, bytes, { customMetadata: { owner: 'membera@client.com', ownerUid: 'uid-memberA' } }));
});

test('member of biz-b CANNOT upload into files/biz-a/... (wrong business)', async () => {
  const storage = memberBCtx().storage();
  const r = ref(storage, 'files/biz-a/sneaky.txt');
  await assertFails(uploadBytes(r, bytes, { customMetadata: { owner: 'memberb@client.com', ownerUid: 'uid-memberB' } }));
});

test('member of biz-b cannot read a file that lives under files/biz-a/...', async () => {
  const memberAStorage = memberACtx().storage();
  await uploadAndSync(ref(memberAStorage, 'files/biz-a/readme.txt'), bytes, { customMetadata: { owner: 'membera@client.com', ownerUid: 'uid-memberA' } });

  const storage = memberBCtx().storage();
  await assertFails(getBytes(ref(storage, 'files/biz-a/readme.txt')));
});

test('uploader CAN delete their own file', async () => {
  const storage = memberACtx().storage();
  const path = 'files/biz-a/mine.txt';
  await uploadAndSync(ref(storage, path), bytes, { customMetadata: { owner: 'membera@client.com', ownerUid: 'uid-memberA' } });
  await assertSucceeds(deleteObject(ref(storage, path)));
});

test('a different member of the SAME business cannot delete a file they did not upload', async () => {
  const memberAStorage = memberACtx().storage();
  await uploadAndSync(ref(memberAStorage, 'files/biz-a/not-yours.txt'), bytes, { customMetadata: { owner: 'membera@client.com', ownerUid: 'uid-memberA' } });

  const memberA2Storage = memberA2Ctx().storage();
  await assertFails(deleteObject(ref(memberA2Storage, 'files/biz-a/not-yours.txt')));
});

test('owner can delete any file in any business', async () => {
  const memberBStorage = memberBCtx().storage();
  await uploadAndSync(ref(memberBStorage, 'files/biz-b/owner-can-delete.txt'), bytes, { customMetadata: { owner: 'memberb@client.com', ownerUid: 'uid-memberB' } });

  const ownerStorage = ownerCtx().storage();
  await assertSucceeds(deleteObject(ref(ownerStorage, 'files/biz-b/owner-can-delete.txt')));
});

test('only owner can upload a business logo', async () => {
  const memberStorage = memberACtx().storage();
  await assertFails(uploadBytes(ref(memberStorage, 'logos/biz-a/logo.png'), bytes));

  const ownerStorage = ownerCtx().storage();
  await assertSucceeds(uploadBytes(ref(ownerStorage, 'logos/biz-a/logo.png'), bytes));
});

test('member CAN read their own business logo, but not another business logo', async () => {
  const ownerStorage = ownerCtx().storage();
  await uploadAndSync(ref(ownerStorage, 'logos/biz-a/logo2.png'), bytes);

  const memberAStorage = memberACtx().storage();
  await assertSucceeds(getBytes(ref(memberAStorage, 'logos/biz-a/logo2.png')));

  const memberBStorage = memberBCtx().storage();
  await assertFails(getBytes(ref(memberBStorage, 'logos/biz-a/logo2.png')));
});
