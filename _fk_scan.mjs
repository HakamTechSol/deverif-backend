import('mysql2/promise.js').then(async (m)=>{
  const mysql=m.default; (await import('dotenv')).default.config();
  const c=await mysql.createConnection({host:process.env.DB_HOST,user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME,port:Number(process.env.DB_PORT||3306)});
  const E='cbf5fcda-0fed-4c13-8c67-ace8952e858b';
  const [fks]=await c.query("SELECT TABLE_NAME,COLUMN_NAME,DELETE_RULE FROM information_schema.KEY_COLUMN_USAGE WHERE REFERENCED_TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME='employees'");
  console.log('TABLES REFERENCING employees:');
  let total=0;
  for(const f of fks){
    const [r]=await c.query(`SELECT COUNT(*) n FROM \`${f.TABLE_NAME}\` WHERE \`${f.COLUMN_NAME}\`=?`,[E]);
    const n=r[0].n; if(n) total+=n;
    console.log('  ',f.TABLE_NAME.padEnd(28),f.COLUMN_NAME.padEnd(24),'rule='+f.DELETE_RULE.padEnd(8),'rows='+n);
  }
  console.log('TOTAL CHILD ROWS AT RISK:', total);
  await c.end();
}).catch(e=>console.log('ERR',e.message));
