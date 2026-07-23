#!/usr/bin/env node

import { createInterface } from "readline";
import dotenv from "dotenv";
import mysql from "mysql2/promise";
import bcrypt from "bcryptjs";

dotenv.config();

const STRONG_PASSWORD =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~])[A-Za-z\d!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]{8,}$/;

function ask(rl, prompt) {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

async function main() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    console.log("\n=== Create Admin Account ===\n");

    const full_name = (await ask(rl, "Full name: ")).trim();
    if (!full_name) {
      console.error("Full name is required.");
      process.exit(1);
    }

    const email = (await ask(rl, "Email: ")).trim();
    if (!email || !email.includes("@")) {
      console.error("A valid email is required.");
      process.exit(1);
    }

    const phone = (await ask(rl, "Phone (optional, press Enter to skip): ")).trim() || null;

    let password;
    while (true) {
      password = await ask(rl, "Password: ");
      if (!STRONG_PASSWORD.test(password)) {
        console.log("  Password must be at least 8 chars with uppercase, lowercase, number, and special character. Try again.\n");
        continue;
      }
      const confirm = await ask(rl, "Confirm password: ");
      if (password !== confirm) {
        console.log("  Passwords do not match. Try again.\n");
        continue;
      }
      break;
    }

    const HASH_ROUNDS = 12;
    const hashedPassword = await bcrypt.hash(password, HASH_ROUNDS);

    const conn = await mysql.createConnection({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      port: Number(process.env.DB_PORT || 3306),
    });

    try {
      const [existing] = await conn.query("SELECT id FROM admin_profiles WHERE email=?", [email]);
      if (existing.length) {
        console.error(`\nAn admin with email "${email}" already exists.`);
        process.exit(1);
      }

      const [result] = await conn.query(
        "INSERT INTO admin_profiles (email, password, full_name, phone, status) VALUES (?, ?, ?, ?, 'active')",
        [email, hashedPassword, full_name, phone]
      );

      const [rows] = await conn.query("SELECT uuid FROM admin_profiles WHERE id=?", [result.insertId]);

      console.log(`\nAdmin created successfully.`);
      console.log(`  UUID:  ${rows[0].uuid}`);
      console.log(`  Email: ${email}`);
      console.log(`  Name:  ${full_name}`);
    } finally {
      await conn.end();
    }
  } catch (err) {
    console.error("\nError:", err.message);
    process.exit(1);
  } finally {
    rl.close();
  }
}

main();
