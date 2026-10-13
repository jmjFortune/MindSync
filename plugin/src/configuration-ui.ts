import {App, Modal, Notice, Setting} from 'obsidian';
import {ConfigurationSync} from './configuration-sync';
import {ConfigurationSelection, configurationApplyGroup as configurationGroup} from './configuration-paths';
import {decode} from './types';

export interface ConfigurationUiHost {
  app: App;
  configuration?: ConfigurationSync;
  configurationStatus: string;
  configurationSelection(): ConfigurationSelection;
  saveConfigurationSelection(selection: ConfigurationSelection): Promise<void>;
  runConfiguration<T>(work:()=>Promise<T>):Promise<T|undefined>;
}

export function showConfigurationSettings(host:ConfigurationUiHost) {
  const modal=new Modal(host.app);modal.setTitle('Settings and plugins');let generation=0;
  const render=async()=>{
    const current=++generation,box=modal.contentEl;box.empty();
    box.createEl('p',{text:'Share selected Obsidian settings, themes, snippets, and plugins. Each device chooses what to sync. Incoming changes wait for your review.'});
    const selection=host.configurationSelection();
    new Setting(box).setName('Sync settings and plugins').setDesc('Enable this feature on each device. MindSync credentials, journals, and workspace files stay local.').addToggle(toggle=>toggle.setValue(selection.enabled).onChange(async enabled=>{
      await host.saveConfigurationSelection({...host.configurationSelection(),enabled});await render();
    }));
    const status=box.createEl('p',{text:host.configurationStatus,attr:{role:'status'}});
    if(!selection.enabled)return;
    if(!host.configuration){status.setText('Configuration sync is unavailable. Reload the plugin or review its error status.');return;}
    const update=async(change:Partial<ConfigurationSelection>)=>host.saveConfigurationSelection({...host.configurationSelection(),...change});
    new Setting(box).setName('Obsidian settings').setDesc('Preferences, appearance, hotkeys, and core plugins.').addToggle(t=>t.setValue(selection.settings).onChange(async value=>{await update({settings:value});}));
    new Setting(box).setName('Enabled plugin list').setDesc('Only selected, installed, compatible plugins are enabled. Other local choices are preserved.').addToggle(t=>t.setValue(selection.enabledPlugins).onChange(async value=>{await update({enabledPlugins:value});}));
    box.createEl('h3',{text:'Select items'});
    const inventoryBox=box.createDiv();inventoryBox.createEl('p',{text:'Loading local and remote items…'});
    const paths=await host.runConfiguration(()=>host.configuration!.inventory());
    if(current!==generation)return;
    if(!paths){inventoryBox.empty();inventoryBox.createEl('p',{text:host.configurationStatus,attr:{role:'alert'}});return;}
    inventoryBox.empty();
    const plugins=[...new Set(paths.filter(p=>p.startsWith('plugins/')).map(p=>p.split('/')[1]))];
    for(const id of plugins){
      const options=host.configurationSelection().plugins[id]??{files:false,settings:false};
      new Setting(inventoryBox).setName(`Plugin: ${id}`).setDesc('Sync plugin files. Apply updates as a complete group, then reload Obsidian.').addToggle(t=>t.setValue(options.files).onChange(async value=>{
        const s=host.configurationSelection(),previous=s.plugins[id]??{files:false,settings:false};await update({plugins:{...s.plugins,[id]:{...previous,files:value}}});
      }));
      if(paths.includes(`plugins/${id}/data.json`))new Setting(inventoryBox).setName(`${id}: settings`).setDesc('Optional. Plugin settings may contain API keys or account information.').addToggle(t=>t.setValue(options.settings).onChange(async value=>{
        const s=host.configurationSelection(),previous=s.plugins[id]??{files:false,settings:false};await update({plugins:{...s.plugins,[id]:{...previous,settings:value}}});
      }));
    }
    for(const [folder,label] of [['themes','Theme'],['snippets','Snippet']] as const){
      const names=[...new Set(paths.filter(p=>p.startsWith(folder+'/')).map(p=>p.split('/')[1]))];
      for(const name of names)new Setting(inventoryBox).setName(`${label}: ${name}`).addToggle(t=>t.setValue(host.configurationSelection()[folder].includes(name)).onChange(async value=>{
        const selected=host.configurationSelection()[folder];await update({[folder]:value?[...new Set([...selected,name])]:selected.filter(p=>p!==name)});
      }));
    }
    if(!plugins.length&&!paths.some(p=>p.startsWith('themes/')||p.startsWith('snippets/')))inventoryBox.createEl('p',{text:'No optional plugin, theme, or snippet files found.'});
    box.createEl('h3',{text:'Publish or receive'});
    box.createEl('p',{text:'On the source device, publish selected items. On another device, review remote settings. Changing the selection never deletes local files.'});
    new Setting(box).addButton(b=>b.setButtonText('Publish this device').onClick(()=>void showPublishPreview(host))).addButton(b=>b.setButtonText('Review remote settings').setCta().onClick(()=>void showConfigurationUpdates(host)));
  };
  const close=modal.onClose.bind(modal);modal.onClose=()=>{generation++;close();};modal.open();void render();
}

