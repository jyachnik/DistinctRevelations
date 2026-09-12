/* Public/JS/dr-date-format.js
   Shared date/time formatting for the dashboard: MM/DD/YY (US format) for
   dates, hh:mm AM/PM for times — used everywhere a Firestore Timestamp,
   Date, or date-like value needs to be displayed.
*/
(function () {
  function toJsDate(v) {
    if (!v) return null;
    if (v.toDate) return v.toDate();
    // An already-invalid Date (e.g. new Date('garbage')) is still truthy
    // and still `instanceof Date` — validate it here too, or every
    // formatter below silently prints "NaN/NaN/NaN"-style garbage instead
    // of treating it as "no date".
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
    var d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }

  function pad2(n) { return String(n).padStart(2, '0'); }

  // MM/DD/YY
  function formatDate(v) {
    var d = toJsDate(v);
    if (!d) return '';
    var mm = pad2(d.getMonth() + 1);
    var dd = pad2(d.getDate());
    var yy = pad2(d.getFullYear() % 100);
    return mm + '/' + dd + '/' + yy;
  }

  // hh:mm AM/PM
  function formatTime(v) {
    var d = toJsDate(v);
    if (!d) return '';
    var h = d.getHours();
    var m = pad2(d.getMinutes());
    var ampm = h >= 12 ? 'PM' : 'AM';
    var h12 = h % 12;
    if (h12 === 0) h12 = 12;
    return h12 + ':' + m + ' ' + ampm;
  }

  // MM/DD/YY hh:mm AM/PM
  function formatDateTime(v) {
    var d = toJsDate(v);
    if (!d) return '';
    return formatDate(d) + ' ' + formatTime(d);
  }

  // Long form, e.g. "September 4, 2026" — for the header's current-date display.
  var MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  function formatLongDate(v) {
    var d = toJsDate(v);
    if (!d) return '';
    return MONTH_NAMES[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
  }

  window.drDateFmt = {
    toJsDate: toJsDate,
    date: formatDate,
    time: formatTime,
    dateTime: formatDateTime,
    longDate: formatLongDate
  };
})();
