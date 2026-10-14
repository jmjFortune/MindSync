import {expect,test,vi} from 'vitest';
import type {App,Workspace,WorkspaceLeaf} from 'obsidian';
import type {SyncEngine} from '../src/engine';
import type {ConfigurationSync} from '../src/configuration-sync';
import type {SidebarSnapshot} from '../src/sidebar-state';
import {emptyState} from '../src/types';

const ui=vi.hoisted(()=>{
  class Element {
    children:Element[]=[];text='';cls='';attrs:Record<string,string>={};hidden=false;disabled=false;
    onclick?:()=>Promise<unknown>;tag:string;
    constructor(tag='div'){this.tag=tag;}
    createEl(tag:string,options:{text?:string;cls?:string;attr?:Record<string,string>}={}){
      const child=new Element(tag);child.text=options.text??'';child.cls=options.cls??'';child.attrs={...options.attr};this.children.push(child);return child;
    }
    createDiv(options:{cls?:string;attr?:Record<string,string>}={}){return this.createEl('div',options);}
    setText(text:string){this.text=text;}
    addClass(cls:string){this.cls+=' '+cls;}
    empty(){this.children=[];this.text='';}
    setAttribute(key:string,value:string){this.attrs[key]=value;}
    all():Element[]{return [this,...this.children.flatMap(child=>child.all())];}
  }
  const notices:string[]=[];
  return {Element,notices};
});
vi.mock('obsidian',()=>({
  ItemView:class {
    app:App;contentEl=new ui.Element();cleanup:(()=>void)[]=[];
    constructor(leaf:WorkspaceLeaf){this.app=(leaf as unknown as {app:App}).app;}
    register(callback:()=>void){this.cleanup.push(callback);}
  },
  ButtonComponent:class {
    buttonEl:InstanceType<typeof ui.Element>;
    constructor(container:InstanceType<typeof ui.Element>){this.buttonEl=container.createEl('button');}
    setIcon(icon:string){this.buttonEl.attrs.icon=icon;return this;}
    setTooltip(text:string){this.buttonEl.attrs.tooltip=text;return this;}
    setClass(cls:string){this.buttonEl.cls=cls;return this;}
    setButtonText(text:string){this.buttonEl.text=text;return this;}
    setDisabled(value:boolean){this.buttonEl.disabled=value;return this;}
    onClick(callback:()=>Promise<unknown>){this.buttonEl.onclick=callback;return this;}
  },
  Notice:class {constructor(text:string){ui.notices.push(text);}},
  Plugin:class {constructor(public app:App){} async saveData(_value:unknown){}},
  PluginSettingTab:class {},Modal:class {},Setting:class {},TFolder:class {},
  Platform:{isMacOS:true},requireApiVersion:()=>true,requestUrl:vi.fn(),
}));
import MindSync from '../src/main';
import {MINDSYNC_VIEW,MindSyncView,openSidebar,type SidebarHost} from '../src/sidebar';
import {sidebarPresentation} from '../src/sidebar-state';

