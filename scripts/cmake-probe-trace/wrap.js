const fs=require('fs');
const a=process.argv.slice(2);
fs.appendFileSync(process.env.C2LOG||'c2.log', JSON.stringify({cwd:process.cwd(),argv:a})+'\n');
const i=a.indexOf('-o'); if(i>=0&&a[i+1]){fs.writeFileSync(a[i+1],'');}
if(a.includes('--version')||a.includes('-v'))console.log('clang version 24.0.0');
