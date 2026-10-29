import { Database } from "bun:sqlite";
const db = new Database(":memory:");
console.log("sqlite", db.query("select sqlite_version() v").get());
db.run("create virtual table t using fts5(title, body, tokenize='porter unicode61')");
const ins = db.prepare("insert into t values (?, ?)");
for (let i = 0; i < 20000; i++) ins.run(`Paper ${i} on liver transplantation`, `Body ${i} normothermic machine perfusion outcomes donor ${i % 7}`);
let t = performance.now();
const rows = db.query("select rowid, snippet(t, 1, '[', ']', '…', 6) s, bm25(t) r from t where t match ? order by r limit 3").all("perfused AND donor");
console.log(rows, (performance.now() - t).toFixed(1) + "ms");
