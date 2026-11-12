// Writes shared/areas.css from shared/areas.js, so the colours have one source. Run: node shared/build-areas.js
const fs = require("fs"), path = require("path");
const A = require("./areas.js");
fs.writeFileSync(path.join(__dirname, "areas.css"), A.css());
console.log("wrote shared/areas.css");
