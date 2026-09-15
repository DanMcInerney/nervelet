import { Bridge, ObservationStore, Supervisor } from 'nervelet';
import { ApiDriver } from 'nervelet/drivers/api';
import type { Environment } from 'nervelet';

// The application owns ingestion. This example has no robot, camera or actuator fields.
const store=new ObservationStore();
const environment:Environment={
  profile:{id:'api-feed',version:'1',instructions:'queue is a count; reliable alerts are data.',commands:{},waitFields:{queue:{source:'sample',maxAgeMs:5000}}},
  changes:store.changes,start:async()=>{},close:async()=>{},snapshot:async n=>store.snapshot(n),
  acknowledge:n=>store.acknowledge(n),wait:s=>store.wait(s),
  execute:async c=>({id:c.id,status:'rejected',reason:'no_commands'}),cancel:async()=>({status:'confirmed'}),stop:async()=>({status:'confirmed'})
};
const required=(key:string)=>{const value=process.env[key];if(!value)throw new Error(`Set ${key} explicitly.`);return value;};
const bridge=new Bridge(environment,'Observe the feed. Wait for queue >= 5 or an alert. Report an alert, then stop.');
const driver=new ApiDriver({endpoint:required('NERVELET_ENDPOINT'),provider:required('NERVELET_PROVIDER'),model:required('NERVELET_MODEL'),
  ...(process.env.NERVELET_API_KEY?{headers:{Authorization:`Bearer ${process.env.NERVELET_API_KEY}`}}:{})});
const supervisor=new Supervisor(bridge,driver,{maxTurns:5,maxModelCalls:12});
let count=0;
const timer=setInterval(()=>{store.setSample('queue',{value:++count,receivedMs:performance.now(),valid:true});if(count===5)store.push('alert',{message:'Fixture queue reached five.'});},1000);
process.once('SIGINT',()=>{void supervisor.stop();});
try{await supervisor.run();}finally{clearInterval(timer);}
