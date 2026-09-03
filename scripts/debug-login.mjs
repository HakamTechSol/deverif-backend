import mysql from "mysql2/promise";
import "dotenv/config";
import { hashPassword } from "../src/utils/password.js";
import { signAccessToken } from "../src/utils/jwt.js";

const BASE = "http://localhost:5000/api/v1";
const db = await mysql.createConnection({ host: "localhost", user: "root", password: "", database: "verification_app" });

const [[user]] = await db.query("SELECT uuid, organization, status, email FROM users WHERE email=?", ["owner@template.test"]);
console.log("User:", user);

if (user) {
  const token = signAccessToken({ type: "user", userId: user.uuid, role: "user", organization: user.organization, org_role: "org_admin" });
  
  // Test login with password directly
  const res = await fetch(BASE + "/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "owner@template.test", password: "X#12345678" })
  });
  console.log("Login status:", res.status);
  console.log(await res.json());
}

db.end();