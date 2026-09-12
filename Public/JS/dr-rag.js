/* Public/JS/dr-rag.js
   Shared RAG (red/amber/green) jeopardy calculation, used by Q&A, Activity
   Log, and Milestones so "is this in trouble" means the same thing
   everywhere in the portal.

   % of duration remaining = (dueDate - today) / (dueDate - startDate)
     0–25% remaining  -> Red    (mostly elapsed, close to due)
     26–50% remaining -> Amber
     51–100% remaining -> Green
   Overdue (past due date) is always Red. Completed is its own "done" state,
   distinct from the color scale. No due date is "none" — nothing to judge.
*/
(function () {
  function toJsDate(v) {
    if (!v) return null;
    if (v.toDate) return v.toDate();
    // An already-invalid Date (e.g. new Date('garbage')) is still truthy
    // and still `instanceof Date` — validate it here too, or it silently
    // propagates as a NaN date to every jeopardy calculation downstream.
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
    var d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }

  function dateOnly(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  // startDate: when the clock started (creation date, or an explicit
  // startDate field if the item has one). dueDate: the deadline.
  // completed: true if the item is already done/closed.
  function compute(startDate, dueDate, completed) {
    if (completed) return { code: 'done', label: 'Done' };

    var due = toJsDate(dueDate);
    if (!due) return { code: 'none', label: 'No due date' };
    due = dateOnly(due);

    var today = dateOnly(new Date());
    if (due < today) return { code: 'red', label: 'Overdue' };

    var start = toJsDate(startDate);
    if (!start) return { code: 'amber', label: 'Due soon' }; // no start to measure duration from
    start = dateOnly(start);

    var totalDuration = due - start;
    var remaining = due - today;

    if (totalDuration <= 0) return { code: 'red', label: 'At risk' };

    var pctRemaining = (remaining / totalDuration) * 100;
    if (pctRemaining <= 25) return { code: 'red', label: 'At risk' };
    if (pctRemaining <= 50) return { code: 'amber', label: 'Due soon' };
    return { code: 'green', label: 'On track' };
  }

  window.drRag = { compute: compute, toJsDate: toJsDate, dateOnly: dateOnly };
})();
