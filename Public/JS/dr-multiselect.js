// Public/JS/dr-multiselect.js
// Turns an existing <select> filter into a dropdown-with-checkboxes
// multi-select — a plain <select multiple> looks like an old-fashioned
// scrollable list box, not a typical dropdown, so this builds a small
// custom widget instead: a button (showing "All X" or "N selected")
// that opens a checkbox list on click, closes on an outside click.
//
// The underlying <select> is hidden, not removed — every card's own
// populate*Filters() function keeps repopulating its <option> list from
// live data exactly as before; a MutationObserver here just re-reads
// those options into the checkbox panel whenever they change, so no
// calling code needs to know this widget exists.
//
// Loaded early (a plain <script>) so window.drCreateMultiSelectFilter
// exists before any card module tries to call it.

(function () {
  'use strict';

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  // selectEl: the existing <select> to enhance (its first, empty-value
  // option is treated as the placeholder label, e.g. "All Categories").
  // onChange(selectedValues): called with an array of selected option
  // values (never includes the placeholder) whenever the choice changes.
  function createMultiSelectFilter(selectEl, onChange) {
    if (!selectEl || selectEl.__drMultiSelect) return selectEl && selectEl.__drMultiSelect;

    selectEl.style.display = 'none';
    var wrap = document.createElement('div');
    wrap.className = 'dr-multiselect';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dr-multiselect-btn';
    var panel = document.createElement('div');
    panel.className = 'dr-multiselect-panel';
    panel.hidden = true;
    wrap.appendChild(btn);
    wrap.appendChild(panel);
    selectEl.parentNode.insertBefore(wrap, selectEl.nextSibling);

    var selected = [];

    function placeholderLabel() {
      var first = selectEl.options[0];
      return (first && first.value === '' && first.textContent) || 'All';
    }

    function updateBtnLabel() {
      btn.textContent = (selected.length === 0 ? placeholderLabel() : selected.length + ' selected') + ' ▾';
    }

    function rebuildPanel() {
      var opts = Array.prototype.slice.call(selectEl.options).filter(function (o) { return o.value !== ''; });
      // Drop any previously-selected value that no longer exists in the
      // (possibly just-repopulated) option list, so stale selections
      // can't silently keep filtering against data that's gone.
      var validValues = {};
      opts.forEach(function (o) { validValues[o.value] = true; });
      var before = selected.length;
      selected = selected.filter(function (v) { return validValues[v]; });
      panel.innerHTML = opts.map(function (o) {
        var checked = selected.indexOf(o.value) !== -1;
        return '<label class="dr-multiselect-option"><input type="checkbox" value="' + esc(o.value) + '"' + (checked ? ' checked' : '') + ' /> ' + esc(o.textContent) + '</label>';
      }).join('');
      updateBtnLabel();
      if (selected.length !== before) onChange(selected.slice());
    }

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      panel.hidden = !panel.hidden;
    });
    panel.addEventListener('change', function (e) {
      var cb = e.target;
      if (!cb || cb.tagName !== 'INPUT') return;
      if (cb.checked) {
        if (selected.indexOf(cb.value) === -1) selected.push(cb.value);
      } else {
        selected = selected.filter(function (v) { return v !== cb.value; });
      }
      updateBtnLabel();
      onChange(selected.slice());
    });
    document.addEventListener('click', function (e) {
      if (!wrap.contains(e.target)) panel.hidden = true;
    });

    var mo = new MutationObserver(rebuildPanel);
    mo.observe(selectEl, { childList: true });
    rebuildPanel();

    var api = {
      clear: function () {
        if (!selected.length) return;
        selected = [];
        rebuildPanel();
        updateBtnLabel();
      },
      getSelected: function () { return selected.slice(); }
    };
    selectEl.__drMultiSelect = api;
    return api;
  }

  window.drCreateMultiSelectFilter = createMultiSelectFilter;
})();
