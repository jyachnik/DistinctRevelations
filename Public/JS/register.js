// scripts/register.js
import { getAuth, createUserWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/10.11.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  setDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js";

const auth = getAuth();
const db   = getFirestore();

const form   = document.getElementById("registerForm");
const status = document.getElementById("registerStatus");

form.addEventListener("submit", async e => {
  e.preventDefault();
  status.textContent = "Registering…";

  // collect form values
  const firstName        = form.firstName.value.trim();
  const lastName         = form.lastName.value.trim();
  const businessName     = form.businessName.value.trim();
  const businessCategory = form.businessCategory.value;
  const address1         = form.address1.value.trim();
  const address2         = form.address2.value.trim();
  const city             = form.city.value.trim();
  const state            = form.state.value.trim();
  const zip              = form.zip.value.trim();
  const email            = form.registerEmail.value.trim();
  const password         = form.registerPassword.value;
  const phone            = form.phone?.value.trim() || "";
  
  // generate a slug key for dashboard routing
  const businessKey = businessName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^\-|\-$)/g, "");

  try {
    // 1) Create Auth user
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    const uid  = cred.user.uid;

    // 2) Write user profile (approved: false)
    await setDoc(doc(db, "users", uid), {
      firstName,
      lastName,
      email,
      phone,
      address: { address1, address2, city, state, zip },
      businessKey,
      businessName,
      businessCategory,
      approved: false,
      createdAt: serverTimestamp()
    });

    // 3) Ensure business record exists
    await setDoc(doc(db, "businesses", businessKey), {
      ownerUid: uid,
      name:     businessName,
      category: businessCategory,
      createdAt: serverTimestamp()
    }, { merge: true });

    // 4) Link user under business
    await setDoc(doc(db, "businesses", businessKey, "users", uid), {
      fullName: `${firstName} ${lastName}`,
      email,
      phone,
      address: { address1, address2, city, state, zip },
      businessCategory,
      approved: false,
      createdAt: serverTimestamp()
    });

    // 5) Feedback to user
    status.textContent =
      "Thank you! Your registration is pending approval. " +
      "Once approved, you’ll receive an email and can access your dashboard.";

    form.reset();
  } catch (err) {
    console.error(err);
    status.textContent = err.message;
  }
});