// header.js
import { auth, db } from "../firebaseInit.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.11.0/firebase-auth.js";
import { doc, getDoc, updateDoc } from "https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js";
import { getStorage, ref as storageRef, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.11.0/firebase-storage.js";

const OWNER_EMAIL = "john@distinctrevelations.com";

function getBusinessKey() {
  return new URLSearchParams(location.search).get("business");
}

onAuthStateChanged(auth, async user => {
  if (!user) return;
  const businessKey = getBusinessKey();
  if (!businessKey) return console.error("No business key");
  
  const header      = document.getElementById("dashboardHeader");
  const companyName = document.getElementById("companyName");
  const logoImg     = document.getElementById("companyLogo");
  const fileInput   = document.getElementById("logoFileInput");
  const storage     = getStorage();

  // Load existing data
  try {
    const snap = await getDoc(doc(db, "businesses", businessKey));
    if (snap.exists()) {
      const data = snap.data();
      companyName.textContent = data.name || businessKey;
      if (data.logoUrl) logoImg.src = data.logoUrl;
    }
  } catch (e) {
    console.error("Load business failed:", e);
  }

  // Owner-only
  if (user.email === OWNER_EMAIL) {
    header.classList.add("owner");

    fileInput.addEventListener("change", async () => {
      const file = fileInput.files[0];
      if (!file) return;

      const path = `logos/${businessKey}/${file.name}`;
      const ref  = storageRef(storage, path);
      try {
        await uploadBytes(ref, file);
        const url = await getDownloadURL(ref);
        await updateDoc(doc(db, "businesses", businessKey), { logoUrl: url });
        logoImg.src = url;
        console.log("Logo updated:", url);
      } catch (err) {
        console.error("Upload error:", err);
        alert("Logo upload failed. See console.");
      }
    });
  }
});