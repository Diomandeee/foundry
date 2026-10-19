import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Miniflare } from 'miniflare';
import { localRuntime } from './runtime.js';
import { authorityFixture } from './authority-fixture.js';

export const owner = {principal:'local-operator', role:'owner'};
export const submitter = {principal:'project-a', role:'submitter'};
export const projector = {principal:'read-projector', role:'projector'};
export const verifier = {principal:'byte-verifier', role:'verifier'};
export const executor = (id='worker-a') => ({principal:`principal-${id}`,role:'executor'});
export type Row = Record<string, any>;

/** Only this test-created directory is removed; production/session paths are excluded. */
export class TestClient {
  private runtime?: Miniflare;
  private serial=0;
  private constructor(readonly directory:string) {}
  static async create() {
    const client=new TestClient(await mkdtemp(join(tmpdir(),'foundry-authority-local-')));
    await client.start();return client;
  }
  private async start() {this.runtime=await localRuntime(authorityFixture,this.directory);}
  async restart() {await this.runtime?.dispose();this.runtime=undefined;await this.start();}
  async dispose() {await this.runtime?.dispose();await rm(this.directory,{recursive:true,force:true});}
  async request(body:Row):Promise<Row> {
    const response=await this.runtime!.dispatchFetch('https://local.test/internal-fixture',{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),
    });
    return await response.json() as Row;
  }
  async dump(table:string,instance='local-authority'):Promise<Row[]> {return await this.request({action:'dump',table,instance}) as unknown as Row[];}
  async epoch(instance='local-authority') {return (await this.dump('authority_meta',instance))[0].epoch as number;}
  async command(actor:Row,operation:string,body:Row,key?:string,epoch?:number,instance='local-authority') {
    return this.request({actor:{...actor,expectedEpoch:epoch??await this.epoch(instance)},instance,command:{operation,body,key:key??`test-${++this.serial}`}});
  }
  async configure(value:Row) {return this.request({action:'configure',value});}
  async snapshot() {return this.request({action:'snapshot'});}
  async stageArtifact(bytes:Uint8Array) {return (await this.request({action:'stageArtifact',bytes:Array.from(bytes)})).reference as string;}
  async verify(actor:Row,request:Row) {return this.request({action:'verify',actor:{...actor,expectedEpoch:await this.epoch()},request});}
}
