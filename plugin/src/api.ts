import {Changes, Info, Operation, Remote, Result, Snapshot, SyncError} from './types';
export interface HttpReply { status: number; body: ArrayBuffer }
export type Http = (method: string, path: string, body?: string | Uint8Array) => Promise<HttpReply>;
export class Api implements Remote {
  constructor(private http: Http) {}
  private async request<T>(method: string, path: string, body?: unknown, binary = false): Promise<T> {
    const reply = await this.http(method, path, body instanceof Uint8Array ? body : body === undefined ? undefined : JSON.stringify(body));
    if (reply.status < 400 && binary) return new Uint8Array(reply.body) as T;
    const text = new TextDecoder().decode(reply.body);
    if (reply.status >= 400) {
      let error: {code?:string;message?:string;current?:Result['file']|null} = {};
      try { error = JSON.parse(text).error ?? {}; } catch { /* reverse proxies may return HTML */ }
      throw new SyncError(error.code ?? `HTTP_${reply.status}`, error.message ?? `服务器返回 ${reply.status}，请检查连接与配置`, error.current);
    }
    try { return JSON.parse(text) as T; } catch { throw new SyncError('INVALID_RESPONSE','服务器返回了无效数据'); }
  }
  info() { return this.request<Info>('GET','/v1/info'); }
  snapshot() { return this.request<Snapshot>('GET','/v1/snapshot'); }
  changes(after: number, until?: number) { return this.request<Changes>('GET',`/v1/changes?after=${after}&limit=100${until === undefined ? '' : `&until=${until}`}`); }
  async upload(hash: string, bytes: Uint8Array) { await this.request('PUT',`/v1/objects/${hash}`,bytes); }
  download(hash: string) { return this.request<Uint8Array>('GET',`/v1/objects/${hash}`,undefined,true); }
  apply(op: Operation) { return this.request<Result>('POST','/v1/operations',op); }
  async result(id: string) { try { return await this.request<Result>('GET',`/v1/operations/${encodeURIComponent(id)}`); } catch (e) { if (e instanceof SyncError && (e.code === 'NOT_FOUND' || e.code === 'HTTP_404')) return null; throw e; } }
  register(name: string) { return this.request<{id:string;name:string;token:string}>('POST','/v1/devices',{name}); }
  devices() { return this.request<{devices:{id:string;name:string}[]}>('GET','/v1/devices'); }
  revoke(id: string) { return this.request('DELETE',`/v1/devices/${encodeURIComponent(id)}`); }
  history(id: string) { return this.request<{versions:Result['file'][]}>('GET',`/v1/files/${encodeURIComponent(id)}/history`); }
}
