/* Free time in a day: one function for the planner page (Command Center ring) and the voice connector.
   Loaded as a plain script in the browser and imported by the planner-mcp edge function; it sets
   globalThis.PPFree. Times are minutes after midnight.
   - Today, free time starts at NOW (rounded up to the next 5 minutes): time that has passed is never free.
   - Another day starts at waking (if known and before noon) or at dayStart (07:00).
   - Busy intervals (work hours, timed items, workouts) are cut out; gaps shorter than minGap are not counted. */
(function (root) {
  function compute(o) {
    var dayStart = o.dayStart != null ? o.dayStart : 420, dayEnd = o.dayEnd != null ? o.dayEnd : 1380, minGap = o.minGap != null ? o.minGap : 15;
    var start = o.wake != null && o.wake < 720 ? o.wake : dayStart;
    if (o.isToday !== false && o.nowMin != null) start = Math.max(start, Math.ceil(o.nowMin / 5) * 5);
    var iv = (o.busy || []).map(function (x) { return [Math.max(start, x[0]), Math.min(dayEnd, x[1])]; })
      .filter(function (x) { return x[1] > x[0]; }).sort(function (a, b) { return a[0] - b[0]; });
    var gaps = [], cur = start;
    iv.forEach(function (x) { if (x[0] - cur >= minGap) gaps.push([cur, x[0]]); cur = Math.max(cur, x[1]); });
    if (dayEnd - cur >= minGap) gaps.push([cur, dayEnd]);
    return { from: start, to: dayEnd, gaps: gaps, minutes: gaps.reduce(function (a, g) { return a + g[1] - g[0]; }, 0), fromNow: o.isToday !== false && o.nowMin != null && start > (o.wake != null && o.wake < 720 ? o.wake : dayStart) };
  }
  root.PPFree = { compute: compute };
})(typeof globalThis !== "undefined" ? globalThis : this);
