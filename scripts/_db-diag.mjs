import mysql from "mysql2/promise";
const c = await mysql.createConnection({ host: "localhost", user: "root", password: "", database: "verification_app", port: 3306 });
const [t] = await c.query("SHOW TABLES");
const tables = t.map((x) => Object.values(x)[0]);
console.log("TABLES:", tables.join(", "));
const uTables = tables.filter((n) => /user/i.test(n));
console.log("USER TABLES:", uTables.join(", "));
for (const tb of uTables.slice(0, 4)) {
  try {
    const [r] = await c.query(`SELECT * FROM \`${tb}\` LIMIT 3`);
    console.log(`\n### ${tb} (${r.length} rows shown)`);
    for (const row of r) {
      const o = {};
      for (const [k, v] of Object.entries(row)) {
        if (typeof v === "string" && v.length > 60) o[k] = v.slice(0, 60) + "...";
        else o[k] = v;
      }
      console.log(o);
    }
  } catch (e) {
    console.log(`  ${tb}: ${e.message}`);
  }
}
await c.end();