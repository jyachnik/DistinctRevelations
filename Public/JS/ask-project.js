/* ============================================================================
   Ask the Project — a chat window where you type a question and an AI answers
   from the project's imported documents and live card data, citing where each
   fact came from (the Evidence panel; click a source to open the original
   document beside the chat, the section highlighted). The answering happens in
   the askProject Cloud Function (functions/ask-handler.js), which applies this
   person's role: it only ever sees documents whose visibility includes the role,
   and data for cards the role can view. This file is the window.

   A conversation stays open until the person ends it: closing the window (or
   jumping to a card) only hides it, and it is resumed next time — even after a
   page reload — because every conversation is saved as it goes
   (businesses/{biz}/projects/{proj}/askChats/{id}, see firestore.rules). The
   sidebar lists them: each person sees their own; the owner sees every role's,
   grouped by role, read-only. "End chat" closes one for good (it stays saved).
   ============================================================================ */

(function () {
  'use strict';

  var ns = '[ask-project]';
  var REPORT_ID = 'askProjectAction';
  var EXAMPLES = [
    'What are the biggest risks right now, and who owns them?',
    'Which tasks are late or slipping?',
    'What did we decide about the release gates?',
    'What are the payment milestones and their dates?'
  ];
  var ROLE_LABELS = { owner: 'Owner', clientPartner: 'Client Partner', projectManager: 'Project Manager', admin: 'Admin', member: 'Member' };
  var ROLE_ORDER = ['owner', 'clientPartner', 'projectManager', 'admin', 'member'];
  var MAX_CHAT_BYTES = 700000;      // one Firestore document must stay under 1 MiB
  var S = { chat: null, list: [], filter: 'all', busy: false, loaded: false, endArmed: null, delArmed: null, style: null };

  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
  function canUse() {
    return !!(window.drAccess && (window.drAccess.role === 'owner' || window.drAccess.canViewReport(REPORT_ID)));
  }
  function isOwner() { return !!(window.drAccess && window.drAccess.role === 'owner'); }
  function me() { var u = window.firebase && window.firebase.auth && window.firebase.auth().currentUser; return u ? { uid: u.uid, email: u.email || '' } : null; }
  function db() { return window.db || window.firebase.firestore(); }
  function chatsCol() { return db().collection('businesses').doc(window.BIZ_KEY).collection('projects').doc(window.PROJECT_KEY || 'default').collection('askChats'); }
  function roleLabel(r) { return ROLE_LABELS[r] || r || 'Member'; }
  function toDate(v) { return v && v.toDate ? v.toDate() : (v instanceof Date ? v : null); }
  function fmtDate(v) {
    var d = toDate(v); if (!d) return '';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }

  // Plain text -> safe HTML: paragraphs, **bold**, "- " bullets, and [n] citation markers.
  function render(answer) {
    var html = esc(answer)
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\[(\d{1,3})\]/g, '<button type="button" class="ask-cite" data-n="$1" title="Show the source">[$1]</button>');
    var lines = html.split('\n'), out = [], inList = false;
    lines.forEach(function (ln) {
      var m = /^\s*[-•]\s+(.*)$/.exec(ln);
      if (m) { if (!inList) { out.push('<ul>'); inList = true; } out.push('<li>' + m[1] + '</li>'); return; }
      if (inList) { out.push('</ul>'); inList = false; }
      if (ln.trim()) out.push('<p>' + ln + '</p>');
    });
    if (inList) out.push('</ul>');
    return out.join('');
  }

  // Every source the answer used, side by side: the excerpt, and a way to see it in place.
  function evidenceHtml(sources) {
    if (!sources || !sources.length) return '';
    return '<div class="ask-evidence"><div class="ask-ev-h">Evidence (' + sources.length + ')</div><div class="ask-ev-grid">' +
      sources.map(function (s) {
        var isDoc = s.kind === 'document' && s.docId;
        return '<div class="ask-ev" data-ev="' + esc(s.n) + '">' +
          '<div class="ask-ev-top"><span class="ask-ev-n">[' + esc(s.n) + ']</span> <strong>' + esc(s.label) + '</strong></div>' +
          (s.phase ? '<div class="ask-ev-phase">' + esc(s.phase) + '</div>' : '') +
          (s.excerpt ? '<div class="ask-ev-x">' + esc(s.excerpt) + '</div>' : '') +
          (isDoc ? '<button type="button" class="ask-ev-open" data-n="' + esc(s.n) + '">Open in document</button>' :
            (s.card ? '<button type="button" class="ask-ev-open" data-n="' + esc(s.n) + '">Show in dashboard</button>' : '')) +
          '</div>';
      }).join('') + '</div></div>';
  }

  // Jump to a card the way the Reports list does (below the fixed header and status row), and hide
  // the Ask window WITHOUT ending the conversation — the "Return to conversation" pill brings it back.
  function goToCard(cardId) {
    var card = document.getElementById(cardId);
    if (!card) return;
    if (window.drDocViewer) window.drDocViewer.close();
    if (window.drModal) window.drModal.close();
    if (window.drScrollToId) window.drScrollToId(cardId);
    else card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function openSource(s, docSources, msgEl) {
    if (s.kind === 'document' && s.docId) {
      if (window.drDocViewer) window.drDocViewer.open(s, docSources);
      return;
    }
    if (s.card) { goToCard(s.card); return; }
    var ev = msgEl && msgEl.querySelector('[data-ev="' + s.n + '"]');
    if (ev) ev.scrollIntoView({ block: 'nearest' });
  }

  function errorText(err) {
    var code = err && err.code ? String(err.code).replace('functions/', '') : '';
    if (code === 'permission-denied') return (err.message || 'You do not have access to Ask the Project.');
    if (code === 'resource-exhausted') return (err.message || 'Daily question limit reached.');
    if (code === 'unauthenticated') return 'Please sign in again.';
    if (code === 'failed-precondition') return (err.message || 'The AI assistant is not set up yet.');
    if (code === 'invalid-argument') return (err.message || 'Please check your question.');
    if (code === 'unavailable' || code === 'internal' || code === 'deadline-exceeded') return 'The assistant could not answer right now. Please try again in a moment.';
    return (err && err.message) || 'Something went wrong. Please try again.';
  }

  // Executive (short, C-level) or Detailed wording. A role with only one gets it; a role with both
  // chooses here, starting from the Summary/Detail checkboxes on the Executive Overview card.
  function canChooseStyle() { return !!(window.drAiVersion && window.drAiVersion.canChoose()); }
  function currentStyle() {
    var V = window.drAiVersion;
    if (!V) return 'detail';
    if (!V.canChoose()) return V.wording();
    return S.style || V.wording();
  }

  // ------------------------------------------------------------------ conversations
  function blankChat() {
    var u = me() || { uid: '', email: '' };
    return { id: null, uid: u.uid, email: u.email, role: isOwner() ? 'owner' : (window.drAccess && window.drAccess.role) || 'member', title: '', status: 'open', messages: [], createdAt: null, updatedAt: null };
  }
  function fromDoc(d) {
    var x = d.data({ serverTimestamps: 'estimate' });
    return { id: d.id, uid: x.uid, email: x.email, role: x.role, title: x.title || '', status: x.status || 'open', messages: x.messages || [], createdAt: x.createdAt, updatedAt: x.updatedAt, endedAt: x.endedAt };
  }
  function isMine(c) { var u = me(); return !!(u && c.uid === u.uid); }
  function canContinue(c) { return isMine(c) && c.status === 'open'; }
  function historyFor(c) {
    return c.messages.slice(-6).map(function (m) { return { role: m.r === 'user' ? 'user' : 'assistant', content: m.t }; });
  }
  function storable(messages) {   // Firestore refuses undefined; keep the excerpts reasonably small
    return JSON.parse(JSON.stringify(messages.map(function (m) {
      var o = { r: m.r, t: m.t };
      if (m.sources) o.sources = m.sources.map(function (s) { var c = Object.assign({}, s); if (c.excerpt) c.excerpt = c.excerpt.slice(0, 500); return c; });
      if (m.stats) o.stats = { documents: m.stats.documents || 0, dataSets: m.stats.dataSets || 0 };
      if (m.style) o.style = m.style;
      return o;
    })));
  }
  function sizeOf(c) { try { return JSON.stringify(storable(c.messages)).length; } catch (e) { return 0; } }

  function save(c) {
    var FV = window.firebase.firestore.FieldValue;
    var msgs = storable(c.messages);
    if (!c.id) {
      var ref = chatsCol().doc();
      c.id = ref.id;                       // fixed before the write so a second answer can't create a duplicate
      return ref.set({ uid: c.uid, email: c.email, role: c.role, title: c.title, status: 'open', messages: msgs, createdAt: FV.serverTimestamp(), updatedAt: FV.serverTimestamp() });
    }
    return chatsCol().doc(c.id).update({ messages: msgs, updatedAt: FV.serverTimestamp() });
  }

  function loadList() {
    var u = me(); if (!u) return Promise.resolve();
    // members must ask for their own only (the rules refuse an unfiltered list); the owner reads all
    var q = isOwner() ? chatsCol().limit(300) : chatsCol().where('uid', '==', u.uid).limit(100);
    return q.get().then(function (snap) {
      S.list = snap.docs.map(fromDoc).sort(function (a, b) {
        var da = toDate(b.updatedAt), db_ = toDate(a.updatedAt);
        return (da ? da.getTime() : 0) - (db_ ? db_.getTime() : 0);
      });
      S.loaded = true;
    }).catch(function (err) { console.warn(ns, 'could not list conversations', err); S.list = S.list || []; });
  }

  // ------------------------------------------------------------------ window
  var pill = null;
  function shell() { return document.getElementById('askShell'); }
  function isOpen() { var o = document.getElementById('drGenericModalOverlay'); return !!(o && o.classList.contains('is-open') && shell()); }
  function updatePill() {
    var show = !isOpen() && S.chat && isMine(S.chat) && S.chat.status === 'open' && S.chat.messages.length > 0;
    if (!show) { if (pill) pill.style.display = 'none'; return; }
    if (!pill) {
      pill = document.createElement('button');
      pill.type = 'button'; pill.id = 'askResumePill'; pill.className = 'ask-pill';
      pill.textContent = '🔎 Return to your conversation';
      pill.addEventListener('click', function () { open(); });
      document.body.appendChild(pill);
    }
    pill.style.display = '';
  }

  function sidebarHtml() {
    var owner = isOwner();
    var list = S.list.slice();
    // make sure a just-started conversation appears even before the list reloads
    if (S.chat && S.chat.id && !list.some(function (x) { return x.id === S.chat.id; })) list.unshift(S.chat);
    var roles = [];
    list.forEach(function (c) { if (roles.indexOf(c.role) === -1) roles.push(c.role); });
    roles.sort(function (a, b) { return ROLE_ORDER.indexOf(a) - ROLE_ORDER.indexOf(b); });
    if (owner && S.filter !== 'all' && roles.indexOf(S.filter) === -1) S.filter = 'all';
    if (owner && S.filter !== 'all') list = list.filter(function (c) { return c.role === S.filter; });

    function item(c) {
      var on = S.chat && S.chat.id && S.chat.id === c.id;
      var sub = [];
      if (owner) sub.push(esc(isMine(c) ? 'You' : (c.email || 'Unknown')));
      sub.push(esc(fmtDate(c.updatedAt)));
      return '<li><button type="button" class="ask-chat-item' + (on ? ' is-on' : '') + '" data-id="' + esc(c.id) + '">' +
        '<span class="ask-chat-t">' + esc(c.title || 'Conversation') + '</span>' +
        '<span class="ask-chat-s">' + sub.join(' · ') + (c.status === 'ended' ? ' <span class="ask-chat-end">ended</span>' : '') + '</span></button></li>';
    }
    var body = '';
    if (!list.length) body = '<li class="ask-side-empty">No saved conversations yet.</li>';
    else if (owner && S.filter === 'all') {
      roles.forEach(function (r) {
        var group = list.filter(function (c) { return c.role === r; });
        if (!group.length) return;
        body += '<li class="ask-side-group">' + esc(roleLabel(r)) + ' (' + group.length + ')</li>' + group.map(item).join('');
      });
    } else body = list.map(item).join('');

    return '<button type="button" class="primary ask-new" id="askNew">+ New chat</button>' +
      (owner ? '<label class="ask-filter">Show conversations by<select id="askFilter"><option value="all">All roles</option>' +
        roles.map(function (r) { return '<option value="' + esc(r) + '"' + (S.filter === r ? ' selected' : '') + '>' + esc(roleLabel(r)) + '</option>'; }).join('') + '</select></label>' : '') +
      '<div class="ask-side-h">' + (owner ? 'Saved conversations' : 'Your conversations') + '</div>' +
      '<ul class="ask-chats">' + body + '</ul>';
  }

  function shellHtml() {
    return '<div class="ask-shell" id="askShell">' +
      '<aside class="ask-side" id="askSide"></aside>' +
      '<div class="ask-main">' +
        '<div class="ask-top"><button type="button" class="ask-link ask-side-toggle" id="askSideToggle">☰ Conversations</button><span class="ask-top-t" id="askTopTitle"></span></div>' +
        '<div id="askBanner" class="ask-banner" style="display:none"></div>' +
        '<div class="ask-wrap">' +
          '<p class="ask-intro" id="askIntro">Ask anything about this project. Answers come from the project documents and live data <strong>your role can see</strong>, and show where each fact came from. The conversation stays open until you end it.</p>' +
          '<div id="askLog" class="ask-log" aria-live="polite"></div>' +
          '<div id="askChips" class="ask-chips">' + EXAMPLES.map(function (q) { return '<button type="button" class="ask-chip">' + esc(q) + '</button>'; }).join('') + '</div>' +
          '<div class="ask-style" id="askStyleRow" style="display:none"><span>Answer style:</span>' +
            '<label><input type="radio" name="askStyle" value="executive" /> Executive</label>' +
            '<label><input type="radio" name="askStyle" value="detail" /> Detailed</label></div>' +
          '<div class="ask-form" id="askForm">' +
            '<textarea id="askInput" rows="2" maxlength="1000" placeholder="Type your question…"></textarea>' +
            '<button type="button" id="askSend" class="primary">Ask</button>' +
          '</div>' +
          '<div class="ask-foot" id="askFoot"></div>' +
        '</div>' +
      '</div></div>';
  }

  function $(id) { return document.getElementById(id); }

  function renderSide() {
    var side = $('askSide'); if (!side) return;
    side.innerHTML = sidebarHtml();
    $('askNew').addEventListener('click', function () { selectChat(blankChat()); });
    var f = $('askFilter');
    if (f) f.addEventListener('change', function () { S.filter = f.value; renderSide(); });
    side.querySelectorAll('.ask-chat-item').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-id');
        if (S.chat && S.chat.id === id) { $('askShell').classList.remove('show-side'); return; }
        var c = S.list.filter(function (x) { return x.id === id; })[0];
        if (c) selectChat(c);
      });
    });
  }

  function botMsgEl(m) {
    var el = document.createElement('div');
    el.className = 'ask-msg ask-bot';
    var sources = m.sources || [], docSources = sources.filter(function (s) { return s.kind === 'document' && s.docId; });
    var st = m.stats || {};
    el.innerHTML = render(m.t || '') + evidenceHtml(sources) +
      '<div class="ask-meta">' + (m.style === 'executive' ? 'Executive wording · ' : '') + 'Searched ' + esc(st.documents || 0) + ' document' + (st.documents === 1 ? '' : 's') + ' and ' + esc(st.dataSets || 0) + ' live data set' + (st.dataSets === 1 ? '' : 's') + ' available to the asker’s role.</div>';
    // a [n] marker, or an evidence card's button, opens that source
    el.querySelectorAll('[data-n]').forEach(function (b) {
      b.addEventListener('click', function () {
        var s = sources.filter(function (x) { return String(x.n) === b.getAttribute('data-n'); })[0];
        if (s) openSource(s, docSources, el);
      });
    });
    return el;
  }

  function renderLog() {
    var log = $('askLog'); if (!log) return;
    log.innerHTML = '';
    S.chat.messages.forEach(function (m) {
      if (m.r === 'user') { var u = document.createElement('div'); u.className = 'ask-msg ask-user'; u.innerHTML = '<p>' + esc(m.t) + '</p>'; log.appendChild(u); }
      else log.appendChild(botMsgEl(m));
    });
    log.scrollTop = log.scrollHeight;
  }

  function renderMain() {
    if (!shell()) return;
    var c = S.chat, mine = isMine(c), live = canContinue(c) || (!c.id && mine);
    $('askTopTitle').textContent = c.title || 'New conversation';
    var banner = $('askBanner');
    if (!live) {
      var who = mine ? 'You' : (c.email || 'Unknown') + ' (' + roleLabel(c.role) + ')';
      banner.innerHTML = (mine ? 'This conversation was ended' + (c.endedAt ? ' on ' + esc(fmtDate(c.endedAt)) : '') + ' and is saved here.' : 'Read-only — asked by <strong>' + esc(who) + '</strong>, ' + esc(fmtDate(c.createdAt)) + '.') +
        (isOwner() ? ' <button type="button" class="ask-link" id="askDelete">' + (S.delArmed === c.id ? 'Click again to delete' : 'Delete this conversation') + '</button>' : '') +
        (mine ? ' <button type="button" class="ask-link" id="askStartNew">Start a new chat</button>' : '');
      banner.style.display = '';
      var del = $('askDelete');
      if (del) del.addEventListener('click', function () {
        if (S.delArmed !== c.id) { S.delArmed = c.id; renderMain(); setTimeout(function () { if (S.delArmed === c.id) { S.delArmed = null; renderMain(); } }, 4000); return; }
        S.delArmed = null;
        chatsCol().doc(c.id).delete().then(function () {
          S.list = S.list.filter(function (x) { return x.id !== c.id; });
          selectChat(blankChat());
        }).catch(function (err) { console.error(ns, 'delete failed', err); banner.textContent = 'Could not delete: ' + ((err && err.message) || err); });
      });
      var sn = $('askStartNew'); if (sn) sn.addEventListener('click', function () { selectChat(blankChat()); });
    } else banner.style.display = 'none';

    $('askForm').style.display = live ? '' : 'none';
    var sr = $('askStyleRow');
    if (sr) {
      sr.style.display = (live && canChooseStyle()) ? '' : 'none';
      var cur = currentStyle();
      sr.querySelectorAll('input[name=askStyle]').forEach(function (r) { r.checked = r.value === cur; });
    }
    $('askSend').disabled = S.busy;
    $('askChips').style.display = (live && !c.messages.length) ? '' : 'none';
    $('askIntro').style.display = c.messages.length ? 'none' : '';
    var foot = $('askFoot');
    foot.innerHTML = (live && c.messages.length) ? '<span class="ask-foot-note">Closing this window keeps the conversation open.</span> <button type="button" id="askEnd" class="ask-end">' + (S.endArmed === c.id ? 'Click again to end chat' : 'End chat') + '</button>' : '';
    var end = $('askEnd');
    if (end) end.addEventListener('click', function () {
      if (S.endArmed !== c.id) { S.endArmed = c.id; renderMain(); setTimeout(function () { if (S.endArmed === c.id) { S.endArmed = null; renderMain(); } }, 4000); return; }
      S.endArmed = null; endChat(c);
    });
    renderLog();
  }

  function selectChat(c) {
    S.chat = c; S.endArmed = null; S.delArmed = null;
    var sh = shell(); if (sh) sh.classList.remove('show-side');
    renderSide(); renderMain();
    var input = $('askInput'); if (input && canContinue(c) || (input && !c.id && isMine(c))) input.focus();
    updatePill();
  }

  function endChat(c) {
    if (!c.id) { selectChat(blankChat()); return; }
    var FV = window.firebase.firestore.FieldValue;
    chatsCol().doc(c.id).update({ status: 'ended', endedAt: FV.serverTimestamp(), updatedAt: FV.serverTimestamp() }).then(function () {
      c.status = 'ended'; c.endedAt = new Date();
      return loadList();
    }).then(function () { selectChat(blankChat()); }).catch(function (err) {
      console.error(ns, 'end failed', err);
      var b = $('askBanner'); if (b) { b.style.display = ''; b.textContent = 'Could not end the chat: ' + ((err && err.message) || err); }
    });
  }

  function ask(question) {
    var c = S.chat;
    question = String(question || '').trim();
    if (!question || S.busy || !c || !canContinue(c) && c.id) return;
    var log = $('askLog'), send = $('askSend'), input = $('askInput');
    function addNote(cls, html) { if (!log || S.chat !== c) return null; var el = document.createElement('div'); el.className = 'ask-msg ' + cls; el.innerHTML = html; log.appendChild(el); log.scrollTop = log.scrollHeight; return el; }
    if (question.length < 3) { addNote('ask-err', 'Please type a question.'); return; }
    if (sizeOf(c) > MAX_CHAT_BYTES) { addNote('ask-err', 'This conversation has got very long. Please end it and start a new chat.'); return; }
    var call = window.functions && window.functions.httpsCallable ? window.functions.httpsCallable('askProject', { timeout: 120000 }) : null;
    if (!call) { addNote('ask-err', 'The assistant is not available right now.'); return; }

    S.busy = true; if (send) send.disabled = true; if (input) input.value = '';
    var history = historyFor(c);
    c.messages.push({ r: 'user', t: question });
    if (!c.title) c.title = question.length > 60 ? question.slice(0, 57) + '…' : question;
    renderMain();
    var thinking = addNote('ask-bot ask-thinking', '<p>Searching the project…</p>');

    call({ bizKey: window.BIZ_KEY, projKey: window.PROJECT_KEY || 'default', question: question, history: history, style: currentStyle() })
      .then(function (res) {
        var d = (res && res.data) || {};
        c.messages.push({ r: 'bot', t: d.answer || '', sources: d.sources || [], stats: d.stats || {}, style: d.style || '' });
        c.updatedAt = new Date();
        return save(c).catch(function (err) {
          console.error(ns, 'could not save the conversation', err);
          if (S.chat === c) addNote('ask-err', 'This answer could not be saved to your conversation list, but it is shown here.');
        });
      })
      .catch(function (err) {
        console.error(ns, 'ask failed', err);
        c.messages.pop();                       // the question was not answered: take it back so it can be re-asked
        if (thinking && thinking.parentNode) { thinking.className = 'ask-msg ask-err'; thinking.innerHTML = esc(errorText(err)); }
        if (S.chat === c && input) input.value = question;
        c.title = c.messages.length ? c.title : '';
      })
      .then(function () {
        S.busy = false;
        var hadError = thinking && thinking.className.indexOf('ask-err') !== -1;
        if (S.chat === c && shell() && !hadError) renderMain();
        var s2 = $('askSend'); if (s2) s2.disabled = false;
        var i2 = $('askInput'); if (i2 && S.chat === c) i2.focus();
        return c.id ? loadList().then(function () { if (shell()) renderSide(); }) : null;
      })
      .then(updatePill);
  }

  function open() {
    if (!window.drModal || !canUse() || !me()) return;
    window.drModal.open({
      title: '🔎 Ask the Project',
      boxClass: 'ask-modal-box',
      noBackdropClose: true,
      onClose: function () { if (window.drDocViewer) window.drDocViewer.close(); setTimeout(updatePill, 0); },
      bodyHtml: shellHtml()
    });
    if (!S.chat) S.chat = blankChat();
    renderSide(); renderMain();

    var input = $('askInput'), send = $('askSend'), chips = $('askChips');
    send.addEventListener('click', function () { ask(input.value); });
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(input.value); } });
    chips.querySelectorAll('.ask-chip').forEach(function (b) { b.addEventListener('click', function () { ask(b.textContent); }); });
    $('askStyleRow').querySelectorAll('input[name=askStyle]').forEach(function (r) { r.addEventListener('change', function () { if (r.checked) S.style = r.value; }); });
    $('askSideToggle').addEventListener('click', function () { $('askShell').classList.toggle('show-side'); });
    send.disabled = S.busy;
    updatePill();

    // the saved list; on the first open of this page, pick up the conversation that was left open
    loadList().then(function () {
      if (!shell()) return;
      var resumed = false;
      if (!S.chat.id && !S.chat.messages.length) {
        var mine = S.list.filter(function (c) { return isMine(c) && c.status === 'open' && c.messages.length; })[0];
        if (mine) { S.chat = mine; resumed = true; }
      }
      renderSide();
      if (resumed) renderMain();
      var inp = $('askInput'); if (inp && canContinue(S.chat) || (inp && !S.chat.id)) inp.focus();
    });
  }

  // ------------------------------------------------------------------ the sidebar card
  // Sits above Reports in the floating sidebar; clicking it opens the conversation window.
  function initCard() {
    var card = document.getElementById('askSideCard');
    if (!card || card.getAttribute('data-wired')) return;
    card.setAttribute('data-wired', '1');
    var note = document.getElementById('askSideNote');
    document.getElementById('askSideBtn').addEventListener('click', function () { open(); });
    function refresh() {
      card.style.display = canUse() ? '' : 'none';
      var live = S.chat && isMine(S.chat) && S.chat.status === 'open' && S.chat.messages.length > 0;
      note.textContent = live ? 'Conversation open' : '';
    }
    refresh();
    window.addEventListener('dr-access:ready', refresh);
    setInterval(refresh, 1500);   // the note follows the conversation
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initCard); else initCard();

  window.drOpenAskProject = open;
  window.drAskProjectInternals = { render: render, evidenceHtml: evidenceHtml, storable: storable };
})();
