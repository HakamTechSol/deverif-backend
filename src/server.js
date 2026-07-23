import dotenv from "dotenv";
dotenv.config();
import app from "./app.js";
import { pool } from "./config/db.js";

const PORT = process.env.PORT || 5000;

(async () => {
  try {
    await pool.query("SELECT 1");
    console.log("✅ DB connected");
    app.listen(PORT, () => console.log(`✅ Server running on http://localhost:${PORT}`));
  } catch (e) {
    console.error("❌ DB connection failed:", e.message);
    process.exit(1);
  }
})();
