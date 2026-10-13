import {URL} from 'node:url';
const args=process.argv.slice(2);
if(args.some(arg=>arg!=='--apply') || args.length>1)throw new Error('Usage: node scripts/gc.mjs [--apply]');
const base=process.env.MINDSYNC_URL,token=process.env.MINDSYNC_ADMIN_TOKEN;
if(!base||!token)throw new Error('Set MINDSYNC_URL and MINDSYNC_ADMIN_TOKEN (administrator credential)');
const url=new URL(base);
if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error('Invalid MINDSYNC_URL');
const response=await fetch(`${base.replace(/\/+$/,'')}/v1/maintenance/gc`,{
  method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
  body:JSON.stringify({dry_run:!args.includes('--apply')}),signal:AbortSignal.timeout(120000),
});
const result=await response.json();
if(!response.ok)throw new Error(`${result.error?.code??response.status}: ${result.error?.message??'GC failed'}`);
console.log(JSON.stringify(result,null,2));
