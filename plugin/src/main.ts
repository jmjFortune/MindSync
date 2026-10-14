import {App, Modal, Notice, Platform, Plugin, PluginSettingTab, requestUrl, requireApiVersion, Setting, TAbstractFile, TFolder, type ButtonComponent} from 'obsidian';
import {Api} from './api';
import {ConnectionContext} from './connection';
import {PlanItem, SyncEngine} from './engine';
import {ObsidianLocal} from './local';
import {FileRecord, included, SyncError} from './types';
import {ConfigurationLocal} from './configuration-local';
import {ConfigurationSync} from './configuration-sync';
import {ConfigurationSelection, defaultConfigurationSelection} from './configuration-paths';
import {showConfigurationSettings,showConfigurationUpdates} from './configuration-ui';
import {Settings, SettingsDraft, SettingsStore, connectionSettings} from './settings';
import {MINDSYNC_VIEW,MindSyncView,openSidebar} from './sidebar';
import type {SidebarSnapshot} from './sidebar-state';
export default class MindSync extends Plugin {
  settings: Settings = {server:'',token:'',deviceName:Platform.isAndroidApp ? 'Android' : Platform.isMacOS ? 'Mac' : 'PC',paused:false,configuration:defaultConfigurationSelection()};
  private connection=new ConnectionContext(()=>this.settings);
  private settingsStore=new SettingsStore(()=>this.settings,value=>this.saveData(value),value=>{
    const previous=this.settings;this.settings=value;this.engine?.setDeviceName(value.deviceName);
    this.nextRetry=0;this.configurationRetry=0;
    if(previous.configuration!==value.configuration)this.configurationStatus=value.configuration.enabled?'Ready':'Disabled';
    this.notifySidebar();
  });
  engine?: SyncEngine; local?: ObsidianLocal; api!: Api;
  configuration?: ConfigurationSync; configurationStatus='Not configured';
  private unloading=false; private configurationRetry=0;
  status = 'Not configured'; lastError = ''; private busy = false; private failures = 0; private nextRetry = 0;
  private timeout?: number;
  private activity='';
  private sidebarListeners=new Set<()=>void>();
  sidebarSnapshot():SidebarSnapshot {
    return {available:!this.unloading,connected:!!this.settings.server&&!!this.settings.token,ready:!!this.engine,
      configurationReady:!!this.configuration,configurationEnabled:this.settings.configuration.enabled,
      paused:this.settings.paused,busy:this.busy,activity:this.activity,status:this.status,error:this.lastError,
      progress:this.engine?.progress,lastSuccess:this.engine?.state.lastSuccess,pending:this.engine?.state.pending.length??0,
      configurationStatus:this.configurationStatus,updates:this.configuration?.updates().length??0,
      conflicts:(this.engine?.state.conflicts??[]).map(path=>({path,source:this.engine?.state.conflictDetails?.[path]?.source}))};
  }
  subscribeSidebar(listener:()=>void){this.sidebarListeners.add(listener);return ()=>{this.sidebarListeners.delete(listener);};}
  private notifySidebar(){for(const listener of this.sidebarListeners){try{listener();}catch(error){console.error('MindSync sidebar update failed',error);}}}
  private setBusy(busy:boolean,activity=''){this.busy=busy;this.activity=activity;this.notifySidebar();}
  async togglePause(){await this.updateSettings(current=>({paused:!current.paused}));}
  manageConfiguration(){showConfigurationSettings(this);}
  async reviewConfiguration(){await showConfigurationUpdates(this);}
  private async openPanel(reveal=true){if(this.unloading)return;try{await openSidebar(this.app.workspace,reveal);}catch(error){if(!this.unloading)new Notice(error instanceof Error?error.message:String(error),8000);}}
  async onload() {
    this.settings = {...this.settings,...await this.loadData()};
    this.settings.configuration={...defaultConfigurationSelection(),...this.settings.configuration};
    this.registerView(MINDSYNC_VIEW,leaf=>new MindSyncView(leaf,this));
    this.addRibbonIcon('refresh-cw','MindSync: Open panel',()=>void this.openPanel());
    this.addCommand({id:'open-panel',name:'Open MindSync',callback:()=>void this.openPanel()});
    this.addCommand({id:'sync',name:'Sync now',callback:()=>void this.sync(true)});
    this.addCommand({id:'preview',name:'Preview sync plan',callback:()=>void this.preview()});
    this.addCommand({id:'status',name:'View status and conflicts',callback:()=>this.showStatus()});
    this.addCommand({id:'pause',name:'Pause or resume sync',callback:()=>this.togglePause()});
    this.addCommand({id:'history',name:'View file history',callback:()=>void this.history()});
    this.addCommand({id:'configuration',name:'Sync settings and plugins',callback:()=>showConfigurationSettings(this)});
    this.addSettingTab(new NasSettings(this.app,this));
    try {
      this.local = new ObsidianLocal(this.app,`${this.app.vault.configDir}/plugins/${this.manifest.id}`);
      this.api = this.makeApi(); const state = await this.local.load();
      this.engine = new SyncEngine(state,this.local,this.api,this.settings.deviceName);
      this.engine.onProgress=progress=>{if(progress){this.status=`${progress.direction==='upload'?'Upload':'Download'} ${progress.path}: ${progress.completed}/${progress.total} chunks`;}this.notifySidebar();};
    } catch(e) { this.report(e); }
    try {
      const configDir=this.app.vault.configDir;
      const local=new ConfigurationLocal(this.app.vault.adapter,configDir,`${configDir}/plugins/${this.manifest.id}/configuration-sync`);
      await local.load();
      this.configuration=new ConfigurationSync(local,this.makeApi(undefined,'configuration'),()=>this.settings.configuration,Platform.isMobile,requireApiVersion);
      this.configurationStatus=local.state.recoveryNotice??(this.settings.configuration.enabled?'Ready':'Disabled');
    } catch(error) { this.configurationStatus=error instanceof Error?error.message:String(error); }
    const changed = (file: TAbstractFile) => { if (!this.local?.writing && included(file.path,this.app.vault.configDir)) this.schedule(); };
    this.registerEvent(this.app.vault.on('create',changed));
    this.registerEvent(this.app.vault.on('modify',changed));
    this.registerEvent(this.app.vault.on('delete',changed));
    this.registerEvent(this.app.vault.on('rename',(file,old)=>{
      if (this.local?.writing || !included(old,this.app.vault.configDir)) return;
      if (file instanceof TFolder) {
        for (const record of Object.values(this.engine?.state.files ?? {})) if(record.path.startsWith(`${old}/`)) void this.engine?.renamed(record.path,`${file.path}${record.path.slice(old.length)}`).catch(e=>this.report(e));
      } else { void this.engine?.renamed(old,file.path).catch(e=>this.report(e)); }
      this.schedule();
    }));
    this.registerDomEvent(document,'visibilitychange',()=>{if(!document.hidden) { if(Number.isFinite(this.nextRetry)) this.nextRetry=0; void this.sync().then(()=>this.syncConfiguration()); }});
    this.registerInterval(window.setInterval(()=>{if(!document.hidden) void this.sync();},5000));
    this.registerInterval(window.setInterval(()=>{if(!document.hidden)void this.syncConfiguration();},30000));
    this.notifySidebar();
    this.app.workspace.onLayoutReady(()=>{void this.openPanel(false);void this.sync().then(()=>this.syncConfiguration());});
  }
  onunload(){this.unloading=true;this.configuration?.stop();if(this.timeout)window.clearTimeout(this.timeout);this.notifySidebar();this.sidebarListeners.clear();}
  private makeApi(token?: string, scope: 'notes' | 'configuration' = 'notes') {
    return new Api(this.connection.http(async(connection,method,path,body)=>{
      const url = new URL(connection.server);
      if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new SyncError('INVALID_URL','Use an HTTP or HTTPS server URL without credentials, query parameters, or fragments');
      const base = connection.server.replace(/\/+$/,'');
      let timer: ReturnType<typeof setTimeout> | undefined;
      const request=requestUrl({url:base+path,method,headers:{Authorization:`Bearer ${connection.token}`,'Content-Type':body instanceof Uint8Array ? 'application/octet-stream':'application/json'},body:body instanceof Uint8Array ? body.slice().buffer : body,throw:false});
      const reply=await Promise.race([request,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new SyncError('TIMEOUT','Request timed out. Pending operations will be retained and retried')),path.startsWith('/v1/chunks/') ? 30000 : 120000);})]).finally(()=>{if(timer)clearTimeout(timer);});
      return {status:reply.status,body:reply.arrayBuffer};
    },token),scope);
  }
  updateSettings(patch:Partial<Settings>|((current:Settings)=>Partial<Settings>),expected?:Partial<Settings>){return this.settingsStore.update(patch,expected);}
  configurationSelection(){return this.settings.configuration;}
  async saveConfigurationSelection(selection:ConfigurationSelection,expected?:ConfigurationSelection){await this.updateSettings({configuration:selection},expected?{configuration:expected}:undefined);}
  async runConfiguration<T>(work:()=>Promise<T>,manual=true):Promise<T|undefined>{
    if(this.busy||this.unloading){this.configurationStatus='Another sync is in progress. Try again shortly';this.notifySidebar();if(manual)new Notice(this.configurationStatus);return;}
    if(!this.settings.server||!this.settings.token){this.configurationStatus='Configure the server and register this device first';this.notifySidebar();if(manual)new Notice(this.configurationStatus);return;}
    this.configurationStatus='Syncing configuration…';this.setBusy(true,'Syncing configuration…');
    try{
      const result=await this.connection.run(work);
      this.configurationRetry=0;this.configurationStatus=`${this.configuration?.updates().length??0} configuration updates awaiting review${this.configuration?.local.state.incompleteGroups?.length?'; waiting for complete package uploads':''}`;return result;
    }catch(error){this.configurationStatus=error instanceof Error?error.message:String(error);this.configurationRetry=Date.now()+60000;if(manual)new Notice(this.configurationStatus,8000);}
    finally{this.setBusy(false);}
  }
  private async syncConfiguration(manual=false){
    if(!this.configuration||!this.settings.configuration.enabled||this.unloading||(!manual&&(this.settings.paused||Date.now()<this.configurationRetry)))return;
    await this.runConfiguration(()=>this.configuration!.synchronize(),manual);
  }
  private schedule(){if(this.timeout)window.clearTimeout(this.timeout);this.timeout=window.setTimeout(()=>void this.sync(),1000);}
  private report(error: unknown){this.lastError=error instanceof Error ? error.message:String(error);this.status=this.lastError;this.notifySidebar();}
  async sync(manual=false,allowMerge=false) {
    if(this.unloading || !this.engine || this.busy || !this.settings.server || !this.settings.token || (!manual && (this.settings.paused || Date.now()<this.nextRetry)))return;
    this.status='Syncing…';this.setBusy(true,'Syncing…');
    let previewRequired=false;
    try {await this.connection.run(()=>this.engine!.sync(allowMerge));this.status='Synced';this.lastError='';this.failures=0;this.nextRetry=0;if(manual)new Notice('NAS sync completed');}
    catch(error){this.report(error);this.failures++;this.nextRetry=error instanceof SyncError && ['UNAUTHORIZED','FORBIDDEN','HTTP_401','HTTP_403'].includes(error.code) ? Infinity : Date.now()+Math.min(60000,2000*2**Math.min(this.failures,5))+Math.random()*1000;
      if(error instanceof SyncError && error.code==='INITIAL_MERGE_REQUIRED') { previewRequired=manual; }
      else if(manual)new Notice(this.lastError,8000);
    }finally{this.setBusy(false);}
    if(previewRequired)await this.preview();
    else if(manual)await this.syncConfiguration(true);
  }
  async preview(){
    if(!this.engine||this.busy)return;this.setBusy(true,'Loading preview…');
    try{
      let viewed=this.connection.current;
      const items=await this.connection.run(()=>{viewed=this.connection.current;return this.engine!.preview();});
      new Preview(this.app,items,()=>{
        const current=this.connection.current;
        if(current.server!==viewed.server||current.token!==viewed.token){new Notice('Connection settings changed. Preview the sync plan again');void this.preview();}
        else void this.sync(true,true);
      }).open();
    }catch(e){this.report(e);new Notice(this.lastError);}finally{this.setBusy(false);}
  }
  async testConnection(){if(this.busy)return;this.setBusy(true,'Testing connection…');try{const info=await this.connection.run(()=>this.api.info());new Notice(`Connected. Protocol ${info.protocol}, remote revision ${info.cursor}`);}catch(e){this.report(e);new Notice(this.lastError,8000);}finally{this.setBusy(false);}}
  async registerDevice(adminToken:string){if(this.busy)throw new SyncError('SYNC_BUSY','Sync is in progress. Try registering the device later');this.setBusy(true,'Registering device…');try{await this.connection.run(async()=>{const server=this.connection.current.server;const device=await this.makeApi(adminToken).register(this.settings.deviceName);await this.updateSettings({token:device.token},{server});new Notice('Device registered');});}finally{this.setBusy(false);}}
  showStatus(){
    const modal=new Modal(this.app); modal.setTitle('NAS sync status'); const box=modal.contentEl;
    box.createEl('p',{text:this.settings.paused?'Sync paused':this.status});
    if(this.lastError)box.createEl('p',{text:this.lastError,cls:'mindsync-error',attr:{role:'alert'}});
    box.createEl('p',{text:`Pending operations: ${this.engine?.state.pending.length??0}; Last successful sync: ${this.engine?.state.lastSuccess ? new Date(this.engine.state.lastSuccess).toLocaleString('en-US'):'Never'}`,cls:'mindsync-summary'});
    const transfer=box.createEl('p');
    const updateTransfer=()=>{const p=this.engine?.progress;transfer.setText(p?`${p.direction==='upload'?'Upload':'Download'} ${p.path}: ${p.completed}/${p.total} chunks`:'');};
    updateTransfer();const progressTimer=window.setInterval(updateTransfer,500);
    const close=modal.onClose.bind(modal);modal.onClose=()=>{window.clearInterval(progressTimer);close();};
    const capacity=box.createEl('p',{text:'Loading NAS storage information…'});
    void this.api.info().then(info=>capacity.setText(`Stored content: ${(info.storage_bytes/1048576).toFixed(1)} MiB; File size limit: ${(info.max_file_bytes/1048576).toFixed(1)} MiB. ${info.logical_bytes===undefined?'':`Logical history size: ${(info.logical_bytes/1048576).toFixed(1)} MiB; `}`)).catch(()=>capacity.setText('NAS storage information is unavailable'));
    box.createEl('p',{text:`Settings and plugins: ${this.configurationStatus}`});
    if(this.configuration?.updates().length)new Setting(box).setName('Pending configuration updates').addButton(b=>b.setButtonText('Review updates').onClick(()=>{modal.close();void showConfigurationUpdates(this);}));
    const list=box.createEl('ul',{cls:'mindsync-list'});
    for(const path of this.engine?.state.conflicts??[]){
      const item=list.createEl('li'); const details=this.engine?.state.conflictDetails?.[path];
      item.createEl('p',{text:details ? `${path}; Source: ${details.source}; Device: ${details.device}; ${new Date(details.time).toLocaleString('en-US')}` : path});
      const copy=item.createEl('button',{text:'Open conflict copy'});copy.onclick=()=>void this.app.workspace.openLinkText(path,'');
      if(details){const both=item.createEl('button',{text:'Open both versions'});both.onclick=()=>{
        void this.app.workspace.openLinkText(details.source,'',true);
        void this.app.workspace.openLinkText(path,'',true);
      };}
    }
    new Setting(box).addButton(b=>b.setButtonText('Retry now').onClick(()=>{modal.close();void this.sync(true);})).addButton(b=>b.setButtonText('Preview sync').onClick(()=>{modal.close();void this.preview();})); modal.open();
  }
  async history(){
    if(this.busy)return;
    const active=this.app.workspace.getActiveFile();
    const records=Object.values(this.engine?.state.files??{});
    const record=records.find(f=>f.path===active?.path&&!f.deleted);
    if(record){await this.showHistory(record);return;}
    if(!records.length){new Notice('No synced files have history yet');return;}
    const modal=new Modal(this.app);modal.setTitle('Select a file to view history');
    for(const file of records)new Setting(modal.contentEl).setName(file.path).setDesc(file.deleted?'Deleted':'Current revision').addButton(b=>b.setButtonText('View history').onClick(()=>{modal.close();void this.showHistory(file);}));
    modal.open();
  }
  private async showHistory(record:FileRecord){
    if(this.busy)return;this.setBusy(true,'Loading history…');
    try{
      const versions=await this.connection.run(()=>this.api.history(record.id));const modal=new Modal(this.app);modal.setTitle(`History: ${record.path}`);
      for(const version of versions.versions.filter(v=>!v.deleted))new Setting(modal.contentEl).setName(`Revision ${version.revision}`).setDesc(`${version.size} bytes`).addButton(b=>b.setButtonText('Restore this revision').onClick(async()=>{
        b.setDisabled(true);
        try{if(this.busy)throw new SyncError('SYNC_BUSY','Sync is in progress. Try restoring later');this.setBusy(true,'Restoring history…');try{await this.connection.run(()=>this.engine!.restore(record.id,version));}finally{this.setBusy(false);}await this.sync(true);modal.close();new Notice(`Restored a historical revision of ${record.path}`);}
        catch(e){this.report(e);new Notice(this.lastError,8000);}
        finally{b.setDisabled(false);}
      }));
      modal.open();
    }catch(e){this.report(e);new Notice(this.lastError);}finally{this.setBusy(false);}
  }
}
class Preview extends Modal {
  constructor(app:App,private items:PlanItem[],private run:()=>void){super(app);}
  onOpen(){this.setTitle('Sync preview');const list=this.contentEl.createEl('ul',{cls:'mindsync-list'});for(const item of this.items)list.createEl('li',{text:`${item.action}: ${item.path}`});if(!this.items.length)list.createEl('li',{text:'No pending changes'});new Setting(this.contentEl).addButton(b=>b.setButtonText('Close').onClick(()=>this.close())).addButton(b=>b.setButtonText('Sync this plan').setCta().onClick(()=>{this.close();this.run();}));}
}
class NasSettings extends PluginSettingTab {
  constructor(app:App,private plugin:MindSync){super(app,plugin);}
  hide(){super.hide();this.containerEl.removeClass('mindsync-settings');}
  display(){
    const {containerEl:el}=this;el.empty();el.addClass('mindsync-settings');el.createEl('h2',{text:'MindSync'});
    const draft=new SettingsDraft(connectionSettings(this.plugin.settings));
    const actions:ButtonComponent[]=[],inputs:{setDisabled(value:boolean):unknown}[]=[];
    let saving=false,admin='',save:ButtonComponent|undefined,register:ButtonComponent|undefined;
    const error=el.createEl('p',{cls:'mindsync-error',attr:{role:'alert'}});error.hidden=true;
    const refresh=()=>{
      save?.setDisabled(saving||!draft.dirty);save?.setButtonText(saving?'Saving…':'Save changes');
      for(const action of actions)action.setDisabled(saving||draft.dirty);
      register?.setDisabled(saving||draft.dirty||!admin);
      for(const input of inputs)input.setDisabled(saving);
    };
    const report=(value:unknown)=>{error.hidden=false;error.setText(value instanceof Error?value.message:String(value));};
    new Setting(el).setName('Server URL').addText(t=>{
      inputs.push(t);t.inputEl.setAttribute('aria-label','Server URL');
      t.setValue(draft.value.server).setPlaceholder('https://notes.example.com').onChange(value=>{draft.value.server=value.trim();refresh();});
    });
    new Setting(el).setName('Device name').addText(t=>{
      inputs.push(t);t.inputEl.setAttribute('aria-label','Device name');
      t.setValue(draft.value.deviceName).onChange(value=>{draft.value.deviceName=value.trim()||'device';refresh();});
    });
    let tokenInput:HTMLInputElement;
    new Setting(el).setName('Device token').addText(t=>{
      inputs.push(t);tokenInput=t.inputEl;tokenInput.type='password';tokenInput.autocomplete='off';
      tokenInput.setAttribute('aria-label','Device token');
      t.setValue(draft.value.token).onChange(value=>{draft.value.token=value.trim();refresh();});
    }).addButton(b=>{
      b.setButtonText('Show');b.buttonEl.setAttribute('aria-label','Show device token');
      b.onClick(()=>{const visible=tokenInput.type==='password';tokenInput.type=visible?'text':'password';b.setButtonText(visible?'Hide':'Show');b.buttonEl.setAttribute('aria-label',visible?'Hide device token':'Show device token');});
    });
    new Setting(el).setName('Register this device').addText(t=>{
      inputs.push(t);t.inputEl.type='password';t.inputEl.setAttribute('aria-label','Admin token');
      t.setPlaceholder('Admin token').onChange(value=>{admin=value.trim();refresh();});
    }).addButton(b=>{
      register=b;b.setButtonText('Register').onClick(async()=>{
        saving=true;refresh();try{await this.plugin.registerDevice(admin);admin='';this.display();}catch(value){report(value);}finally{saving=false;refresh();}
      });
    });
    new Setting(el).setName('Connection and sync')
      .addButton(b=>{actions.push(b);b.setButtonText('Test connection').onClick(()=>void this.plugin.testConnection());})
      .addButton(b=>{actions.push(b);b.setButtonText('Preview').onClick(()=>void this.plugin.preview());})
      .addButton(b=>{actions.push(b);b.setButtonText('Sync now').setCta().onClick(()=>void this.plugin.sync(true));});
    new Setting(el).setName('Pause automatic sync').addToggle(t=>{
      inputs.push(t);t.setValue(draft.value.paused).onChange(value=>{draft.value.paused=value;refresh();});
    });
    new Setting(el).setName('Settings and plugins').addButton(b=>{
      actions.push(b);b.setButtonText('Manage').onClick(()=>showConfigurationSettings(this.plugin));
    });
    new Setting(el).addButton(b=>{
      save=b;b.setButtonText('Save changes').setCta().onClick(async()=>{
        saving=true;refresh();try{await this.plugin.updateSettings(draft.patch(),draft.expected());this.display();new Notice('Changes saved');}
        catch(value){report(value);}finally{saving=false;refresh();}
      });
    });
    refresh();
  }
}
