// Synthetic browser inputs only. These checks never enable a deployment.
import { expect, test } from 'bun:test';
import { calculate } from '../src/engine';
import { signBatch } from '../src/crypto';
import { environment, NOW } from './helpers';
// @ts-expect-error The browser module is plain JavaScript.
import { validateModeSnapshot } from '../public/assets/index.js';

function snapshot(scoped = true, onlyB200 = true) {
  const e=environment(),at=Date.now();
  e.methodology.effectiveAt=at-10000;
  if(scoped)e.methodology.publicationScope={kind:'MODEL',model:'B200',approvalEvidence:'Isolated browser fixture'};
  if(onlyB200)for(const model of ['B300','GB200','GB300'] as const)e.methodology.providerWeights[model]={};
  const batches=e.batches.map((batch,i)=>signBatch({...batch.payload,createdAt:at,
    observations:batch.payload.observations.filter(o=>!onlyB200||o.model==='B200').map(o=>({...o,observedAt:o.observedAt+at-NOW}))},e.identities[i]!));
  return calculate(batches,e.registry,e.methodology,at);
}

test('Real mode accepts approved B200 without an available composite',()=>{
  const value=snapshot();
  expect(value.feeds.find(f=>f.id==='SBX')!.status).toBe('UNAVAILABLE');
  expect(validateModeSnapshot(value,'real')).toBe(value);
});

test('scoped validation accepts other calculated feeds without granting them publication scope',()=>{
  const value=snapshot(true,false);
  expect(value.feeds.filter(f=>f.kind==='MODEL'&&f.status==='READY')).toHaveLength(4);
  expect(validateModeSnapshot(value,'real').publicationScope).toEqual({kind:'MODEL',model:'B200'});
});

test('legacy all-four Real mode remains valid and incomplete legacy snapshots fail',()=>{
  const value=snapshot(false,false);
  expect(validateModeSnapshot(value,'real')).toBe(value);
  const incomplete=snapshot();delete incomplete.publicationScope;
  expect(()=>validateModeSnapshot(incomplete,'real')).toThrow('Incomplete publishable snapshot');
});

test.each([null,{},[],{kind:'MODEL',model:'B300'},{kind:'MODEL',model:'B200',extra:true}].map(scope=>[scope]))('malformed scope fails closed: %j',scope=>{
  expect(()=>validateModeSnapshot({...snapshot(),publicationScope:scope},'real')).toThrow('Invalid publication scope');
});

test('unavailable, missing, duplicated or provider-disguised scoped B200 cannot display a real price',()=>{
  for(const change of ['unavailable','missing','duplicate','provider']) {
    const value=snapshot(),feed=value.feeds.find(f=>f.id==='SBX:B200')!;
    if(change==='unavailable'){feed.status='UNAVAILABLE';feed.price=null;feed.observedAt=null;}
    if(change==='missing')value.feeds=value.feeds.filter(f=>f!==feed);
    if(change==='duplicate')value.feeds.push(structuredClone(feed));
    if(change==='provider')feed.provider='alpha';
    expect(()=>validateModeSnapshot(value,'real')).toThrow();
  }
});

test('unapproved and stale scoped snapshots never use demo values as fallback',()=>{
  const value=snapshot();
  expect(()=>validateModeSnapshot({...value,publishable:false},'real')).toThrow('Real prices are not yet available');
  expect(()=>validateModeSnapshot({...value,calculatedAt:Date.now()-120001},'real')).toThrow('Snapshot is stale');
  expect(()=>validateModeSnapshot({...value,mode:'CENTRALIZED_DEMO',publishable:false,pythPublished:false},'demo')).toThrow('Invalid demo response');
});
