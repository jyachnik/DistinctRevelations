// /Public/contact-validate.js
const $ = (id) => document.getElementById(id);

const fields = [
  { el: () => $('cf-name'),    err: () => $('err-name'),    name: 'Name',    min: 2 },
  { el: () => $('cf-email'),   err: () => $('err-email'),   name: 'Email',   email: true },
  { el: () => $('cf-company'), err: () => $('err-company'), name: 'Company', min: 2 },
  { el: () => $('cf-message'), err: () => $('err-message'), name: 'Message', min: 10 },
];

// Simple, pragmatic email check (on top of type="email")
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

function setError(input, errEl, msg) {
  if (!input || !errEl) return;
  input.classList.add('is-invalid');
  input.classList.remove('is-valid');
  input.setAttribute('aria-invalid', 'true');
  errEl.textContent = msg;
}

function clearError(input, errEl) {
  if (!input || !errEl) return;
  input.classList.remove('is-invalid');
  input.classList.add('is-valid');
  input.removeAttribute('aria-invalid');
  errEl.textContent = '';
}

function validateOne(f) {
  const input = f.el();
  const errEl = f.err();
  if (!input) return true;

  const v = (input.value || '').trim();

  if (!v) { setError(input, errEl, `${f.name} is required.`); return false; }
  if (f.min && v.length < f.min) {
    setError(input, errEl, `${f.name} must be at least ${f.min} characters.`); return false;
  }
  if (f.email && !isEmail(v)) {
    setError(input, errEl, `Please enter a valid email address.`); return false;
  }

  clearError(input, errEl);
  return true;
}

function attachRealtimeValidation() {
  fields.forEach(f => {
    const input = f.el();
    if (!input) return;
    const handler = () => { if (input.classList.contains('is-invalid')) validateOne(f); };
    input.addEventListener('input', handler);
    input.addEventListener('blur', () => validateOne(f));
  });
}

document.addEventListener('DOMContentLoaded', () => {
  const form = $('contactForm');
  if (!form) return;
  const statusEl = $('cf-status');

  attachRealtimeValidation();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    // Validate all
    let ok = true;
    for (const f of fields) ok = validateOne(f) && ok;

    // Honeypot (bots fill hidden "website" field)
    const hp = form.querySelector('input[name="website"]');
    if (hp && hp.value) ok = false;

    if (!ok) {
      if (statusEl) { statusEl.style.color = '#ffb3b3'; statusEl.textContent = 'Please fix the highlighted fields.'; }
      // Focus first invalid
      const firstBad = form.querySelector('.is-invalid');
      if (firstBad) firstBad.focus();
      return;
    }

    // OPTIONAL: Submit via AJAX to Formspree (keeps you on the page/modal)
    try {
      const btn = form.querySelector('button[type="submit"]');
      if (btn) btn.disabled = true;
      if (statusEl) { statusEl.style.color = ''; statusEl.textContent = 'Sending…'; }

      const resp = await fetch(form.action, {
        method: 'POST',
        headers: { 'Accept': 'application/json' },
        body: new FormData(form)
      });

      if (resp.ok) {
        if (statusEl) { statusEl.style.color = '#7bd389'; statusEl.textContent = 'Thanks! Your message has been sent.'; }
        form.reset();
        // Clear valid states after reset
        form.querySelectorAll('.is-valid').forEach(n => n.classList.remove('is-valid'));

        // If the form lives in a modal, close it after a short pause
        const modal = form.closest('.modal');
        if (modal) setTimeout(() => {
          modal.setAttribute('aria-hidden', 'true');
          document.body.classList.remove('no-scroll');
        }, 900);
      } else {
        if (statusEl) { statusEl.style.color = '#ffb3b3'; statusEl.textContent = 'Could not send right now. Please try again.'; }
      }
      if (btn) btn.disabled = false;
    } catch (err) {
      console.error(err);
      if (statusEl) { statusEl.style.color = '#ffb3b3'; statusEl.textContent = 'Network error. Please try again.'; }
    }
  });
});