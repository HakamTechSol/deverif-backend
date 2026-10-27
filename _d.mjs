import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();
const c = await mysql.createConnection({host:process.env.DB_HOST,user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME,port:Number(process.env.DB_PORT||3306)});
const [r] = await c.query("SELECT id,name,module_flags FROM subscription_plans WHERE id IN (1,2,3)");
for (const x of r) console.log(x.id, x.name, '->', x.module_flags);
await c.end(); process.exit(0);
