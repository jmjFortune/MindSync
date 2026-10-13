import {App, Modal, Notice, Platform, Plugin, PluginSettingTab, requestUrl, Setting, TAbstractFile, TFolder} from 'obsidian';
import {Api} from './api';
import {ConnectionContext} from './connection';
import {PlanItem, SyncEngine} from './engine';
import {ObsidianLocal} from './local';
import {FileRecord, included, SyncError} from './types';
interface Settings { server: string; token: string; deviceName: string; paused: boolean }
export default class MindSync extends Plugin {
  settings: Settings = {server:'',token:'',deviceName:Platform.isAndroidApp ? 'Android' : Platform.isMacOS ? 'Mac' : 'PC',paused:false};
  private connection=new ConnectionContext(()=>this.settings);
  engine?: SyncEngine; local?: ObsidianLocal; api!: Api;
  status = '尚未配置'; lastError = ''; private busy = false; private failures = 0; private nextRetry = 0;
  private statusEl!: HTMLElement; private timeout?: number;
  async onload() {
    this.settings = {...this.settings,...await this.loadData()};
    this.statusEl = this.addStatusBarItem(); this.statusEl.setAttribute('role','status'); this.statusEl.setAttribute('aria-live','polite');
    this.statusEl.addEventListener('click',()=>this.showStatus());
    this.addRibbonIcon('refresh-cw','MindSync：立即同步',()=>void this.sync(true));
    this.addCommand({id:'sync',name:'立即同步',callback:()=>void this.sync(true)});
    this.addCommand({id:'preview',name:'预览同步计划',callback:()=>void this.preview()});
    this.addCommand({id:'status',name:'查看状态与冲突',callback:()=>this.showStatus()});
    this.addCommand({id:'pause',name:'暂停或恢复同步',callback:async()=>{this.settings.paused=!this.settings.paused;await this.saveSettings();this.update();}});
    this.addCommand({id:'history',name:'查看当前笔记历史版本',callback:()=>void this.history()});
    this.addSettingTab(new NasSettings(this.app,this));
    try {
      this.local = new ObsidianLocal(this.app,`${this.app.vault.configDir}/plugins/${this.manifest.id}`);
      this.api = this.makeApi(); const state = await this.local.load();
      this.engine = new SyncEngine(state,this.local,this.api,this.settings.deviceName);
      this.engine.onProgress=progress=>{if(progress){this.status=`${progress.direction==='upload'?'上传':'下载'} ${progress.path}：${progress.completed}/${progress.total} 块`;this.update();}};
    } catch(e) { this.report(e); }
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
    this.registerDomEvent(document,'visibilitychange',()=>{if(!document.hidden) { if(Number.isFinite(this.nextRetry)) this.nextRetry=0; void this.sync(); }});
    this.registerInterval(window.setInterval(()=>{if(!document.hidden) void this.sync();},5000));
    this.app.workspace.onLayoutReady(()=>void this.sync()); this.update();
  }
  onunload(){if(this.timeout)window.clearTimeout(this.timeout);}
  private makeApi(token?: string) {
    return new Api(this.connection.http(async(connection,method,path,body)=>{
      const url = new URL(connection.server);
      if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new SyncError('INVALID_URL','服务器地址应为 HTTP 或 HTTPS 地址，不包含账号、查询参数或片段');
      const base = connection.server.replace(/\/+$/,'');
      let timer: ReturnType<typeof setTimeout> | undefined;
      const request=requestUrl({url:base+path,method,headers:{Authorization:`Bearer ${connection.token}`,'Content-Type':body instanceof Uint8Array ? 'application/octet-stream':'application/json'},body:body instanceof Uint8Array ? body.slice().buffer : body,throw:false});
      const reply=await Promise.race([request,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new SyncError('TIMEOUT','请求超时，将保留队列并稍后重试')),path.startsWith('/v1/chunks/') ? 30000 : 120000);})]).finally(()=>{if(timer)clearTimeout(timer);});
      return {status:reply.status,body:reply.arrayBuffer};
    },token));
  }
  async saveSettings(){await this.saveData(this.settings);this.nextRetry=0;}
  private schedule(){if(this.timeout)window.clearTimeout(this.timeout);this.timeout=window.setTimeout(()=>void this.sync(),1000);}
  private update(){this.statusEl?.setText(`NAS：${this.settings.paused?'已暂停':this.status}`);}
  private report(error: unknown){this.lastError=error instanceof Error ? error.message:String(error);this.status=this.lastError;this.update();}
  async sync(manual=false,allowMerge=false) {
    if(!this.engine || this.busy || !this.settings.server || !this.settings.token || (!manual && (this.settings.paused || Date.now()<this.nextRetry)))return;
    this.busy=true;this.status='同步中…';this.update();
    let previewRequired=false;
    try {await this.connection.run(()=>this.engine!.sync(allowMerge));this.status='已同步';this.lastError='';this.failures=0;this.nextRetry=0;if(manual)new Notice('NAS 同步完成');}
    catch(error){this.report(error);this.failures++;this.nextRetry=error instanceof SyncError && ['UNAUTHORIZED','FORBIDDEN','HTTP_401','HTTP_403'].includes(error.code) ? Infinity : Date.now()+Math.min(60000,2000*2**Math.min(this.failures,5))+Math.random()*1000;
      if(error instanceof SyncError && error.code==='INITIAL_MERGE_REQUIRED') { previewRequired=manual; }
      else if(manual)new Notice(this.lastError,8000);
    }finally{this.busy=false;this.update();}
    if(previewRequired)await this.preview();
  }
  async preview(){
    if(!this.engine||this.busy)return;this.busy=true;
    try{
      let viewed=this.connection.current;
      const items=await this.connection.run(()=>{viewed=this.connection.current;return this.engine!.preview();});
      new Preview(this.app,items,()=>{
        const current=this.connection.current;
        if(current.server!==viewed.server||current.token!==viewed.token){new Notice('连接设置已改变，请重新查看同步预览');void this.preview();}
        else void this.sync(true,true);
      }).open();
    }catch(e){this.report(e);new Notice(this.lastError);}finally{this.busy=false;this.update();}
  }
  async testConnection(){if(this.busy)return;this.busy=true;try{const info=await this.connection.run(()=>this.api.info());new Notice(`连接成功，协议 ${info.protocol}，远端版本 ${info.cursor}`);}catch(e){this.report(e);new Notice(this.lastError,8000);}finally{this.busy=false;this.update();}}
  async registerDevice(adminToken:string){if(this.busy)throw new SyncError('SYNC_BUSY','正在同步，请稍后注册设备');this.busy=true;try{await this.connection.run(async()=>{const server=this.connection.current.server;const device=await this.makeApi(adminToken).register(this.settings.deviceName);if(this.settings.server!==server)throw new SyncError('CONNECTION_CHANGED','服务器地址已改变，请使用新地址重新注册设备');this.settings.token=device.token;await this.saveSettings();new Notice('设备已注册，设备令牌已保存到本地');});}finally{this.busy=false;this.update();}}
  showStatus(){
    const modal=new Modal(this.app); modal.setTitle('NAS 同步状态'); const box=modal.contentEl;
    box.createEl('p',{text:this.settings.paused?'同步已暂停':this.status});
    if(this.lastError)box.createEl('p',{text:this.lastError,cls:'mindsync-error',attr:{role:'alert'}});
    box.createEl('p',{text:`待同步操作：${this.engine?.state.pending.length??0}；最后成功：${this.engine?.state.lastSuccess ? new Date(this.engine.state.lastSuccess).toLocaleString():'尚无'}`,cls:'mindsync-summary'});
    const transfer=box.createEl('p');
    const updateTransfer=()=>{const p=this.engine?.progress;transfer.setText(p?`${p.direction==='upload'?'上传':'下载'} ${p.path}：${p.completed}/${p.total} 块`:'');};
    updateTransfer();const progressTimer=window.setInterval(updateTransfer,500);
    const close=modal.onClose.bind(modal);modal.onClose=()=>{window.clearInterval(progressTimer);close();};
    const capacity=box.createEl('p',{text:'正在读取 NAS 存储信息…'});
    void this.api.info().then(info=>capacity.setText(`内容存储：${(info.storage_bytes/1048576).toFixed(1)} MiB；单文件上限：${(info.max_file_bytes/1048576).toFixed(1)} MiB。${info.logical_bytes===undefined?'':`历史逻辑大小：${(info.logical_bytes/1048576).toFixed(1)} MiB；`}历史内容不自动清理，管理端可手动回收无引用对象。`)).catch(()=>capacity.setText('暂时无法读取 NAS 存储信息'));
    box.createEl('p',{text:'Android 关闭应用或被系统挂起时不能保证同步。删除保留在本地 .trash；附件替换备份保存在插件状态日志及 .trash 中。NAS 可读文件树只供查看和导出。'});
    const list=box.createEl('ul',{cls:'mindsync-list'});
    for(const path of this.engine?.state.conflicts??[]){
      const item=list.createEl('li'); const details=this.engine?.state.conflictDetails?.[path];
      item.createEl('p',{text:details ? `${path}；来源：${details.source}；设备：${details.device}；${new Date(details.time).toLocaleString()}` : path});
      const copy=item.createEl('button',{text:'打开冲突副本'});copy.onclick=()=>void this.app.workspace.openLinkText(path,'');
      if(details){const both=item.createEl('button',{text:'打开两份内容'});both.onclick=()=>{
        void this.app.workspace.openLinkText(details.source,'',true);
        void this.app.workspace.openLinkText(path,'',true);
      };}
    }
    new Setting(box).addButton(b=>b.setButtonText('立即重试').onClick(()=>{modal.close();void this.sync(true);})).addButton(b=>b.setButtonText('预览同步').onClick(()=>{modal.close();void this.preview();})); modal.open();
  }
  async history(){
    if(this.busy)return;
    const active=this.app.workspace.getActiveFile();
    const records=Object.values(this.engine?.state.files??{});
    const record=records.find(f=>f.path===active?.path&&!f.deleted);
    if(record){await this.showHistory(record);return;}
    if(!records.length){new Notice('还没有可查看历史的同步文件');return;}
    const modal=new Modal(this.app);modal.setTitle('选择历史文件');
    modal.contentEl.createEl('p',{text:'包含已经删除的文件。恢复会沿用原文件身份并创建新版本。'});
    for(const file of records)new Setting(modal.contentEl).setName(file.path).setDesc(file.deleted?'已删除':'当前版本').addButton(b=>b.setButtonText('查看历史').onClick(()=>{modal.close();void this.showHistory(file);}));
    modal.open();
  }
  private async showHistory(record:FileRecord){
    if(this.busy)return;this.busy=true;
    try{
      const versions=await this.connection.run(()=>this.api.history(record.id));const modal=new Modal(this.app);modal.setTitle(`历史版本：${record.path}`);
      modal.contentEl.createEl('p',{text:'恢复会创建原文件的新版本。当前本地内容先保留为普通副本；远端版本已经变化时会拒绝过期恢复。'});
      for(const version of versions.versions.filter(v=>!v.deleted))new Setting(modal.contentEl).setName(`版本 ${version.revision}`).setDesc(`${version.size} 字节`).addButton(b=>b.setButtonText('恢复此版本').onClick(async()=>{
        b.setDisabled(true);
        try{if(this.busy)throw new SyncError('SYNC_BUSY','正在同步，请稍后恢复');this.busy=true;try{await this.connection.run(()=>this.engine!.restore(record.id,version));}finally{this.busy=false;this.update();}await this.sync(true);modal.close();new Notice(`已恢复 ${record.path} 的历史内容`);}
        catch(e){this.report(e);new Notice(this.lastError,8000);}
        finally{b.setDisabled(false);}
      }));
      modal.open();
    }catch(e){this.report(e);new Notice(this.lastError);}finally{this.busy=false;this.update();}
  }
}
class Preview extends Modal {
  constructor(app:App,private items:PlanItem[],private run:()=>void){super(app);}
  onOpen(){this.setTitle('同步预览');this.contentEl.createEl('p',{text:'预览不会修改文件。首次连接出现不同内容时，会保存本地冲突副本再下载远端。',cls:'mindsync-summary'});const list=this.contentEl.createEl('ul',{cls:'mindsync-list'});for(const item of this.items)list.createEl('li',{text:`${item.action}：${item.path}`});if(!this.items.length)list.createEl('li',{text:'没有待同步变更'});new Setting(this.contentEl).addButton(b=>b.setButtonText('关闭').onClick(()=>this.close())).addButton(b=>b.setButtonText('按预览同步').setCta().onClick(()=>{this.close();this.run();}));}
}
class NasSettings extends PluginSettingTab {
  constructor(app:App,private plugin:MindSync){super(app,plugin);}
  display(){const {containerEl:el}=this;el.empty();el.createEl('h2',{text:'MindSync'});
    el.createEl('p',{text:'连接自己的飞牛同步服务。第一次同步建议先预览。',cls:'mindsync-summary'});
    new Setting(el).setName('服务器地址').setDesc('局域网示例 http://192.168.1.10:8080；外网使用 HTTPS。').addText(t=>t.setValue(this.plugin.settings.server).setPlaceholder('https://notes.example.com').onChange(async value=>{this.plugin.settings.server=value.trim();await this.plugin.saveSettings();}));
    new Setting(el).setName('设备名称').setDesc('用于识别设备和冲突副本；重新加载插件后生效。').addText(t=>t.setValue(this.plugin.settings.deviceName).onChange(async value=>{this.plugin.settings.deviceName=value.trim()||'device';await this.plugin.saveSettings();}));
    new Setting(el).setName('设备令牌').setDesc('仅保存在本地插件配置。不要使用管理令牌作为日常同步凭证。').addText(t=>{t.inputEl.type='password';t.setValue(this.plugin.settings.token).onChange(async value=>{this.plugin.settings.token=value.trim();await this.plugin.saveSettings();});});
    let admin='';new Setting(el).setName('注册此设备').setDesc('输入部署时的管理令牌，注册后自动保存设备令牌。管理令牌不保存。').addText(t=>{t.inputEl.type='password';t.setPlaceholder('管理令牌').onChange(value=>admin=value.trim());}).addButton(b=>b.setButtonText('注册').onClick(async()=>{b.setDisabled(true);try{await this.plugin.registerDevice(admin);admin='';this.display();}catch(e){new Notice(e instanceof Error?e.message:String(e));}finally{b.setDisabled(false);}}));
    new Setting(el).setName('连接和同步').addButton(b=>b.setButtonText('测试连接').onClick(()=>void this.plugin.testConnection())).addButton(b=>b.setButtonText('预览').onClick(()=>void this.plugin.preview())).addButton(b=>b.setButtonText('立即同步').setCta().onClick(()=>void this.plugin.sync(true)));
    new Setting(el).setName('暂停自动同步').setDesc('手动同步仍可使用。').addToggle(t=>t.setValue(this.plugin.settings.paused).onChange(async value=>{this.plugin.settings.paused=value;await this.plugin.saveSettings();}));
    el.createEl('p',{text:'第一版同步笔记和附件，排除隐藏目录、Obsidian 设置及插件。历史版本可从命令面板恢复；没有打开的已同步文件时可选择已删除文件。'});
  }
}
