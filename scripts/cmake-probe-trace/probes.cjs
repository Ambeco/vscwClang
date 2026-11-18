const fs=require("fs"),path=require("path");const seen={};
for(const l of fs.readFileSync(process.argv[2],"utf8").split("\n")){let o;try{o=JSON.parse(l)}catch{continue}
 if(!o.cmd)continue;
 if(/^(try_compile|try_run|execute_process|check_\w+|find_package|FetchContent_\w+|ExternalProject_\w+|configure_file)$/i.test(o.cmd)){const k=o.cmd+" "+(o.args||[]).slice(0,2).join(" ").replace(/\s+/g," ").slice(0,70)+" @"+path.basename(o.file)+":"+o.line;seen[k]=(seen[k]||0)+1}}
for(const k in seen)console.log(seen[k],k)
