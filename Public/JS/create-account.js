// Public/JS/create-account.js
// Settings > Create Account — owner-only. Replaces the old public
// self-service signup flow (Public/JS/signup.js, retired): the owner picks
// an EXISTING company from a dropdown instead of typing a name freehand,
// which used to silently create a brand-new, separate business on any
// typo/inconsistent capitalization. The actual account creation happens
// server-side (functions/index.js's createCompanyAccount) rather than via
// the client SDK, since creating a Firebase Auth user client-side signs
// the CALLER out and into the new account — the Cloud Function uses the
// Admin SDK instead, which has no effect on the owner's own session.
//
// Same window.opener-callback pattern as permissions.js/
// manage-project-access.js: the popup has no Firebase access of its own,
// so it calls back into this (already-connected) page to do the actual
// work.

(function () {
  'use strict';

  var TAG = '[create-account]';
  function log() { console.log.apply(console, [TAG].concat(Array.prototype.slice.call(arguments))); }
  function error() { console.error.apply(console, [TAG].concat(Array.prototype.slice.call(arguments))); }

  var db = null;

  function permMessage(err) {
    return (err && err.code === 'permission-denied')
      ? "You don't have permission to do this."
      : ((err && err.message) ? err.message : 'Something went wrong.');
  }

  window.drCreateAccount = {
    listBusinesses: function () {
      if (!db) return Promise.resolve({ ok: false, message: 'Not ready yet — please try again.', businesses: [] });
      return db.collection('businesses').get().then(function (snap) {
        var businesses = snap.docs.map(function (d) {
          var data = d.data() || {};
          return { id: d.id, name: data.name || d.id };
        });
        businesses.sort(function (a, b) { return a.name.localeCompare(b.name); });
        return { ok: true, businesses: businesses };
      }).catch(function (err) {
        error('listBusinesses failed', err);
        return { ok: false, message: permMessage(err), businesses: [] };
      });
    },

    create: function (payload) {
      if (!window.functions) return Promise.resolve({ ok: false, message: 'Not ready yet — please try again.' });
      var callable = window.functions.httpsCallable('createCompanyAccount');
      return callable(payload || {}).then(function (result) {
        return { ok: true, message: 'Account created for ' + (result.data && result.data.email || payload.email) + '. Share the temporary password with them, or they can use "Forgot password" to set their own.' };
      }).catch(function (err) {
        error('create failed', err);
        return { ok: false, message: (err && err.message) ? err.message : 'Could not create the account.' };
      });
    }
  };

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  var NEW_COMPANY_SENTINEL = '__new__';

  function popupHtml(businesses) {
    var options = businesses.map(function (b) {
      return '<option value="' + esc(b.id) + '">' + esc(b.name) + '</option>';
    }).join('');
    return '<!doctype html><html><head><meta charset="utf-8"><title>Create Account</title><style>' +
      'body{font-family:Arial,Helvetica,sans-serif;margin:20px;color:#222;max-width:420px;}' +
      'h1{font-size:1.25rem;margin:0 0 2px;}' +
      'p.sub{color:#666;font-size:0.85rem;margin:0 0 18px;}' +
      'label{display:block;font-weight:600;font-size:0.85rem;margin:12px 0 4px;}' +
      'input,select{width:100%;padding:8px;border:1px solid #ccc;border-radius:6px;font-size:0.9rem;box-sizing:border-box;}' +
      '#newCompanyRow{display:none;}' +
      '#createBtn{margin-top:18px;padding:9px 16px;border-radius:6px;border:none;background:#0b5cff;color:#fff;font-size:0.9rem;cursor:pointer;}' +
      '#createBtn:disabled{background:#9db8e8;cursor:not-allowed;}' +
      '#status{font-size:0.85rem;margin-top:12px;min-height:1.2em;}' +
      '#status.ok{color:#2f9e44;}' +
      '#status.err{color:#dd3333;font-weight:600;}' +
      '</style></head><body>' +
      '<h1>Create Account</h1>' +
      '<p class="sub">Creates a new user account under an existing (or brand-new) company. Set a temporary password below and share it with them, or they can use "Forgot password" on the login page to set their own.</p>' +
      '<form id="createForm">' +
      '<label for="cFirst">First name</label><input id="cFirst" type="text" required />' +
      '<label for="cLast">Last name</label><input id="cLast" type="text" required />' +
      '<label for="cEmail">Email</label><input id="cEmail" type="email" required />' +
      '<label for="cPhone">Phone</label><input id="cPhone" type="tel" required />' +
      '<label for="cPass">Temporary password</label><input id="cPass" type="text" minlength="6" required />' +
      '<label for="cBiz">Company</label><select id="cBiz" required>' +
      '<option value="' + NEW_COMPANY_SENTINEL + '">➕ Add a New Company</option>' +
      (businesses.length ? options : '') +
      '</select>' +
      '<div id="newCompanyRow"><label for="cNewBiz">New company name</label><input id="cNewBiz" type="text" /></div>' +
      '<button type="submit" id="createBtn">Create Account</button>' +
      '</form>' +
      '<p id="status"></p>' +
      '<script>' +
      'var statusEl=document.getElementById("status");' +
      'var btn=document.getElementById("createBtn");' +
      'var bizSel=document.getElementById("cBiz");' +
      'var newRow=document.getElementById("newCompanyRow");' +
      'var newBizInput=document.getElementById("cNewBiz");' +
      'var NEW="' + NEW_COMPANY_SENTINEL + '";' +
      'function syncNewCompanyRow(){' +
      'var isNew=bizSel.value===NEW;' +
      'newRow.style.display=isNew?"block":"none";' +
      'newBizInput.required=isNew;' +
      '}' +
      'bizSel.addEventListener("change",syncNewCompanyRow);' +
      'syncNewCompanyRow();' +
      'document.getElementById("createForm").addEventListener("submit",function(e){' +
      'e.preventDefault();' +
      'if(!(window.opener&&window.opener.drCreateAccount)){statusEl.className="err";statusEl.textContent="Could not reach the dashboard tab — keep this window open alongside it.";return;}' +
      'var isNewCompany=bizSel.value===NEW;' +
      'var businessKey=isNewCompany?newBizInput.value.trim():bizSel.value;' +
      'if(isNewCompany&&!businessKey){statusEl.className="err";statusEl.textContent="Enter a name for the new company.";return;}' +
      'var payload={' +
      'firstName:document.getElementById("cFirst").value.trim(),' +
      'lastName:document.getElementById("cLast").value.trim(),' +
      'email:document.getElementById("cEmail").value.trim(),' +
      'phone:document.getElementById("cPhone").value.trim(),' +
      'password:document.getElementById("cPass").value,' +
      'businessKey:businessKey,' +
      'isNewCompany:isNewCompany' +
      '};' +
      'btn.disabled=true;statusEl.className="";statusEl.textContent="Creating…";' +
      'window.opener.drCreateAccount.create(payload).then(function(result){' +
      'btn.disabled=false;' +
      'statusEl.className=result.ok?"ok":"err";' +
      'statusEl.textContent=result.message;' +
      'if(result.ok){document.getElementById("createForm").reset();syncNewCompanyRow();}' +
      '});' +
      '});' +
      '<\/script>' +
      '</body></html>';
  }

  function openCreateAccountWindow() {
    if (!db) { alert('Still loading — please try again in a moment.'); return; }
    window.drCreateAccount.listBusinesses().then(function (res) {
      if (!res.ok) { alert('Could not load the company list: ' + res.message); return; }
      var win = window.open('', '_blank', 'width=480,height=640');
      if (!win) { alert('Please allow pop-ups to view Create Account in a new window.'); return; }
      win.document.open();
      win.document.write(popupHtml(res.businesses));
      win.document.close();
    });
  }

  window.drOpenCreateAccountWindow = openCreateAccountWindow;

  function start() {
    db = window.db || null;
    if (!db) { setTimeout(start, 200); return; }
    log('initialized');
  }

  start();
})();
