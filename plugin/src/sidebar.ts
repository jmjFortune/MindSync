import {ButtonComponent,ItemView,Notice,type Workspace,type WorkspaceLeaf} from 'obsidian';
import {sidebarPresentation,type SidebarAction,type SidebarSnapshot} from './sidebar-state';

export const MINDSYNC_VIEW='mindsync-sidebar';
export interface SidebarHost {
  sidebarSnapshot():SidebarSnapshot;
  subscribeSidebar(listener:()=>void):()=>void;
  sync(manual:boolean):Promise<void>;
  preview():Promise<void>;
  history():Promise<void>;
  togglePause():Promise<void>;
  manageConfiguration():void;
  reviewConfiguration():Promise<void>;
}

const opening=new WeakMap<Workspace,Promise<WorkspaceLeaf|undefined>>();
async function sidebarLeaf(workspace:Workspace) {
  // getRightLeaf(false) creates a new tab in the existing sidebar tab group.
  let leaf=workspace.getLeavesOfType(MINDSYNC_VIEW)[0];
  if(!leaf) {
    const created=workspace.getRightLeaf(false);
    if(!created)return;leaf=created;
    await leaf.setViewState({type:MINDSYNC_VIEW,active:false});
  }
  return leaf;
}
export async function openSidebar(workspace:Workspace,reveal=true) {
  let pending=opening.get(workspace);
  if(!pending){pending=sidebarLeaf(workspace);opening.set(workspace,pending);}
  try{const leaf=await pending;if(reveal&&leaf)await workspace.revealLeaf(leaf);return leaf;}
  finally{if(opening.get(workspace)===pending)opening.delete(workspace);}
}

export class MindSyncView extends ItemView {
  private unsubscribe?:()=>void;
  private active=false;
  private buttons=new Map<SidebarAction,ButtonComponent>();
  private statusEl!:HTMLElement;
  private errorEl!:HTMLElement;
  private values=new Map<string,HTMLElement>();
  private conflictsEl!:HTMLElement;
  private conflictsKey='';
  constructor(leaf:WorkspaceLeaf,private host:SidebarHost){super(leaf);}
  getViewType(){return MINDSYNC_VIEW;}
  getDisplayText(){return 'MindSync';}
  getIcon(){return 'refresh-cw';}
  async onOpen() {
    this.unsubscribe?.();this.active=true;this.buttons.clear();this.values.clear();this.conflictsKey='';
    const box=this.contentEl;box.empty();box.addClass('mindsync-sidebar');
    const toolbar=box.createDiv({cls:'mindsync-sidebar-toolbar',attr:{role:'toolbar','aria-label':'MindSync actions'}});
    const action=(key:SidebarAction,icon:string,label:string,run:()=>unknown)=>{
      const button=new ButtonComponent(toolbar).setIcon(icon).setTooltip(label).setClass('clickable-icon');
      button.buttonEl.setAttribute('aria-label',label);
      button.onClick(async()=>{
        if(!this.active||!sidebarPresentation(this.host.sidebarSnapshot())[key])return;
        try{await run();}catch(error){if(this.active)new Notice(error instanceof Error?error.message:String(error),8000);}
      });this.buttons.set(key,button);
    };
    action('sync','refresh-cw','Sync now',()=>this.host.sync(true));
    action('preview','list-checks','Preview sync',()=>this.host.preview());
    action('pause','pause','Pause automatic sync',()=>this.host.togglePause());
    action('history','history','File history',()=>this.host.history());
    action('configuration','settings','Settings and plugins',()=>this.host.manageConfiguration());
    this.statusEl=box.createEl('p',{cls:'mindsync-sidebar-status',attr:{role:'status'}});
    this.errorEl=box.createEl('p',{cls:'mindsync-error',attr:{role:'alert'}});
    const summary=box.createEl('dl',{cls:'mindsync-sidebar-summary'});
    for(const [key,label] of [['lastSuccess','Last sync'],['pending','Pending operations'],['configuration','Settings and plugins'],['updates','Updates awaiting review']]) {
      summary.createEl('dt',{text:label});this.values.set(key,summary.createEl('dd'));
    }
    const review=new ButtonComponent(box).setButtonText('Review updates').onClick(async()=>{
      if(!this.active||!sidebarPresentation(this.host.sidebarSnapshot()).review)return;
      try{await this.host.reviewConfiguration();}catch(error){if(this.active)new Notice(error instanceof Error?error.message:String(error),8000);}
    });this.buttons.set('review',review);
    box.createEl('h3',{text:'Conflicts'});this.conflictsEl=box.createDiv({cls:'mindsync-sidebar-conflicts'});
    this.unsubscribe=this.host.subscribeSidebar(()=>this.refresh());
    this.register(()=>this.disconnect());this.refresh();
  }
  private refresh() {
    if(!this.active)return;
    const state=this.host.sidebarSnapshot(),view=sidebarPresentation(state);
    this.statusEl.setText(view.status);this.errorEl.setText(view.error);this.errorEl.hidden=!view.error;
    for(const [key,button] of this.buttons)button.setDisabled(!view[key]);
    const pause=this.buttons.get('pause')!,label=state.paused?'Resume automatic sync':'Pause automatic sync';
    pause.setIcon(state.paused?'play':'pause').setTooltip(label);
    pause.buttonEl.setAttribute('aria-label',label);pause.buttonEl.setAttribute('aria-pressed',String(state.paused));
    this.values.get('lastSuccess')!.setText(state.lastSuccess?new Date(state.lastSuccess).toLocaleString('en-US'):'Never');
    this.values.get('pending')!.setText(String(state.pending));
    this.values.get('configuration')!.setText(state.configurationStatus);
    this.values.get('updates')!.setText(String(state.updates));
    this.buttons.get('review')!.buttonEl.hidden=state.updates===0;
    const key=JSON.stringify(state.conflicts);
    if(key===this.conflictsKey)return;this.conflictsKey=key;this.conflictsEl.empty();
    if(!state.conflicts.length){this.conflictsEl.createEl('p',{text:'No conflicts'});return;}
    for(const conflict of state.conflicts) {
      const row=this.conflictsEl.createDiv({cls:'mindsync-sidebar-conflict'});
      row.createEl('p',{text:conflict.path});
      const actions=row.createDiv({cls:'mindsync-sidebar-conflict-actions'});
      new ButtonComponent(actions).setButtonText('Open conflict copy').onClick(()=>this.openConflict(conflict.path));
      if(conflict.source)new ButtonComponent(actions).setButtonText('Open both versions').onClick(async()=>{
        await this.openConflict(conflict.source!,true);await this.openConflict(conflict.path,true);
      });
    }
  }
  private async openConflict(path:string,newLeaf=false) {
    if(!this.active)return;
    try{await this.app.workspace.openLinkText(path,'',newLeaf);}
    catch(error){if(this.active)new Notice(error instanceof Error?error.message:String(error),8000);}
  }
  private disconnect(){this.active=false;this.unsubscribe?.();this.unsubscribe=undefined;}
  async onClose(){this.disconnect();this.contentEl.empty();}
}
