// Public/JS/manage-project-access.js
// Settings > Manage Project Access — owner-only. A genuinely separate
// browser window (same pattern as permissions.js's openPermissionsWindow)
// for creating projects under this business and assigning each project's
// members a role (Client Partner, Project Manager, Admin, Member — the
// same 5-role vocabulary as Permissions, minus "Owner", which is never
// assigned via project membership since the real owner is always the
// hardcoded platform-owner email, not a role on a members doc).
//
// Phase 1 of the multi-project feature: this only builds
// businesses/{biz}/projects/{proj} and its members subcollection. No card
// on the dashboard reads project-scoped data yet — every project shares
// the same company-level data until Phase 2 rewires each module's
// Firestore paths.

(function () {
  'use strict';

  var TAG = '[manage-project-access]';
  function log() { console.log.apply(console, [TAG].concat(Array.prototype.slice.call(arguments))); }
  function error() { console.error.apply(console, [TAG].concat(Array.prototype.slice.call(arguments))); }

  var db = null;
  var bizKey = null;

  var MEMBER_ROLES = [
    { key: 'clientPartner', label: 'Client Partner' },
    { key: 'projectManager', label: 'Project Manager' },
    { key: 'admin', label: 'Admin' },
    { key: 'member', label: 'Member' }
  ];

  function projectsRef() {
    return db.collection('businesses').doc(bizKey).collection('projects');
  }
  function businessUsersRef() {
    return db.collection('businesses').doc(bizKey).collection('users');
  }
  function currentEmail() {
    return (window.auth && window.auth.currentUser && window.auth.currentUser.email) || null;
  }
  function serverTimestamp() {
    return firebase.firestore.FieldValue.serverTimestamp();
  }
  function permMessage(err) {
    return (err && err.code === 'permission-denied')
      ? "You don't have permission to do this."
      : ((err && err.message) ? err.message : 'Something went wrong.');
  }

  // Every method resolves to {ok, message, ...} — never rejects — so the
  // popup can always show the user what happened.
  window.drProjectAccess = {
    listProjects: function () {
      if (!db || !bizKey) return Promise.resolve({ ok: false, message: 'Not ready yet — please try again.', projects: [] });
      return projectsRef().get().then(function (projSnap) {
        // 'default' is the legacy-data mirror's internal fallback shell
        // (functions/index.js's ensureDefaultProject, re-created any time
        // an old flat-data path gets written to) — not a real project
        // anyone created here, so it's hidden from this admin list too.
        var projects = projSnap.docs
          .filter(function (d) { return d.id !== 'default'; })
          .map(function (d) { return { id: d.id, name: (d.data() || {}).name || d.id }; });
        return Promise.all(projects.map(function (p) {
          return projectsRef().doc(p.id).collection('members').get().then(function (memSnap) {
            p.members = memSnap.docs.map(function (m) {
              var md = m.data() || {};
              return { uid: m.id, email: md.email || '', role: md.role || 'member' };
            });
            return p;
          });
        })).then(function (withMembers) {
          withMembers.sort(function (a, b) { return a.name.localeCompare(b.name); });
          return { ok: true, projects: withMembers };
        });
      }).catch(function (err) {
        error('listProjects failed', err);
        return { ok: false, message: permMessage(err), projects: [] };
      });
    },

    createProject: function (name) {
      if (!db || !bizKey) return Promise.resolve({ ok: false, message: 'Not ready yet — please try again.' });
      var trimmed = (name || '').trim();
      if (!trimmed) return Promise.resolve({ ok: false, message: 'Project name is required.' });
      // A new project starts with the same report/action permissions as
      // this company's most recently created project that has any set
      // (falling back to 'default'), instead of an empty matrix — the
      // Permissions screen stores them per project, so without this every
      // new project starts with every non-owner role locked out.
      return projectsRef().get().then(function (snap) {
        var candidates = snap.docs.map(function (d) {
          var data = d.data() || {};
          var created = data.createdAt && data.createdAt.toMillis ? data.createdAt.toMillis() : 0;
          return { id: d.id, perms: data.reportPermissions, created: created };
        }).filter(function (c) { return c.perms && Object.keys(c.perms).length; });
        candidates.sort(function (a, b) {
          if (a.id === 'default' && b.id !== 'default') return 1;
          if (b.id === 'default' && a.id !== 'default') return -1;
          return b.created - a.created;
        });
        var doc = { name: trimmed, createdAt: serverTimestamp(), createdBy: currentEmail() };
        if (candidates.length) doc.reportPermissions = JSON.parse(JSON.stringify(candidates[0].perms));
        return projectsRef().add(doc).then(function (ref) {
          return {
            ok: true,
            message: candidates.length
              ? 'Project created (permissions copied from an existing project).'
              : 'Project created. No permissions set yet — use Settings ▸ Permissions.',
            id: ref.id
          };
        });
      }).catch(function (err) {
        error('createProject failed', err);
        return { ok: false, message: permMessage(err) };
      });
    },

    renameProject: function (projectId, name) {
      if (!db || !bizKey) return Promise.resolve({ ok: false, message: 'Not ready yet — please try again.' });
      var trimmed = (name || '').trim();
      if (!trimmed) return Promise.resolve({ ok: false, message: 'Project name is required.' });
      return projectsRef().doc(projectId).update({ name: trimmed }).then(function () {
        return { ok: true, message: 'Renamed.' };
      }).catch(function (err) {
        error('renameProject failed', err);
        return { ok: false, message: permMessage(err) };
      });
    },

    deleteProject: function (projectId) {
      if (!db || !bizKey) return Promise.resolve({ ok: false, message: 'Not ready yet — please try again.' });
      var ref = projectsRef().doc(projectId);
      return ref.collection('members').get().then(function (memSnap) {
        var batch = db.batch();
        memSnap.docs.forEach(function (m) {
          batch.delete(m.ref);
          // Keep each member's businesses/{biz}/users/{uid}.projectIds in
          // sync — that array is how select-project.js finds a non-owner's
          // visible projects without ever having to LIST the projects
          // collection (a plain, unfiltered list is denied for non-owners
          // by Firestore's rules — see addMember()'s comment below).
          batch.update(businessUsersRef().doc(m.id), {
            projectIds: firebase.firestore.FieldValue.arrayRemove(projectId)
          });
        });
        batch.delete(ref);
        return batch.commit();
      }).then(function () {
        return { ok: true, message: 'Project deleted.' };
      }).catch(function (err) {
        error('deleteProject failed', err);
        return { ok: false, message: permMessage(err) };
      });
    },

    addMember: function (projectId, email, role) {
      if (!db || !bizKey) return Promise.resolve({ ok: false, message: 'Not ready yet — please try again.' });
      var trimmedEmail = (email || '').trim().toLowerCase();
      if (!trimmedEmail) return Promise.resolve({ ok: false, message: 'Email is required.' });
      if (!MEMBER_ROLES.some(function (r) { return r.key === role; })) {
        return Promise.resolve({ ok: false, message: 'Invalid role.' });
      }
      var NO_USER_MSG = 'No user in this company found with that email. They must already be a company member (see Data Imports / user setup) before being added to a project.';

      // Which user record is the person's real login? Ask Firebase
      // Authentication (server-side, resolveMemberUid) — never guess from
      // email alone, since a company can hold stale duplicate user docs for
      // one email (deleted-and-recreated accounts) and picking the wrong one
      // leaves the person unable to see the project. Resolves to
      // { uid, email } / { error } — never rejects.
      function resolveTarget() {
        var callable = window.functions && window.functions.httpsCallable
          ? window.functions.httpsCallable('resolveMemberUid') : null;
        if (!callable) return Promise.resolve({ fallback: true });
        return callable({ email: trimmedEmail }).then(function (res) {
          var uid = res && res.data && res.data.uid;
          if (!uid) return { fallback: true };
          return businessUsersRef().doc(uid).get().then(function (snap) {
            if (!snap.exists) return { error: NO_USER_MSG };
            return { uid: uid, email: (snap.data() || {}).email || trimmedEmail };
          });
        }).catch(function (err) {
          if (err && err.code === 'functions/not-found') {
            return { error: 'No login account exists for that email.' };
          }
          if (err && err.code === 'functions/permission-denied') {
            return { error: "You don't have permission to do this." };
          }
          // Function unavailable (offline / not deployed): fall back to the
          // email match below, which refuses if it's ambiguous.
          error('resolveMemberUid unavailable, falling back to email match', err);
          return { fallback: true };
        });
      }

      function fallbackTarget() {
        return businessUsersRef().get().then(function (snap) {
          var matches = snap.docs.filter(function (d) {
            return ((d.data() || {}).email || '').trim().toLowerCase() === trimmedEmail;
          });
          if (!matches.length) return { error: NO_USER_MSG };
          if (matches.length > 1) {
            return { error: trimmedEmail + ' has ' + matches.length + ' user records in this company, so I can\'t tell which one is their login. Remove the unused ones (Firebase console ▸ Firestore ▸ businesses ▸ ' + bizKey + ' ▸ users) and try again.' };
          }
          return { uid: matches[0].id, email: (matches[0].data() || {}).email || trimmedEmail };
        });
      }

      return resolveTarget().then(function (t) {
        return t.fallback ? fallbackTarget() : t;
      }).then(function (target) {
        if (target.error) return { ok: false, message: target.error };
        var uid = target.uid;
        var actualEmail = target.email;
        var batch = db.batch();
        batch.set(projectsRef().doc(projectId).collection('members').doc(uid), {
          uid: uid,
          email: actualEmail,
          role: role,
          addedAt: serverTimestamp()
        });
        // Denormalized onto the business-level user doc (readable by that
        // same user, unlike the projects collection itself) so a non-owner
        // can discover which projects they belong to via plain get()s
        // instead of a list query. A collection-wide .get() on
        // businesses/{biz}/projects, or a collectionGroup('members') query,
        // is denied outright for a non-owner by Firestore's rules engine —
        // it can't statically prove an exists()-based rule holds for every
        // possible result of a list/collectionGroup read, even when the
        // rule would in fact allow every document actually returned.
        // get()s on specific, known documents don't have this restriction.
        batch.update(businessUsersRef().doc(uid), {
          projectIds: firebase.firestore.FieldValue.arrayUnion(projectId)
        });
        return batch.commit().then(function () {
          return { ok: true, message: 'Member added.' };
        });
      }).catch(function (err) {
        error('addMember failed', err);
        return { ok: false, message: permMessage(err) };
      });
    },

    removeMember: function (projectId, uid) {
      if (!db || !bizKey) return Promise.resolve({ ok: false, message: 'Not ready yet — please try again.' });
      var batch = db.batch();
      batch.delete(projectsRef().doc(projectId).collection('members').doc(uid));
      batch.update(businessUsersRef().doc(uid), {
        projectIds: firebase.firestore.FieldValue.arrayRemove(projectId)
      });
      return batch.commit().then(function () {
        return { ok: true, message: 'Member removed.' };
      }).catch(function (err) {
        error('removeMember failed', err);
        return { ok: false, message: permMessage(err) };
      });
    }
  };

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function popupHtml(companyName) {
    var roleOptions = MEMBER_ROLES.map(function (r) { return '<option value="' + r.key + '">' + esc(r.label) + '</option>'; }).join('');
    return '<!doctype html><html><head><meta charset="utf-8"><title>Manage Project Access</title><style>' +
      'body{font-family:Arial,Helvetica,sans-serif;margin:20px;color:#222;}' +
      'h1{font-size:1.25rem;margin:0 0 2px;}' +
      'p.company{font-size:1rem;margin:0 0 6px;color:#004e92;}' +
      'p.sub{color:#666;font-size:0.85rem;margin:0 0 16px;}' +
      '.note{background:#fff8e1;border:1px solid #f0d98c;border-radius:6px;padding:10px 12px;font-size:0.82rem;color:#6b5900;margin:0 0 16px;}' +
      '.create-row{display:flex;gap:8px;margin:0 0 20px;}' +
      '.create-row input{flex:1;padding:8px;border:1px solid #ccc;border-radius:6px;font-size:0.9rem;}' +
      '.create-row button, .project-card button{padding:7px 12px;border-radius:6px;border:1px solid #004e92;background:#fff;color:#004e92;cursor:pointer;font-size:0.85rem;}' +
      '.create-row button:hover, .project-card button:hover{background:#f0f6ff;}' +
      '.project-card{border:1px solid #ddd;border-radius:8px;padding:14px;margin:0 0 14px;}' +
      '.project-card-header{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 10px;}' +
      '.project-card-header h2{font-size:1.05rem;margin:0;}' +
      '.project-card-header .actions{display:flex;gap:6px;}' +
      '.project-card-header button.danger{border-color:#c0392b;color:#c0392b;}' +
      '.project-card-header button.danger:hover{background:#fdf0ef;}' +
      'table{border-collapse:collapse;width:100%;font-size:0.85rem;margin:0 0 10px;}' +
      'th,td{border:1px solid #eee;padding:6px 8px;text-align:left;}' +
      'th{background:#f7f7f7;}' +
      '.add-member-row{display:flex;gap:8px;}' +
      '.add-member-row input{flex:1;padding:6px;border:1px solid #ccc;border-radius:6px;font-size:0.85rem;}' +
      '.add-member-row select{padding:6px;border:1px solid #ccc;border-radius:6px;font-size:0.85rem;}' +
      '.empty{color:#888;font-style:italic;font-size:0.85rem;}' +
      '#status{font-size:0.8rem;margin:10px 0;min-height:1.2em;}' +
      '#status.ok{color:#2f9e44;}' +
      '#status.err{color:#dd3333;font-weight:600;}' +
      '</style></head><body>' +
      '<h1>Manage Project Access</h1>' +
      '<p class="company">Company: <strong>' + esc(companyName) + '</strong></p>' +
      '<p class="sub">Create projects for this company and assign each project\'s members a role. Owner-only.</p>' +
      '<p class="note">Each project has its own separate dashboard data (Schedule, Risks, Q&amp;A, etc.) — import data into a project after selecting it at login. This screen sets up the projects and who can access each one.</p>' +
      '<div class="create-row">' +
      '<input type="text" id="newProjectName" placeholder="New project name" />' +
      '<button type="button" id="createProjectBtn">Create Project</button>' +
      '</div>' +
      '<p id="status"></p>' +
      '<div id="projectList"></div>' +
      '<script>' +
      'var ROLE_OPTIONS_HTML = ' + JSON.stringify(roleOptions) + ';' +
      'var statusEl = document.getElementById("status");' +
      'function showStatus(ok, msg) { statusEl.className = ok ? "ok" : "err"; statusEl.textContent = msg; }' +
      'function bridge() { return window.opener && window.opener.drProjectAccess; }' +
      'function esc(s) { var d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; }' +
      'function refresh() {' +
      '  if (!bridge()) { showStatus(false, "Could not reach the dashboard tab — keep this window open alongside it."); return; }' +
      '  bridge().listProjects().then(renderProjects);' +
      '}' +
      'function renderProjects(res) {' +
      '  if (!res.ok) { showStatus(false, res.message); return; }' +
      '  var container = document.getElementById("projectList");' +
      '  if (!res.projects.length) { container.innerHTML = "<p class=\\"empty\\">No projects yet — create one above.</p>"; return; }' +
      '  container.innerHTML = res.projects.map(function (p) {' +
      '    var rows = p.members.length ? p.members.map(function (m) {' +
      '      return "<tr><td>" + esc(m.email) + "</td><td>" + esc(m.role) + "</td><td><button type=\\"button\\" class=\\"danger removeMemberBtn\\" data-project=\\"" + p.id + "\\" data-uid=\\"" + m.uid + "\\">Remove</button></td></tr>";' +
      '    }).join("") : "<tr><td colspan=\\"3\\" class=\\"empty\\">No members yet.</td></tr>";' +
      '    return "<div class=\\"project-card\\">" +' +
      '      "<div class=\\"project-card-header\\"><h2>" + esc(p.name) + "</h2>" +' +
      '      "<div class=\\"actions\\">" +' +
      '      "<button type=\\"button\\" class=\\"renameProjectBtn\\" data-project=\\"" + p.id + "\\" data-name=\\"" + esc(p.name) + "\\">Rename</button>" +' +
      '      "<button type=\\"button\\" class=\\"danger deleteProjectBtn\\" data-project=\\"" + p.id + "\\" data-name=\\"" + esc(p.name) + "\\">Delete</button>" +' +
      '      "</div></div>" +' +
      '      "<table><thead><tr><th>Email</th><th>Role</th><th></th></tr></thead><tbody>" + rows + "</tbody></table>" +' +
      '      "<div class=\\"add-member-row\\">" +' +
      '      "<input type=\\"email\\" placeholder=\\"member@company.com\\" class=\\"newMemberEmail\\" data-project=\\"" + p.id + "\\" />" +' +
      '      "<select class=\\"newMemberRole\\" data-project=\\"" + p.id + "\\">" + ROLE_OPTIONS_HTML + "</select>" +' +
      '      "<button type=\\"button\\" class=\\"addMemberBtn\\" data-project=\\"" + p.id + "\\">Add Member</button>" +' +
      '      "</div></div>";' +
      '  }).join("");' +
      '}' +
      'document.getElementById("createProjectBtn").addEventListener("click", function () {' +
      '  if (!bridge()) { showStatus(false, "Could not reach the dashboard tab — keep this window open alongside it."); return; }' +
      '  var input = document.getElementById("newProjectName");' +
      '  showStatus(true, "Creating…");' +
      '  bridge().createProject(input.value).then(function (res) {' +
      '    showStatus(res.ok, res.message);' +
      '    if (res.ok) { input.value = ""; refresh(); }' +
      '  });' +
      '});' +
      'document.getElementById("projectList").addEventListener("click", function (e) {' +
      '  var btn = e.target.closest("button");' +
      '  if (!btn || !bridge()) return;' +
      '  var projectId = btn.getAttribute("data-project");' +
      '  if (btn.classList.contains("renameProjectBtn")) {' +
      '    var current = btn.getAttribute("data-name");' +
      '    var name = prompt("Rename project:", current);' +
      '    if (name == null) return;' +
      '    showStatus(true, "Renaming…");' +
      '    bridge().renameProject(projectId, name).then(function (res) { showStatus(res.ok, res.message); if (res.ok) refresh(); });' +
      '  } else if (btn.classList.contains("deleteProjectBtn")) {' +
      '    var pname = btn.getAttribute("data-name");' +
      '    if (!confirm("Delete project \\"" + pname + "\\"? This removes its member assignments. It does not delete any dashboard data.")) return;' +
      '    showStatus(true, "Deleting…");' +
      '    bridge().deleteProject(projectId).then(function (res) { showStatus(res.ok, res.message); if (res.ok) refresh(); });' +
      '  } else if (btn.classList.contains("removeMemberBtn")) {' +
      '    var uid = btn.getAttribute("data-uid");' +
      '    showStatus(true, "Removing…");' +
      '    bridge().removeMember(projectId, uid).then(function (res) { showStatus(res.ok, res.message); if (res.ok) refresh(); });' +
      '  } else if (btn.classList.contains("addMemberBtn")) {' +
      '    var card = btn.closest(".project-card");' +
      '    var emailInput = card.querySelector(".newMemberEmail");' +
      '    var roleSelect = card.querySelector(".newMemberRole");' +
      '    showStatus(true, "Adding…");' +
      '    bridge().addMember(projectId, emailInput.value, roleSelect.value).then(function (res) { showStatus(res.ok, res.message); if (res.ok) refresh(); });' +
      '  }' +
      '});' +
      'refresh();' +
      '<\/script>' +
      '</body></html>';
  }

  function openProjectAccessWindow() {
    if (!db || !bizKey) { alert('Still loading — please try again in a moment.'); return; }
    var win = window.open('', '_blank', 'width=760,height=760');
    if (!win) { alert('Please allow pop-ups to view Manage Project Access in a new window.'); return; }
    // Window is opened synchronously above (inside the click, so the
    // popup blocker allows it); the company name is fetched afterward and
    // the page written once it's known.
    win.document.open();
    win.document.write('<!doctype html><html><body style="font-family:Arial;margin:20px;">Loading…</body></html>');
    win.document.close();
    db.collection('businesses').doc(bizKey).get().then(function (snap) {
      var d = (snap.exists && snap.data()) || {};
      return d.name || d.businessName || bizKey;
    }).catch(function () { return bizKey; }).then(function (companyName) {
      if (win.closed) return;
      win.document.open();
      win.document.write(popupHtml(companyName));
      win.document.close();
    });
  }

  window.drOpenProjectAccessWindow = openProjectAccessWindow;

  function resolveBusinessKey() {
    var params = new URLSearchParams(window.location.search || '');
    return params.get('business') || (window.localStorage && window.localStorage.getItem('businessKey')) || window.BIZ_KEY || null;
  }

  function start() {
    db = window.db || null;
    if (!db) { setTimeout(start, 200); return; }
    bizKey = resolveBusinessKey();
    if (!bizKey) { setTimeout(start, 300); return; }
    log('initialized', { bizKey: bizKey });
  }

  start();
})();
