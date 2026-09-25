// /Public/JS/projectProgress.js
// Two automatically-computed progress bars — Time Elapsed and Tasks
// Completed — linked to businesses/{biz}.autoTimeElapsedProgress and
// .autoTaskProgress (see burndown.js's writeAutoProjectProgress, which
// computes both from the real schedule/task data every render). No more
// manual click-to-set: both numbers are objective facts derivable from
// the imported schedule, not something an Owner should have to eyeball.

(function () {
  var LOG = "[projectProgress]";

  function clamp(num, min, max) {
    return Math.min(max, Math.max(min, num));
  }

  function waitForFirebase(cb) {
    if (window.firebase && window.auth && window.db) {
      cb({ firebase: firebase, auth: auth, db: db });
      return;
    }
    setTimeout(function () { waitForFirebase(cb); }, 150);
  }

  function waitForBusinessKey(cb) {
    if (window.BIZ_KEY) {
      cb(window.BIZ_KEY);
      return;
    }
    if (typeof window.waitForBusinessKey === "function") {
      window.waitForBusinessKey(function (bizKey) {
        window.BIZ_KEY = bizKey;
        cb(bizKey);
      });
      return;
    }
    setTimeout(function () { waitForBusinessKey(cb); }, 150);
  }

  function renderBar(percent, fillEl, labelEl) {
    var p = clamp(Math.round(percent || 0), 0, 100);
    if (fillEl) fillEl.style.width = p + "%";
    if (labelEl) labelEl.textContent = p + "%";
    return p;
  }

  function init() {
    console.log(LOG, "init called");

    waitForFirebase(function (DR) {
      waitForBusinessKey(function (bizKey) {
        var card = document.getElementById("projectProgressCard");
        var timeContainer = document.getElementById("time-elapsed-bar-container");
        var timeFill = document.getElementById("time-elapsed-bar-fill");
        var timeLabel = document.getElementById("time-elapsed-label");
        var taskContainer = document.getElementById("task-progress-bar-container");
        var taskFill = document.getElementById("task-progress-bar-fill");
        var taskLabel = document.getElementById("task-progress-label");

        if (!card || !timeContainer || !timeFill || !timeLabel || !taskContainer || !taskFill || !taskLabel) {
          console.warn(LOG, "Required DOM not found");
          return;
        }

        // Progress bars are per PROJECT (the company document is shared by every project).
        var docRef = DR.db.collection("businesses").doc(bizKey).collection("projects").doc(window.PROJECT_KEY || "default");

        docRef.onSnapshot(function (snap) {
          var data = (snap.exists && snap.data()) || {};
          var timePct = renderBar(data.autoTimeElapsedProgress, timeFill, timeLabel);
          var taskPct = renderBar(data.autoTaskProgress, taskFill, taskLabel);
          card.setAttribute("data-time-progress", String(timePct));
          card.setAttribute("data-task-progress", String(taskPct));

          if (window.drInsight) {
            var text;
            if (data.autoTaskProgress == null && data.autoTimeElapsedProgress == null) {
              text = '';
            } else {
              text = timePct + '% of the project timeline has elapsed, with ' + taskPct + '% of tasks fully completed' +
                (taskPct < timePct ? ' — behind the calendar pace.' : taskPct > timePct ? ' — ahead of the calendar pace.' : '.');
              // Check-and-balance: "fully completed" (above) treats a task
              // at 99% the same as one at 0%, which won't match MS
              // Project's own work-weighted Percent_Complete on the
              // imported summary row. Showing both, plus the import's own
              // figure when available, makes that gap visible instead of
              // reading as "the numbers are wrong."
              if (typeof data.autoTaskProgressWeighted === 'number') {
                text += ' Counting partial progress on in-progress tasks, work is ' + Math.round(data.autoTaskProgressWeighted) + '% complete.';
              }
              if (typeof data.projectPercentComplete === 'number') {
                text += ' The imported schedule\'s own calculation reports ' + Math.round(data.projectPercentComplete) + '%.';
              }
            }
            window.drInsight.set('projectProgressCard', text);
          }
        }, function (err) {
          console.error(LOG, "Snapshot failed:", err);
        });
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