function snapshot():SidebarSnapshot {
  return {available:true,connected:true,ready:true,configurationReady:true,configurationEnabled:true,paused:false,busy:false,
    activity:'',status:'Synced',error:'',pending:0,configurationStatus:'Ready',updates:0,conflicts:[]};
}
function fixture(){
  const state=snapshot(),listeners=new Set<()=>void>();
  const host:SidebarHost={sidebarSnapshot:()=>state,subscribeSidebar:listener=>{listeners.add(listener);return()=>{listeners.delete(listener);};},
    sync:vi.fn(async()=>{}),preview:vi.fn(async()=>{}),history:vi.fn(async()=>{}),togglePause:vi.fn(async()=>{}),
    manageConfiguration:vi.fn(),reviewConfiguration:vi.fn(async()=>{})};
  const workspace={openLinkText:vi.fn(async()=>{})};
  const view=new MindSyncView({app:{workspace}} as unknown as WorkspaceLeaf,host);
  const box=view.contentEl as unknown as InstanceType<typeof ui.Element>;
  const notify=()=>{for(const listener of listeners)listener();};
  const button=(label:string)=>box.all().find(el=>el.tag==='button'&&(el.attrs['aria-label']===label||el.text===label))!;
  return {state,host,workspace,view,box,listeners,notify,button};
}
test('startup adds a separate native tab without replacing Git or revealing the sidebar',async()=>{
  const git={setViewState:vi.fn()},leaf={setViewState:vi.fn(async()=>{})};
  const workspace={getLeavesOfType:vi.fn((type:string)=>type===MINDSYNC_VIEW?[]:[git]),getRightLeaf:vi.fn(()=>leaf),revealLeaf:vi.fn()};
  await openSidebar(workspace as unknown as Workspace,false);
  expect(workspace.getRightLeaf).toHaveBeenCalledWith(false);
  expect(leaf.setViewState).toHaveBeenCalledWith({type:MINDSYNC_VIEW,active:false});
  expect(workspace.revealLeaf).not.toHaveBeenCalled();expect(git.setViewState).not.toHaveBeenCalled();
});
test('explicit open reuses and reveals a restored deferred leaf without accessing its view',async()=>{
  const leaf={get view(){throw new Error('deferred view must not be accessed');}};
  const workspace={getLeavesOfType:vi.fn(()=>[leaf]),getRightLeaf:vi.fn(),revealLeaf:vi.fn(async()=>{})};
  await openSidebar(workspace as unknown as Workspace);await openSidebar(workspace as unknown as Workspace);
  expect(workspace.getRightLeaf).not.toHaveBeenCalled();expect(workspace.revealLeaf).toHaveBeenCalledTimes(2);
});
test('simultaneous startup and explicit open create one leaf',async()=>{
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  const leaf={setViewState:vi.fn(()=>gate)},workspace={getLeavesOfType:()=>[],getRightLeaf:vi.fn(()=>leaf),revealLeaf:vi.fn(async()=>{})};
  const start=openSidebar(workspace as unknown as Workspace,false),open=openSidebar(workspace as unknown as Workspace);
  release();await Promise.all([start,open]);expect(workspace.getRightLeaf).toHaveBeenCalledTimes(1);expect(workspace.revealLeaf).toHaveBeenCalledTimes(1);
});
test('failed leaf creation can be retried without a stuck opening promise',async()=>{
  const leaf={setViewState:vi.fn().mockRejectedValueOnce(new Error('layout unavailable')).mockResolvedValue(undefined)};
  const workspace={getLeavesOfType:()=>[],getRightLeaf:()=>leaf,revealLeaf:vi.fn(async()=>{})};
  await expect(openSidebar(workspace as unknown as Workspace)).rejects.toThrow('layout unavailable');
  await openSidebar(workspace as unknown as Workspace);expect(workspace.revealLeaf).toHaveBeenCalledTimes(1);
});
test('busy transfer takes precedence over pause and an old error',()=>{
  const state:SidebarSnapshot={...snapshot(),paused:true,busy:true,activity:'Syncing…',error:'old error',progress:{path:'large.pdf',direction:'upload',completed:2,total:8}};
  const view=sidebarPresentation(state);expect(view.status).toBe('Upload large.pdf: 2/8 chunks');expect(view.error).toBe('');expect(view.sync).toBe(false);
  state.busy=false;state.progress=undefined;
  expect(sidebarPresentation(state).status).toBe('Sync failed');state.error='';expect(sidebarPresentation(state).status).toBe('Paused');
});
test('missing connection, missing engines and unload disable dependent actions',()=>{
  expect(sidebarPresentation({...snapshot(),connected:false})).toMatchObject({status:'Not configured',sync:false,history:false,configuration:false,pause:true});
  expect(sidebarPresentation({...snapshot(),ready:false,error:'journal unavailable'})).toMatchObject({status:'Unavailable',sync:false,error:'journal unavailable'});
  expect(sidebarPresentation({...snapshot(),configurationReady:false})).toMatchObject({sync:true,configuration:false,review:false});
  expect(sidebarPresentation({...snapshot(),available:false})).toMatchObject({status:'Unavailable',sync:false,pause:false,configuration:false});
});
test('opening the panel reads local state only and exposes accessible native controls',async()=>{
  const f=fixture();await f.view.onOpen();
  for(const method of ['sync','preview','history','togglePause','manageConfiguration','reviewConfiguration'] as const)expect(f.host[method]).not.toHaveBeenCalled();
  expect(f.box.all().some(el=>el.attrs.role==='toolbar'&&el.attrs['aria-label']==='MindSync actions')).toBe(true);
  expect(f.button('Sync now').attrs.tooltip).toBe('Sync now');expect(f.button('Pause automatic sync').attrs['aria-pressed']).toBe('false');
  expect(f.box.all().some(el=>el.text==='No conflicts')).toBe(true);
});
test('progress refresh preserves button identity and applies current guards even before repaint',async()=>{
  const f=fixture();await f.view.onOpen();const button=f.button('Sync now');
  f.state.busy=true;f.state.activity='Syncing…';await button.onclick!();expect(f.host.sync).not.toHaveBeenCalled();
  f.notify();expect(f.button('Sync now')).toBe(button);expect(button.disabled).toBe(true);
  f.state.busy=false;f.state.progress=undefined;f.notify();await button.onclick!();expect(f.host.sync).toHaveBeenCalledWith(true);
});
test('pause state and configuration review counts update without replacing toolbar controls',async()=>{
  const f=fixture();await f.view.onOpen();const pause=f.button('Pause automatic sync'),review=f.button('Review updates');
  expect(review.hidden).toBe(true);f.state.paused=true;f.state.updates=2;f.notify();
  expect(f.button('Resume automatic sync')).toBe(pause);expect(pause.attrs['aria-pressed']).toBe('true');expect(review.hidden).toBe(false);
  await pause.onclick!();await review.onclick!();expect(f.host.togglePause).toHaveBeenCalledOnce();expect(f.host.reviewConfiguration).toHaveBeenCalledOnce();
  f.state.configurationEnabled=false;f.notify();expect(review.disabled).toBe(true);
});
test('conflict actions open tracked paths in Obsidian and do not invoke sync',async()=>{
  const f=fixture();f.state.conflicts=[{path:'note (conflict).md',source:'note.md'}];await f.view.onOpen();
  await f.button('Open both versions').onclick!();
  expect(f.workspace.openLinkText.mock.calls).toEqual([['note.md','',true],['note (conflict).md','',true]]);expect(f.host.sync).not.toHaveBeenCalled();
});
test('closing unsubscribes and an in-flight action cannot update a closed view',async()=>{
  const f=fixture();let reject!:(error:Error)=>void;
  vi.mocked(f.host.sync).mockImplementation(()=>new Promise<void>((_resolve,rejectPromise)=>{reject=rejectPromise;}));
  await f.view.onOpen();const button=f.button('Sync now'),pending=button.onclick!(),notices=ui.notices.length;
  await f.view.onClose();expect(f.listeners.size).toBe(0);f.notify();reject(new Error('late failure'));await pending;
  expect(f.box.children).toEqual([]);expect(ui.notices.length).toBe(notices);
  await button.onclick!();expect(f.host.sync).toHaveBeenCalledTimes(1);
  await f.view.onOpen();expect(f.listeners.size).toBe(1);await f.view.onClose();expect(f.listeners.size).toBe(0);
});
test('native component unload disposes its view subscription',async()=>{
  const f=fixture();await f.view.onOpen();
  for(const cleanup of (f.view as unknown as {cleanup:(()=>void)[]}).cleanup)cleanup();
  expect(f.listeners.size).toBe(0);await f.button('Sync now').onclick!();expect(f.host.sync).not.toHaveBeenCalled();
});
test('plugin notifications show running and final state, and unsubscribe stops delivery',async()=>{
  const plugin=new MindSync({} as App,{id:'mindsync'} as never);plugin.settings.server='https://fixture.example';plugin.settings.token='fixture-token';plugin.settings.paused=true;
  let finish!:()=>void;const gate=new Promise<void>(resolve=>{finish=resolve;});const state=emptyState();
  plugin.engine={state,setDeviceName:()=>{},sync:async()=>{await gate;state.lastSuccess='2026-10-14T11:30:00Z';}} as unknown as SyncEngine;
  const states:SidebarSnapshot[]=[],stop=plugin.subscribeSidebar(()=>states.push(plugin.sidebarSnapshot()));
  const run=plugin.sync(true);expect(states[0]).toMatchObject({busy:true,activity:'Syncing…',paused:true});
  finish();await run;expect(states.at(-1)).toMatchObject({busy:false,status:'Synced',lastSuccess:'2026-10-14T11:30:00Z'});
  const count=states.length;stop();await plugin.togglePause();expect(states.length).toBe(count);expect(plugin.settings.paused).toBe(false);
  expect(plugin.settings.token).toBe('fixture-token');
});
test('failed pause persistence retains active settings and reports the failure in the panel',async()=>{
  const plugin=new MindSync({} as App,{id:'mindsync'} as never);const state=plugin.sidebarSnapshot();
  vi.spyOn(plugin,'saveData').mockRejectedValue(new Error('disk full'));
  const f=fixture();f.host.togglePause=()=>plugin.togglePause();await f.view.onOpen();const notices=ui.notices.length;
  await f.button('Pause automatic sync').onclick!();expect(plugin.settings.paused).toBe(state.paused);
  expect(ui.notices.slice(notices)).toEqual(['disk full']);
});
test('configuration work and unload notify subscribers without a new network poll',async()=>{
  const plugin=new MindSync({} as App,{id:'mindsync'} as never);plugin.settings.server='https://fixture.example';plugin.settings.token='fixture-token';
  let updates=0;const stop=vi.fn();plugin.configuration={updates:()=>Array(updates).fill({}),local:{state:{}},stop} as unknown as ConfigurationSync;
  const snapshots:SidebarSnapshot[]=[];plugin.subscribeSidebar(()=>snapshots.push(plugin.sidebarSnapshot()));
  await plugin.runConfiguration(async()=>{updates=2;});
  expect(snapshots[0]).toMatchObject({busy:true,activity:'Syncing configuration…'});expect(snapshots.at(-1)).toMatchObject({busy:false,updates:2});
  plugin.onunload();expect(snapshots.at(-1)?.available).toBe(false);expect(stop).toHaveBeenCalledOnce();
  const count=snapshots.length;await plugin.togglePause();expect(snapshots.length).toBe(count);
});
test('a failing view observer cannot turn a durable settings save into a failure',async()=>{
  const plugin=new MindSync({} as App,{id:'mindsync'} as never),error=new Error('view unavailable');
  const log=vi.spyOn(console,'error').mockImplementation(()=>{});
  const stop=plugin.subscribeSidebar(()=>{throw error;});
  try{await plugin.togglePause();expect(plugin.settings.paused).toBe(true);expect(log).toHaveBeenCalledWith('MindSync sidebar update failed',error);}
  finally{stop();log.mockRestore();}
});
