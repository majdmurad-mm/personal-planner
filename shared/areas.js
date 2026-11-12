/* The planner's area colours: the single source of truth.
   shared/areas.css is generated from this table (node shared/build-areas.js); edit the colours here.
     yellow  tasks & money      (Finance, Maintenance)
     orange  work               (Career)
     green   health only        (Health)
     purple  knowledge & growth (Growth, incl. concerts and culture)
     blue    people & communication (Relationships)
     white   Sol                (with a grey ink/outline in light mode so it stays visible)
   Pages use the CSS variables --area-<key>, --area-<key>-soft, --area-<key>-text (and --area-sol-line /
   --area-sol-ink). Canvas and WebGL code that needs real values uses PPAreas.color(). */
(function (root) {
  var A = {
    KEYS: ["task", "work", "health", "growth", "people", "sol", "none"],
    NAME: { task: "Tasks & money", work: "Work", health: "Health", growth: "Growth & knowledge", people: "People", sol: "Sol", none: "No area" },
    // planner area (as stored) → colour key; the friendlier page names are accepted too
    KEY: { Finance: "task", Maintenance: "task", Career: "work", Health: "health", Growth: "growth", Relationships: "people", Sol: "sol",
      Money: "task", Home: "task", Admin: "task", Work: "work", Learning: "growth", Self: "growth", People: "people", Life: "sol" },
    light: {
      task:   { c: "#A18C0B", soft: "#EDE8CF", text: "#716208" },
      work:   { c: "#BB4100", soft: "#F1DCCD", text: "#A83A00" },
      health: { c: "#00793D", soft: "#D3E5D7", text: "#00733A" },
      growth: { c: "#6331A0", soft: "#E3D9E7", text: "#6331A0" },
      people: { c: "#007AC5", soft: "#D3E5EC", text: "#0068A7" },
      sol:    { c: "#FFFFFF", soft: "#FFFFFF", text: "#3F3A33", line: "#9A9286", ink: "#6B6B6B" },
      none:   { c: "#8A8378", soft: "#EBE8E3", text: "#5A544B" },
    },
    dark: {
      task:   { c: "#F9D460", soft: "#4E442A", text: "#F9D460" },
      work:   { c: "#E4744B", soft: "#4A3126", text: "#E88966" },
      health: { c: "#5CCB89", soft: "#2E4233", text: "#5CCB89" },
      growth: { c: "#9E6CC6", soft: "#3C2F3F", text: "#B691D4" },
      people: { c: "#63B9FE", soft: "#303F4A", text: "#63B9FE" },
      sol:    { c: "#F4F1EA", soft: "#3A3732", text: "#F4F1EA", line: "transparent", ink: "#FFFFFF" },
      none:   { c: "#9A9286", soft: "#383530", text: "#D8D1C5" },
    },
    // People groups: shades of the people blue only (no green/orange/yellow, which mean health/work/money)
    peopleShades: { light: ["#007AC5", "#0A5E96", "#3B95D6", "#5F86B3", "#1C4F7A", "#6CA9D9", "#2D6FA3", "#8AA9C9"], dark: ["#63B9FE", "#3D93DA", "#9AD1FF", "#7FA6D6", "#2F78B8", "#B9DDFB", "#5C8FC2", "#A6BED8"] },
  };
  A.keyOf = function (area) { return (area && A.KEY[area]) || (A.KEYS.indexOf(area) >= 0 ? area : "none"); };
  A.color = function (area, theme, part) { var k = A.keyOf(area), t = A[theme === "dark" ? "dark" : "light"][k] || A.light.none; return t[part || "c"] || t.c; };
  A.cssVar = function (area, part) { return "var(--area-" + A.keyOf(area) + (part && part !== "c" ? "-" + part : "") + ")"; };
  A.peopleShade = function (i, theme) { var s = A.peopleShades[theme === "dark" ? "dark" : "light"]; return s[((i % s.length) + s.length) % s.length]; };
  A.css = function () {
    var block = function (t) { return A.KEYS.map(function (k) { var v = A[t][k]; return "--area-" + k + ":" + v.c + ";--area-" + k + "-soft:" + v.soft + ";--area-" + k + "-text:" + v.text + ";" + (v.line ? "--area-" + k + "-line:" + v.line + ";" : "") + (v.ink ? "--area-" + k + "-ink:" + v.ink + ";" : ""); }).join("\n  "); };
    return "/* GENERATED from shared/areas.js by shared/build-areas.js. Do not edit here. */\n" +
      ":root,:host,[data-theme=\"light\"]{\n  " + block("light") + "\n}\n[data-theme=\"dark\"]{\n  " + block("dark") + "\n}\n";
  };
  if (typeof module !== "undefined" && module.exports) module.exports = A;
  root.PPAreas = A;
})(typeof globalThis !== "undefined" ? globalThis : this);
