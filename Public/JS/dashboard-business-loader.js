import { loadFileManager } from "./filemanager.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.11.0/firebase-auth.js";
import { app } from "./firebaseInit.js";

const auth = getAuth(app);
onAuthStateChanged(auth, user => {
  if (!user) return;
  const businessKey = new URLSearchParams(location.search).get("business");
  loadFileManager(businessKey, user.email);
});


