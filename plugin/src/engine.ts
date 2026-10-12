import {decode, digest, encode, FileRecord, Info, Local, Operation, Remote, SyncError, SyncState, validatePath, pathKey} from './types';
export interface PlanItem { action: string; path: string }
export class SyncEngine {
  private running = false;
  private failedOperations = new Set<string>();
  private infoValue?: Info;
  private remotePaths: string[] = [];
  constructor(public state: SyncState, private local: Local, private remote: Remote, private device = 'device') {}
  get info(): Info | undefined { return this.infoValue; }
  private async save() { await this.local.save(structuredClone(this.state)); }
  async renamed(oldPath: string, path: string) {
    // Chains are flattened so an offline directory rename retains file identity.
    for (const key of Object.keys(this.state.renames)) if (this.state.renames[key] === oldPath) this.state.renames[key] = path;
    this.state.renames[oldPath] = path;
    const before=oldPath.split('/'), after=path.split('/');
    for (let i=0;i<Math.min(before.length,after.length)-1;i++) {
      const from=before.slice(0,i+1).join('/'), to=after.slice(0,i+1).join('/');
      if (from !== to && pathKey(from) === pathKey(to)) {
        const groups=this.state.renameGroups ??= {};
        if (!groups[from]) {
          const targets: Record<string,string>={};
          for (const file of Object.values(this.state.files)) if (!file.deleted && file.path.startsWith(from+'/')) targets[file.id]=to+file.path.slice(from.length);
          groups[from]={temporary:`MindSync Rename ${crypto.randomUUID()}`,targets};
        }
        break;
      }
    }
    await this.save();
  }
  private async checkInfo() {
    const info = await this.remote.info();
    if (info.protocol !== 1) throw new SyncError('PROTOCOL_MISMATCH', '服务器协议不兼容');
    if (this.state.vaultId && this.state.vaultId !== info.vault_id) throw new SyncError('VAULT_MISMATCH', '服务器属于另一份笔记库，请在新的本地库连接，避免混合数据');
    const high = Object.values(this.state.files).reduce((high,f) => Math.max(high,f.revision), Math.max(this.state.cursor, this.state.remoteHighWatermark ?? 0));
    if (this.state.vaultId && info.cursor < high) throw new SyncError('SERVER_ROLLBACK', '服务器已恢复较早的备份。请保留当前本地库，在新的本地库连接后再预览导入后续修改');
    this.state.remoteHighWatermark = Math.max(high, info.cursor);
    this.infoValue = info; return info;
  }
  async preview(): Promise<PlanItem[]> {
    await this.checkInfo(); const remote = await this.remote.snapshot(); const paths = await this.local.list();
    const plan: PlanItem[] = [];
    const byPath = new Map(remote.files.filter(f => !f.deleted).map(f => [f.path, f]));
    for (const path of paths) {
      validatePath(path); const bytes = await this.local.read(path); if (!bytes) continue;
      const file = byPath.get(path); const hash = await digest(bytes);
      if (!file) plan.push({action: '上传', path});
      else if (file.hash !== hash) {
        const base = this.state.files[file.id];
        plan.push({action: base?.revision === file.revision ? '上传修改' : '保留冲突副本并下载远端', path});
      }
      byPath.delete(path);
    }
    for (const f of byPath.values()) plan.push({action: this.state.initialized && this.state.files[f.id]?.revision === f.revision ? '上传删除' : '下载', path: f.path});
    for (const f of remote.files.filter(f => f.deleted)) {
      if (this.state.files[f.id] && paths.includes(this.state.files[f.id].path)) plan.push({action: '处理远端删除；保留本地未同步修改', path: f.path});
    }
    for (const c of this.state.pending) plan.push({action: '重试待同步操作', path: c.op.path ?? this.state.files[c.op.file_id]?.path ?? c.op.file_id});
    return plan;
  }
  async sync(allowInitialMerge = false): Promise<void> {
    if (this.running) return;
    this.running = true; this.failedOperations.clear();
    const errors: unknown[] = [];
    const attempt = async (work: () => Promise<void>) => { try { await work(); } catch (error) { errors.push(error); } };
    const applyFiles = async (files: FileRecord[], initial = false, force = false) => {
      let failed = false;
      this.remotePaths=files.filter(f=>!f.deleted).map(f=>f.path);
      // A snapshot is unordered: remove old identities before accepting a replacement at their path.
      for (const file of [...files].sort((a,b) => Number(b.deleted)-Number(a.deleted) || a.revision-b.revision)) {
        try { await this.accept(file, initial, force); } catch (error) { errors.push(error); failed = true; }
      }
      return !failed;
    };
    try {
      const info = await this.checkInfo();
      if (!this.state.initialized) {
        const snapshot = await this.remote.snapshot();
        if ((await this.local.list()).length && snapshot.files.some(f => !f.deleted) && !allowInitialMerge && !this.state.initialMergeApproved)
          throw new SyncError('INITIAL_MERGE_REQUIRED', '首次连接本地库和远端库都有文件，请预览后选择合并');
        this.state.vaultId = info.vault_id; this.state.initialMergeApproved=true; await this.save();
        if (!(await applyFiles(snapshot.files, true))) throw errors[0];
        this.state.initialized = true; delete this.state.initialMergeApproved; this.state.cursor = snapshot.cursor; await this.save();
      }
      await attempt(() => this.flush(errors));
      if (!this.state.rescanRemote) { await attempt(() => this.capture(errors)); await attempt(() => this.flush(errors)); }
      if (this.state.rescanRemote) {
        await attempt(async () => {
          const snapshot = await this.remote.snapshot();
          if (await applyFiles(snapshot.files, false, true)) {
            this.state.cursor = snapshot.cursor; this.state.rescanRemote = false; await this.save();
          }
        });
      } else {
        await attempt(async () => {
          let until: number | undefined;
          let nextCursor=this.state.cursor, blocked=false;
          while (true) {
            const page = await this.remote.changes(nextCursor, until); until = page.until;
            this.remotePaths=[...new Set([...this.remotePaths,...page.changes.filter(f=>!f.deleted).map(f=>f.path)])];
            // Change pages have a defined order, unlike snapshots.
            let failed = false;
            for (const file of page.changes) {
              try { await this.accept(file); } catch (error) { errors.push(error); failed = true; }
            }
            blocked ||= failed;
            if (!blocked) { this.state.cursor = page.cursor; await this.save(); }
            nextCursor=page.cursor;
            if (!page.has_more) break;
          }
        });
      }
      await attempt(() => this.capture(errors)); await attempt(() => this.flush(errors));
      if (errors.length) throw errors[0];
      this.state.lastSuccess = new Date().toISOString(); await this.save();
    } finally { this.running = false; }
  }
  async restore(fileId: string, version: FileRecord): Promise<void> {
    if (this.running) throw new SyncError('SYNC_BUSY', '同步进行中，请稍后恢复');
    this.running = true; this.failedOperations.clear();
    try {
      await this.checkInfo();
      const base = this.state.files[fileId];
      if (!base || version.id !== fileId || version.deleted) throw new SyncError('INVALID_VERSION', '无法恢复此历史版本');
      if (this.state.pending.some(c => c.op.file_id === fileId)) throw new SyncError('PENDING_OPERATION', '该文件还有待同步修改，请先同步后恢复');
      const bytes = await this.remote.download(version.hash);
      if (await digest(bytes) !== version.hash || bytes.length !== version.size) throw new SyncError('HASH_MISMATCH', '历史内容校验失败');
      const local = await this.local.read(base.path);
      if (local) await this.protect(base.path, local);
      const op: Operation = {operation_id: crypto.randomUUID(), kind: 'put', file_id: fileId, path: base.path, base_revision: base.revision, hash: version.hash, size: bytes.length};
      await this.queue(op, bytes, true);
      const errors: unknown[] = [];
      await this.flush(errors, op.operation_id);
      if (errors.length) throw errors[0];
    } finally { this.running = false; }
  }
  private async queue(op: Operation, bytes?: Uint8Array, restore = false) {
    if (bytes && this.infoValue && bytes.length > this.infoValue.max_file_bytes) throw new SyncError('FILE_TOO_LARGE', `附件超出服务器单文件上限：${op.path}`);
    this.state.pending.push({op, content: bytes ? encode(bytes) : undefined, ...(restore ? {restore:true} : {})}); await this.save();
  }
  private async capture(errors: unknown[]) {
    const paths = await this.local.list(); const present = new Set(paths); const handled = new Set<string>();
    const occupied = new Map<string, string>();
    for (const path of paths) {
      try { validatePath(path); } catch (error) { errors.push(error); handled.add(path); continue; }
      const components = path.split('/');
      for (let i = 1; i <= components.length; i++) {
        const prefix = components.slice(0,i).join('/'), key = pathKey(prefix);
        if (occupied.has(key) && occupied.get(key) !== prefix) { errors.push(new SyncError('PATH_CONFLICT', `文件名大小写冲突：${path}`)); handled.add(path); break; }
        occupied.set(key, prefix);
      }
    }
    const pendingIds = new Set(this.state.pending.map(c => c.op.file_id));
    const groupedIds=new Set<string>();
    for (const [source,group] of Object.entries(this.state.renameGroups ?? {})) {
      const ready=Object.entries(group.targets).every(([id,target]) => {
        const file=this.state.files[id]; return file?.deleted || file?.path===target || file?.path.startsWith(group.temporary+'/');
      });
      for (const [id,target] of Object.entries(group.targets)) {
        groupedIds.add(id); handled.add(this.state.files[id]?.path ?? target);
        const invalid=handled.has(target); handled.add(target);
        const file=this.state.files[id];
        if (!file || file.deleted || pendingIds.has(id) || invalid) continue;
        try {
          const actual=present.has(target) ? target : paths.find(p => pathKey(p)===pathKey(target));
          if (!actual) { await this.queue({operation_id:crypto.randomUUID(),kind:'delete',file_id:id,base_revision:file.revision}); continue; }
          const destination=ready ? target : `${group.temporary}/${target.split('/').slice(source.split('/').length).join('/')}`;
          if (!ready && file.path.startsWith(group.temporary+'/')) continue;
          const bytes=await this.local.read(actual); if (!bytes) continue;
          const hash=await digest(bytes);
          if (file.path!==destination || hash!==file.hash) await this.queue({operation_id:crypto.randomUUID(),kind:'put',file_id:id,path:destination,base_revision:file.revision,hash,size:bytes.length},bytes);
        } catch (error) { errors.push(error); }
      }
    }
    for (const f of Object.values(this.state.files).filter(f => !f.deleted && !groupedIds.has(f.id))) {
      try {
      if (handled.has(f.path)) continue;
      if (pendingIds.has(f.id)) { handled.add(f.path); const candidate = this.state.pending.find(c => c.op.file_id === f.id); if (candidate?.op.path) handled.add(candidate.op.path); continue; }
      let path = f.path;
      const target = this.state.renames[f.path];
      if (!present.has(path) && target && present.has(target)) path = target;
      else if (!present.has(path)) {
        const known = new Set(Object.values(this.state.files).filter(x => !x.deleted).map(x => x.path));
        const matches: string[] = [];
        for (const candidate of paths) if (!known.has(candidate) && !handled.has(candidate)) {
          const content = await this.local.read(candidate);
          if (content && await digest(content) === f.hash) matches.push(candidate);
        }
        if (matches.length === 1) path = matches[0];
      }
      if (!present.has(path)) {
        await this.queue({operation_id: crypto.randomUUID(), kind: 'delete', file_id: f.id, base_revision: f.revision}); continue;
      }
      handled.add(path); const bytes = await this.local.read(path); if (!bytes) continue;
      const hash = await digest(bytes);
      if (path !== f.path || hash !== f.hash) await this.queue({operation_id: crypto.randomUUID(), kind: 'put', file_id: f.id, path, base_revision: f.revision, hash, size: bytes.length}, bytes);
      } catch (error) { errors.push(error); handled.add(f.path); }
    }
    for (const c of this.state.pending) if (c.op.path) handled.add(c.op.path);
    for (const path of paths) if (!handled.has(path)) {
      try {
      const bytes = await this.local.read(path); if (!bytes) continue;
      await this.queue({operation_id: crypto.randomUUID(), kind: 'put', file_id: crypto.randomUUID(), path, base_revision: 0, hash: await digest(bytes), size: bytes.length}, bytes);
      } catch (error) { errors.push(error); }
    }
  }
  private async flush(errors: unknown[], strictOperationId?: string) {
    // A file error must not silently drop its candidate. Successful unrelated
    // entries are committed while the first retryable error is reported.
    for (const candidate of [...this.state.pending]) {
      if (this.failedOperations.has(candidate.op.operation_id)) continue;
      try {
        let result = await this.remote.result(candidate.op.operation_id);
        if (!result) {
          if (candidate.content !== undefined) await this.remote.upload(candidate.op.hash!, decode(candidate.content));
          result = await this.remote.apply(candidate.op);
        }
        this.state.remoteHighWatermark = Math.max(this.state.remoteHighWatermark ?? 0, result.cursor);
        if (candidate.restore) await this.accept(result.file, false, true);
        else this.state.files[result.file.id] = result.file;
        this.state.pending = this.state.pending.filter(c => c.op.operation_id !== candidate.op.operation_id);
        for (const [source,group] of Object.entries(this.state.renameGroups ?? {})) {
          if (Object.entries(group.targets).every(([id,target]) => this.state.files[id]?.deleted || this.state.files[id]?.path===target)) delete this.state.renameGroups![source];
        }
        if (candidate.op.path) {
          for (const from of Object.keys(this.state.renames)) if (this.state.renames[from] === candidate.op.path) delete this.state.renames[from];
        }
        // Do not advance the download cursor here: other clients' changes may precede this revision.
        await this.save();
      } catch (error) {
        if (error instanceof SyncError && ['REVISION_CONFLICT', 'PATH_CONFLICT'].includes(error.code)) {
          if (error.code==='PATH_CONFLICT' && Object.values(this.state.renameGroups ?? {}).some(g => g.targets[candidate.op.file_id])) {
            this.failedOperations.add(candidate.op.operation_id); errors.push(error); continue;
          }
          if (!candidate.restore && candidate.content !== undefined && candidate.op.path) {
            try { await this.protect(candidate.op.path, decode(candidate.content)); } catch (protectionError) { errors.push(protectionError); continue; }
          }
          this.state.rescanRemote = true;
          this.state.pending = this.state.pending.filter(c => c.op.operation_id !== candidate.op.operation_id);
          await this.save();
          if (candidate.op.operation_id === strictOperationId || candidate.restore) errors.push(error);
        } else { this.failedOperations.add(candidate.op.operation_id); errors.push(error); }
      }
    }
  }
  private async protect(path: string, bytes: Uint8Array) {
    const hash = await digest(bytes); const slash = path.lastIndexOf('/'); const dot = path.lastIndexOf('.');
    const split = dot > slash ? dot : path.length;
    const tag = this.device.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 12) || 'device';
    const paths=[...this.remotePaths,...await this.local.list(),...Object.values(this.state.files).filter(f=>!f.deleted).map(f=>f.path)];
    let root='MindSync Conflicts';
    for (let i=1;;i++) {
      const candidate=i===1 ? 'MindSync Conflicts' : `MindSync Conflicts ${i}`;
      if (paths.some(p=>pathKey(p)===pathKey(candidate))) continue;
      root=paths.find(p=>pathKey(p.split('/')[0])===pathKey(candidate))?.split('/')[0] ?? candidate; break;
    }
    const trim=(value:string,budget:number) => { let result=''; for (const character of value) { if (new TextEncoder().encode(result+character).length>budget) break; result+=character; } return result; };
    const extension=trim(path.slice(split),60);
    const sourceTag = (await digest(new TextEncoder().encode(path))).slice(0,8);
    const conflictPath=(suffix:string) => `${root}/${trim(path.slice(slash+1,split),255-new TextEncoder().encode(suffix+extension).length)}${suffix}${extension}`;
    let conflict = conflictPath(`.conflict-${tag}-${sourceTag}-${hash.slice(0, 12)}`);
    const existing = await this.local.read(conflict);
    if (existing && await digest(existing) !== hash) conflict = conflictPath(`.conflict-${crypto.randomUUID()}`);
    if (!(await this.local.read(conflict))) await this.local.create(conflict, bytes);
    if (!this.state.conflicts.includes(conflict)) this.state.conflicts.push(conflict);
    (this.state.conflictDetails ??= {})[conflict] ??= {source:path, device:this.device, time:new Date().toISOString()};
    const tracked = Object.values(this.state.files).find(f => !f.deleted && f.path === conflict && f.hash === hash);
    if (!tracked && !this.state.pending.some(c => c.op.path === conflict && c.op.hash === hash))
      await this.queue({operation_id: crypto.randomUUID(), kind: 'put', file_id: crypto.randomUUID(), path: conflict, base_revision: 0, hash, size: bytes.length}, bytes);
    await this.save();
  }
  private async accept(file: FileRecord, initial = false, force = false) {
    validatePath(file.path);
    const incoming=file;
    const group=Object.values(this.state.renameGroups ?? {}).find(g => g.targets[file.id]);
    const storedBase=this.state.files[file.id];
    const base=storedBase && group ? {...storedBase,path:group.targets[file.id]} : storedBase;
    if (group) file={...file,path:group.targets[file.id]};
    if (base && (file.revision < base.revision || (file.revision === base.revision && !initial && !force))) return;
    // On initial import a tombstone cannot imply deletion of unrelated local content.
    if (file.deleted && (!base || base.deleted)) { this.state.files[file.id] = incoming; await this.save(); return; }
    const owner = Object.values(this.state.files).find(f => !f.deleted && f.id !== file.id && pathKey(f.path) === pathKey(file.path) && f.revision > (base?.revision ?? 0));
    if (file.deleted && owner) { this.state.files[file.id] = incoming; await this.save(); return; }
    let bytes: Uint8Array | null = null;
    if (!file.deleted) {
      bytes = await this.remote.download(file.hash);
      if (await digest(bytes) !== file.hash || bytes.length !== file.size) throw new SyncError('HASH_MISMATCH', `远端内容校验失败：${file.path}`);
    }
    if (base && base.path !== file.path && !base.deleted) {
      const old = await this.local.read(base.path);
      if (old) {
        const hash = await digest(old); if (hash !== base.hash) await this.protect(base.path, old);
        if (!(await this.local.replace(base.path, null, hash))) throw new SyncError('LOCAL_CHANGED', '本地文件正在修改，稍后重试');
      }
    }
    const local = await this.local.read(file.path); const localHash = local ? await digest(local) : null;
    if (local && localHash !== (base?.hash ?? file.hash) && localHash !== file.hash) await this.protect(file.path, local);
    if (file.deleted && local && localHash !== base?.hash) await this.protect(file.path, local);
    if (file.deleted) {
      if (local && !(await this.local.replace(file.path, null, localHash))) throw new SyncError('LOCAL_CHANGED', '删除前文件发生修改，稍后重试');
    } else if (localHash !== file.hash) {
      if (!(await this.local.replace(file.path, bytes, localHash))) throw new SyncError('LOCAL_CHANGED', '下载期间文件发生修改，已保留待下一次同步');
    }
    // A local deletion concurrent with a remote edit recreates the remote version.
    this.state.files[file.id] = incoming;
    if (initial) this.state.vaultId ??= this.infoValue?.vault_id;
    await this.save();
  }
}
