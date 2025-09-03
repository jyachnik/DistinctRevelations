// /Public/lets-talk.js
const { auth, db } = window;
import {
  collection, doc, setDoc, addDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js";

const $ = (id) => document.getElementById(id);
const statusEl = () => $("cf-status");

const CATEGORIES = [
  "Agriculture, Forestry, Fishing & Hunting",
  "Mining, Quarrying, & Oil and Gas Extraction",
  "Utilities",
  "Construction",
  "Manufacturing",
  "Wholesale Trade",
  "Retail Trade",
  "Transportation & Warehousing",
  "Information",
  "Finance & Insurance",
  "Real Estate & Rental & Leasing",
  "Professional, Scientific & Technical Services",
  "Management of Companies & Enterprises",
  "Administrative & Support & Waste Management & Remediation Services",
  "Educational Services",
  "Health Care & Social Assistance",
  "Arts, Entertainment & Recreation",
  "Accommodation & Food Services",
  "Other Services (except Public Administration)",
  "Public Administration",
];

// simple helpers
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
const isPhone = (v) => v.replace(/[^\d]/g,"").length >= 10; // pragmatic 10+ digits

function setError(input, errEl, msg){ input.classList.add("is-invalid"); input.classList.remove("is-valid"); errEl.textContent = msg; }
function clearError(input, errEl){ input.classList.remove("is-invalid"); input.classList.add("is-valid"); errEl.textContent = ""; }

function slugify(name){
  return name.toLowerCase()
    .replace(/['’]/g,"")       // drop apostrophes
    .replace(/[^a-z0-9]+/g,"-") // non-alphanum → dash
    .replace(/^-+|-+$/g,"")     // trim dashes
    .slice(0, 64);              // keep reasonable length
}

function populateCategories(){
  const sel = $("cf-category");
  if (!sel) return;
  sel.innerHTML = `<option value="" selected disabled>Select a category</option>` +
    CATEGORIES.map(c => `<option value="${c}">${c}</option>`).join("");
}

function attachRealtimeValidation(){
  const fields = [
    {id:"cf-first",    name:"First name",   check:(v)=>v.trim().length>0 },
    {id:"cf-last",     name:"Last name",    check:(v)=>v.trim().length>0 },
    {id:"cf-business", name:"Business name",check:(v)=>v.trim().length>1 },
    {id:"cf-category", name:"Business category", check:(v)=>!!v },
    {id:"cf-email",    name:"Email",        check:isEmail },
    {id:"cf-phone",    name:"Phone",        check:isPhone },
    {id:"cf-message",  name:"Message",      check:(v)=>v.trim().length>=5 },
  ];

  fields.forEach(f=>{
    const el = $(f.id), err = $(`err-${f.id.split("cf-")[1]}`);
    if (!el || !err) return;
    const run = ()=>{ f.check(el.value) ? clearError(el,err) : setError(el,err, `${f.name} is required${f.id==="cf-email"?" (valid email)":""}.`); };
    el.addEventListener("input", ()=>{ if (el.classList.contains("is-invalid")) run(); });
    el.addEventListener("blur", run);
  });
}


async function saveToFirebase(payload){
  const businessKey = slugify(payload.businessName);

  // Try to upsert the business doc (admin-managed). Ignore admin-only failures.
  try {
    await setDoc(
      doc(db, "businesses", businessKey),
      { name: payload.businessName, category: payload.category, updatedAt: serverTimestamp() },
      { merge: true }
    );
  } catch (e) {
    if (e.code !== "permission-denied" && e.code !== "failed-precondition") {
      throw e; // unexpected error (network, config, etc.) -> bubble up
    }
    // continue; inquiries are allowed publicly
  }

  // Always record the inquiry (public create allowed by rules)
  await addDoc(
    collection(db, "businesses", businessKey, "inquiries"),
    {
      firstName: payload.firstName,
      lastName:  payload.lastName,
      email:     payload.email,
      phone:     payload.phone,
      message:   payload.message,
      category:  payload.category,
      createdAt: serverTimestamp(),
      source: "website-lets-talk"
    }
  );
}

document.addEventListener("DOMContentLoaded", () => {
  populateCategories();
  attachRealtimeValidation();

  const form = $("contactForm");
  if (!form) return;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    // honeypot
    const hp = form.querySelector('input[name="website"]');
    if (hp && hp.value) return;

    const data = {
      firstName: $("cf-first").value.trim(),
      lastName:  $("cf-last").value.trim(),
      businessName: $("cf-business").value.trim(),
      category:  $("cf-category").value,
      email:     $("cf-email").value.trim(),
      phone:     $("cf-phone").value.trim(),
      message:   $("cf-message").value.trim(),
    };

    // validate
    const errs = {
      first:    !data.firstName,
      last:     !data.lastName,
      business: !data.businessName,
      category: !data.category,
      email:    !isEmail(data.email),
      phone:    !isPhone(data.phone),
      message:  data.message.length < 5,
    };
    // show errors
    Object.entries(errs).forEach(([k, bad])=>{
      const input = $(`cf-${k==="business" ? "business":k}`);
      const errEl = $(`err-${k}`);
      if (!input || !errEl) return;
      bad ? setError(input, errEl, `${(k==="cf-email")?"Valid email required.":"This field is required."}`)
          : clearError(input, errEl);
    });
    if (Object.values(errs).some(Boolean)) {
      if (statusEl()) { statusEl().style.color = "#ffb3b3"; statusEl().textContent = "Please fix the highlighted fields."; }
      const firstBad = form.querySelector(".is-invalid"); if (firstBad) firstBad.focus();
      return;
    }

    // submit to Firestore
    try {
      const btn = form.querySelector('button[type="submit"]'); if (btn) btn.disabled = true;
      if (statusEl()) { statusEl().style.color = ""; statusEl().textContent = "Sending…"; }

      await saveToFirebase(data);

      if (statusEl()) { statusEl().style.color = "#7bd389"; statusEl().textContent = "Thanks! We’ll be in touch soon."; }
      form.reset();
      form.querySelectorAll(".is-valid").forEach(n=>n.classList.remove("is-valid"));

      // if inside a modal, close after a short pause
      const modal = form.closest(".modal");
      if (modal) setTimeout(()=>{ modal.setAttribute("aria-hidden","true"); document.body.classList.remove("no-scroll"); }, 900);

      if (btn) btn.disabled = false;
    } catch (err) {
  console.error("lets-talk submit error:", err);
  const msg = (err && err.code)
    ? `Error: ${err.code}. ${err.message || ""}`
    : "Could not send right now. Please try again.";
  const st = document.getElementById("cf-status");
  if (st) { st.style.color = "#ffb3b3"; st.textContent = msg; }
}
  });
});