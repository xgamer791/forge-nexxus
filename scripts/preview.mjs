import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
const args=process.argv.slice(2);
const port=Number(args[args.indexOf('--port')+1]) || 4173;
const root=resolve('docs');
http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  const pathname=decodeURIComponent(url.pathname).replace(/^\/forge-nexxus(?=\/|$)/,'');
  const file=resolve(root,'.'+(pathname.endsWith('/')?pathname+'index.html':pathname));
  if(!file.startsWith(root+'/')){res.writeHead(403);res.end();return;}
  try{const data=await readFile(file);res.writeHead(200,{'Content-Type':({'html':'text/html','css':'text/css','js':'application/javascript'})[extname(file).slice(1)]||'application/octet-stream','Cache-Control':'no-store'});res.end(data);}catch{res.writeHead(404);res.end('Not found');}
}).listen(port,'0.0.0.0');