async function showPublishPreview(host:ConfigurationUiHost) {
  if(!host.configuration)return;
  const items=await host.runConfiguration(()=>host.configuration!.previewPublish());if(!items)return;
  const modal=new Modal(host.app);modal.setTitle('Publish selected settings');
  modal.contentEl.createEl('p',{text:'This preview does not change files. Differing remote content is kept for review; it is not overwritten automatically.'});
  const list=modal.contentEl.createEl('ul');for(const item of items)list.createEl('li',{text:`${item.action}: ${item.path}`});
  if(!items.length)modal.contentEl.createEl('p',{text:'The selected items are already up to date.'});
  new Setting(modal.contentEl).addButton(b=>b.setButtonText('Not now').onClick(()=>modal.close())).addButton(b=>b.setButtonText('Publish selected').setCta().onClick(async()=>{
    b.setDisabled(true);try{
      const count=await host.runConfiguration(()=>host.configuration!.publish(items));
      if(count!==undefined){modal.close();new Notice(`Published ${count} configuration files`);if(host.configuration!.updates().length)await showConfigurationUpdates(host);}
    }finally{b.setDisabled(false);}
  }));modal.open();
}

export async function showConfigurationUpdates(host:ConfigurationUiHost) {
  if(!host.configuration)return;
  const updates=await host.runConfiguration(()=>host.configuration!.review());if(!updates)return;
  const modal=new Modal(host.app);modal.setTitle('Review configuration updates');
  modal.contentEl.createEl('p',{text:'Review each group before applying. Current files are backed up. Local edits made after this preview prevent application. Reload Obsidian after applying updates.'});
  if(host.configuration.local.state.incompleteGroups?.length)modal.contentEl.createEl('p',{text:'Some package uploads are incomplete. Wait for the source device to finish, then review again.',attr:{role:'status'}});
  if(!updates.length)modal.contentEl.createEl('p',{text:'No selected configuration updates are pending.'});
  const selectedGroups=new Set(updates.map(u=>configurationGroup(u.file.path)));
  for(const group of [...selectedGroups]){
    const members=updates.filter(u=>configurationGroup(u.file.path)===group);
    new Setting(modal.contentEl).setName(group).setDesc(members.map(u=>`${u.file.deleted?'Delete':'Update'} ${u.file.path} (revision ${u.file.revision})${u.conflict?' — local content differs':''}`).join('\n')).addToggle(t=>t.setValue(true).onChange(value=>{if(value)selectedGroups.add(group);else selectedGroups.delete(group);}));
    if(members.some(u=>u.conflict))new Setting(modal.contentEl).setName('Resolve this group').addButton(b=>b.setButtonText('Keep local').onClick(async()=>{
      b.setDisabled(true);try{const result=await host.runConfiguration(()=>host.configuration!.keepLocal(members));if(result!==undefined){modal.close();new Notice('Local configuration published');await showConfigurationUpdates(host);}}finally{b.setDisabled(false);}
    })).addButton(b=>b.setButtonText('Use remote').onClick(async()=>{
      b.setDisabled(true);try{const count=await host.runConfiguration(()=>host.configuration!.apply(members));if(count!==undefined){modal.close();new Notice('Configuration applied. Reload Obsidian.');}}finally{b.setDisabled(false);}
    }));
  }
  const conflicts=host.configuration.local.state.conflicts;
  if(conflicts.length){
    modal.contentEl.createEl('h3',{text:'Preserved local copies'});
    for(const conflict of conflicts)new Setting(modal.contentEl).setName(conflict.path).setDesc(`Preserved before reviewing revision ${conflict.revision}`).addButton(b=>b.setButtonText('View conflict copy').onClick(()=>{
      const view=new Modal(host.app);view.setTitle(conflict.path);
      if(/\.(json|css)$/.test(conflict.path))view.contentEl.createEl('pre',{text:new TextDecoder().decode(decode(conflict.content))});
      else view.contentEl.createEl('p',{text:`Binary or plugin code preserved in the configuration recovery directory. SHA-256: ${conflict.hash}`});
      view.open();
    }));
  }
  const error=modal.contentEl.createEl('p',{cls:'mindsync-error',attr:{role:'alert'}});
  new Setting(modal.contentEl).addButton(b=>b.setButtonText('Not now').onClick(()=>modal.close())).addButton(b=>b.setButtonText('Apply selected').setCta().onClick(async()=>{
    const chosen=updates.filter(u=>selectedGroups.has(configurationGroup(u.file.path)));
    if(!chosen.length){error.setText('Select at least one update group.');return;}
    b.setDisabled(true);try{
      const count=await host.runConfiguration(()=>host.configuration!.apply(chosen));
      if(count!==undefined){modal.close();new Notice(`Applied ${count} configuration files. Reload Obsidian.`);}else error.setText(host.configurationStatus);
    }finally{b.setDisabled(false);}
  }));modal.open();
}
