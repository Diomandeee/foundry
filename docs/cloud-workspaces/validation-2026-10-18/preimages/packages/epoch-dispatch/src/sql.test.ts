import {DatabaseSync} from 'node:sqlite';
import {describe,it,expect} from 'vitest';
import {EpochPipeline} from './index';
import {options} from '../../../workers/epoch-pipeline/test-support/runtime';
function dbFixture(fn:(db:DatabaseSync,port:any)=>void){const db=new DatabaseSync(':memory:');const port={sql:{exec:(q:string,...b:any[])=>db.prepare(q).all(...b)},transactionSync(callback:()=>any){db.exec('BEGIN');try{const v=callback();db.exec('COMMIT');return v;}catch(e){db.exec('ROLLBACK');throw e;}}};try{fn(db,port);}finally{db.close();}}
describe('pipeline binding and journal SQL invariants',()=>{
 it('rejects replace/update/delete of immutable binding and retains it through reopen',()=>dbFixture((db,port)=>{
  new EpochPipeline(port,options as any);const before=db.prepare('SELECT * FROM epoch_pipeline_meta').all();
  for(const q of ["INSERT OR REPLACE INTO epoch_pipeline_meta VALUES(1,'changed')","UPDATE epoch_pipeline_meta SET binding='changed'","DELETE FROM epoch_pipeline_meta"])expect(()=>db.exec(q)).toThrow();
  expect(db.prepare('SELECT * FROM epoch_pipeline_meta').all()).toEqual(before);expect(()=>new EpochPipeline(port,options as any)).not.toThrow();
 }));
 it('rejects a partial namespace before creating any other core tables',()=>dbFixture((db,port)=>{
  db.exec('CREATE TABLE epoch_pipeline_plans(event_id TEXT PRIMARY KEY,frozen TEXT)');expect(()=>new EpochPipeline(port,options as any)).toThrow('PIPELINE_SCHEMA_INCOMPLETE');expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([{name:'epoch_pipeline_plans'}]);
 }));
 it('rejects unknown journal intents and owner recovery and preserves frozen plan identity',()=>dbFixture((db,port)=>{
  const pipeline=new EpochPipeline(port,options as any);expect(()=>db.exec("INSERT INTO epoch_pipeline_delivery(intent_id,code) VALUES('invented','SUBMITTED')")).toThrow('delivery intent binding');
  expect(()=>pipeline.recover({environment:'local',principal:'owner',role:'owner'},{intentId:'invented'})).toThrow('UNKNOWN_DELIVERY');
  db.exec("INSERT INTO epoch_pipeline_plans VALUES('event','{}')");for(const q of ["INSERT OR REPLACE INTO epoch_pipeline_plans VALUES('event','changed')","UPDATE epoch_pipeline_plans SET frozen='changed'","DELETE FROM epoch_pipeline_plans"])expect(()=>db.exec(q)).toThrow();
 }));
});
