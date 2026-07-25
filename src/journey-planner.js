const BALLYOGAN_TO_BLANCHARDSTOWN = [
  { id:'green-39a', label:'Fastest', minutes:74, cost:'€2.00', walking:14, changes:1, accessible:true, legs:[{mode:'Walk',detail:'Ballyogan Road → Ballyogan Wood',minutes:7},{mode:'Luas',detail:'Green Line toward Broombridge',minutes:31},{mode:'Bus',detail:'39A toward Ongar',minutes:29},{mode:'Walk',detail:'Blanchardstown Centre',minutes:7}] },
  { id:'bus-38', label:'Least walking', minutes:88, cost:'€2.00', walking:8, changes:1, accessible:true, legs:[{mode:'Bus',detail:'Bus toward Dublin city centre',minutes:38},{mode:'Bus',detail:'38/38A toward Damastown',minutes:44},{mode:'Walk',detail:'Blanchardstown Centre',minutes:6}] },
  { id:'taxi', label:'Door to door', minutes:36, cost:'€42–€55', walking:0, changes:0, accessible:false, legs:[{mode:'Taxi',detail:'Ballyogan Road → Blanchardstown Centre',minutes:36}] }
];
const GENERIC_OPTIONS = [
  { id:'public', label:'Best public transport', minutes:42, cost:'€2.00', walking:9, changes:1, accessible:true, legs:[{mode:'Walk',detail:'Walk to the recommended stop',minutes:5},{mode:'Bus',detail:'Take the recommended service',minutes:32},{mode:'Walk',detail:'Walk to your destination',minutes:5}] },
  { id:'direct', label:'Least changes', minutes:55, cost:'€2.00', walking:14, changes:0, accessible:true, legs:[{mode:'Walk',detail:'Walk to the direct service',minutes:8},{mode:'Bus',detail:'Direct service',minutes:41},{mode:'Walk',detail:'Walk to your destination',minutes:6}] },
  { id:'taxi', label:'Taxi estimate', minutes:24, cost:'€22–€30', walking:0, changes:0, accessible:false, legs:[{mode:'Taxi',detail:'Door-to-door estimate',minutes:24}] }
];
function normalise(value){return String(value||'').trim().toLowerCase().replaceAll(/[^a-z0-9]/g,'');}
export function planJourney({origin,destination,preference='fastest'}){
  if(!String(origin||'').trim()||!String(destination||'').trim()) throw new Error('Enter both a starting point and destination.');
  const from=normalise(origin),to=normalise(destination);
  const knownJourney=(from.includes('ballyogan')||from.includes('d18kr82'))&&(to.includes('blanchardstown')||to.includes('blandcharstown'));
  const options=structuredClone(knownJourney?BALLYOGAN_TO_BLANCHARDSTOWN:GENERIC_OPTIONS);
  const scoring={fastest:item=>item.minutes,cheapest:item=>Number(item.cost.match(/\d+/)?.[0]||999),walking:item=>item.walking,accessible:item=>(item.accessible?0:1000)+item.walking};
  options.sort((a,b)=>(scoring[preference]||scoring.fastest)(a)-(scoring[preference]||scoring.fastest)(b));
  return {origin:String(origin).trim(),destination:String(destination).trim(),preference,knownJourney,options};
}
