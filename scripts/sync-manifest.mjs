import {readFile,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const source=resolve(root,'plugin/manifest.json');
const target=resolve(root,'manifest.json');
const canonical=await readFile(source,'utf8');
let current=null;
try{current=await readFile(target,'utf8');}catch{}
if(current===canonical){console.log('Root manifest matches plugin/manifest.json');process.exit(0);}
await writeFile(target,canonical);
console.log('Root manifest updated from plugin/manifest.json');
