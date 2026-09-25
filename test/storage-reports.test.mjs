// Storage rules for saved status reports (reports/{biz}/{proj}/{reportId}).
// Run with both emulators up (Storage's firestore.get() calls the Firestore emulator):
//   firebase emulators:exec --only firestore,storage --project distinct-revelations-mp-test \
//     "cd test && node --test storage-reports.test.mjs"
import { test, before, after } from 'node:test';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import { doc, setDoc } from 'firebase/firestore';
import { ref, uploadBytes, getBytes, deleteObject } from 'firebase/storage';

const OWNER = 'john@distinctrevelations.com';
let env;

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'distinct-revelations-mp-test',
    firestore: { rules: readFileSync('../Public/firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 },
    storage: { rules: readFileSync('../Public/storage.rules', 'utf8'), host: '127.0.0.1', port: 9199 },
  });
  await env.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore();
    const P = 'businesses/biz-a/projects/proj-1';
    await setDoc(doc(db, `${P}/members/uid-member`), { role: 'member' });
    await setDoc(doc(db, `${P}/members/uid-pm`), { role: 'projectManager' });
    await setDoc(doc(db, `${P}/statusReports/full`), { allowedRoles: ['projectManager'] });
    await setDoc(doc(db, `${P}/statusReports/shared`), { allowedRoles: ['projectManager', 'member'] });
    const st = c.storage();
    const bytes = new Uint8Array([37, 80, 68, 70]); // "%PDF"
    for (const id of ['full', 'shared']) {
      await uploadBytes(ref(st, `reports/biz-a/proj-1/${id}`), bytes, { contentType: 'application/pdf', customMetadata: { ownerUid: 'uid-pm' } });
    }
  });
});
after(async () => { await env.cleanup(); });

const member = () => env.authenticatedContext('uid-member', { email: 'm@c.com' }).storage();
const pm = () => env.authenticatedContext('uid-pm', { email: 'pm@c.com' }).storage();
const outsider = () => env.authenticatedContext('uid-out', { email: 'o@c.com' }).storage();
const owner = () => env.authenticatedContext('uid-owner', { email: OWNER }).storage();
const R = (st, id) => ref(st, `reports/biz-a/proj-1/${id}`);
const pdf = new Uint8Array([37, 80, 68, 70]);
const meta = (uid) => ({ contentType: 'application/pdf', customMetadata: { ownerUid: uid } });

test('saved report files: read only by the owner and the roles in allowedRoles', async () => {
  await assertSucceeds(getBytes(R(pm(), 'full')));
  await assertFails(getBytes(R(member(), 'full')));        // member not allowed for the budget-level report
  await assertSucceeds(getBytes(R(member(), 'shared')));
  await assertFails(getBytes(R(outsider(), 'shared')));    // not a project member
  await assertSucceeds(getBytes(R(owner(), 'full')));
  await assertFails(getBytes(R(pm(), 'missing-record')));  // file/record mismatch never grants access
});

test('upload: member can upload a PDF', async () => { await assertSucceeds(uploadBytes(R(member(), 'new1'), pdf, meta('uid-member'))); });
test('upload: outsider cannot', async () => { await assertFails(uploadBytes(R(outsider(), 'new2'), pdf, meta('uid-out'))); });
test('upload: non-PDF refused', async () => { await assertFails(uploadBytes(R(member(), 'new3'), new Uint8Array([1, 2, 3]), { contentType: 'text/html', customMetadata: { ownerUid: 'uid-member' } })); });
test('upload: overwrite refused (no update)', async () => { await assertFails(uploadBytes(R(member(), 'new1'), pdf, meta('uid-member'))); });
test('delete: someone else cannot', async () => { await assertFails(deleteObject(R(pm(), 'new1'))); });
test('delete: creator can', async () => { await assertSucceeds(deleteObject(R(member(), 'new1'))); });
test('delete: owner can', async () => { await assertSucceeds(deleteObject(R(owner(), 'shared'))); });

// ---- Document Register originals: documents/{biz}/{proj}/{docId}
const D = (st, id) => ref(st, `documents/biz-a/proj-1/${id}`);
test('documents: seed originals', async () => {
  await env.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore(), st = c.storage();
    await setDoc(doc(db, 'businesses/biz-a/projects/proj-1/documents/bizcase'), { allowedRoles: ['projectManager'] });
    await setDoc(doc(db, 'businesses/biz-a/projects/proj-1/documents/charter'), { allowedRoles: ['projectManager', 'member'] });
    for (const id of ['bizcase', 'charter']) await uploadBytes(D(st, id), new Uint8Array([1, 2, 3]), { contentType: 'application/octet-stream' });
  });
});
test('documents: read only by the owner and the roles in allowedRoles', async () => {
  await assertSucceeds(getBytes(D(pm(), 'bizcase')));
  await assertFails(getBytes(D(member(), 'bizcase')));
  await assertSucceeds(getBytes(D(member(), 'charter')));
  await assertFails(getBytes(D(outsider(), 'charter')));
  await assertSucceeds(getBytes(D(owner(), 'bizcase')));
  await assertFails(getBytes(D(pm(), 'no-record')));
});
test('documents: only the owner uploads or deletes; no overwrite', async () => {
  await assertSucceeds(uploadBytes(D(owner(), 'new1'), new Uint8Array([9]), { contentType: 'application/octet-stream' }));
  await assertFails(uploadBytes(D(owner(), 'new1'), new Uint8Array([9]), { contentType: 'application/octet-stream' }));   // overwrite
  await assertFails(uploadBytes(D(pm(), 'new2'), new Uint8Array([9]), { contentType: 'application/octet-stream' }));
  await assertFails(deleteObject(D(pm(), 'charter')));
  await assertSucceeds(deleteObject(D(owner(), 'new1')));
});

// ---- Project Documents "share privately": privatefiles/{biz}/{proj}/{fileId}
const PF = (st, id) => ref(st, `privatefiles/biz-a/proj-1/${id}`);
test('privatefiles: seed a share', async () => {
  await env.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore(), st = c.storage();
    await setDoc(doc(db, 'businesses/biz-a/projects/proj-1/privateFiles/f1'), { sharedWithUid: 'uid-member' });
    await uploadBytes(PF(st, 'f1'), new Uint8Array([1, 2, 3]), { contentType: 'application/octet-stream' });
  });
});
test('privatefiles: read only by the owner and the named recipient', async () => {
  await assertSucceeds(getBytes(PF(owner(), 'f1')));
  await assertSucceeds(getBytes(PF(member(), 'f1')));
  await assertFails(getBytes(PF(pm(), 'f1')));            // a different project member — not the recipient
  await assertFails(getBytes(PF(outsider(), 'f1')));
  await assertFails(getBytes(PF(pm(), 'no-record')));
});
test('privatefiles: only the owner uploads or deletes; no overwrite', async () => {
  await assertSucceeds(uploadBytes(PF(owner(), 'new1'), new Uint8Array([9]), { contentType: 'application/octet-stream' }));
  await assertFails(uploadBytes(PF(owner(), 'new1'), new Uint8Array([9]), { contentType: 'application/octet-stream' }));  // overwrite
  await assertFails(uploadBytes(PF(member(), 'new2'), new Uint8Array([9]), { contentType: 'application/octet-stream' }));
  await assertFails(deleteObject(PF(member(), 'f1')));
  await assertSucceeds(deleteObject(PF(owner(), 'f1')));
});
