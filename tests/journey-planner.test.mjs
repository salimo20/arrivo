import test from 'node:test';
import assert from 'node:assert/strict';
import { planJourney, selectJourney } from '../src/journey-planner.js';
test('returns multimodal options for Ballyogan to Blanchardstown',()=>{const result=planJourney({origin:'D18 KR82, Ballyogan Road',destination:'Blanchardstown Shopping Centre'});assert.equal(result.knownJourney,true);assert.equal(result.options.length,3);assert.ok(result.options.some(option=>option.legs.some(leg=>leg.mode==='Luas')));});
test('supports common destination spelling variation',()=>{assert.equal(planJourney({origin:'Ballyogan Road',destination:'Blandcharstown shopping center'}).knownJourney,true);});
test('least-walking ranks by walking minutes',()=>{assert.equal(planJourney({origin:'Dundrum',destination:'Heuston Station',preference:'walking'}).options[0].walking,0);});
test('accessible preference places accessible first',()=>{assert.equal(planJourney({origin:'Dublin Airport',destination:'UCD',preference:'accessible'}).options[0].accessible,true);});
test('requires both endpoints',()=>{assert.throws(()=>planJourney({origin:'',destination:'UCD'}),/starting point/i);});
test('labels controlled and illustrative journey quality',()=>{
  assert.equal(planJourney({origin:'Ballyogan Road',destination:'Blanchardstown Centre'}).dataQuality,'controlled-scenario');
  assert.equal(planJourney({origin:'Dundrum',destination:'Heuston Station'}).dataQuality,'illustrative');
});
test('builds a timed itinerary from a selected option',()=>{
  const journey=planJourney({origin:'Ballyogan Road',destination:'Blanchardstown Centre'});
  const itinerary=selectJourney(journey,'green-39a');
  assert.equal(itinerary.option.legs[0].startsAfter,0);
  assert.equal(itinerary.option.legs.at(-1).endsAfter,itinerary.option.minutes);
});
test('rejects an unknown journey option',()=>{
  const journey=planJourney({origin:'Dundrum',destination:'Heuston Station'});
  assert.throws(()=>selectJourney(journey,'missing'),/valid journey/i);
});
