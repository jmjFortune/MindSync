// MINDSYNC_ADMIN_TOKEN is read only from the environment and never printed.
const base=process.env.MINDSYNC_URL;
const token=process.env.MINDSYNC_ADMIN_TOKEN;
if(!base||!token)throw new Error('Set MINDSYNC_URL and MINDSYNC_ADMIN_TOKEN.');
const url=new URL(base);
if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error('Invalid server URL.');
const action=process.argv[2]??'list';
if(!['list','revoke'].includes(action))throw new Error('Use list or revoke DEVICE_ID.');
const id=process.argv[3];
if(action==='revoke'&&(!id||!/^[a-zA-Z0-9_-]+$/.test(id)))throw new Error('Supply a valid device ID.');
const response=await fetch(`${base.replace(/\/+$/,'')}/v1/devices${action==='revoke'?`/${id}`:''}`,{method:action==='revoke'?'DELETE':'GET',headers:{Authorization:`Bearer ${token}`}});
if(!response.ok)throw new Error(`Device administration failed (${response.status}).`);
if(action==='list')console.log(JSON.stringify(await response.json(),null,2));else console.log('Device revoked.');
