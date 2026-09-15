import { Bridge, Supervisor } from 'nervelet';
import { createDemoEnvironment } from 'nervelet/demo';
import { CodexDriver, connectAppServer } from 'nervelet/drivers/codex';

// Explicit process launch; embedded hosts pass their existing initialized client instead.
const model=process.env.NERVELET_MODEL,command=process.env.NERVELET_CODEX_EXECUTABLE;
if(!model||!command)throw new Error('Set NERVELET_MODEL and NERVELET_CODEX_EXECUTABLE explicitly.');
const client=await connectAppServer({command});
const bridge=new Bridge(createDemoEnvironment(),'Inspect the simulated bench, wait for review in one second, inspect again, then stop.');
const driver=new CodexDriver({client,clientOwnership:'owned',model,cwd:process.cwd(),approvalPolicy:'never',sandbox:'read-only'});
const supervisor=new Supervisor(bridge,driver,{maxTurns:4,maxStepsPerTurn:12,turnMs:90000});
process.once('SIGINT',()=>{void supervisor.stop();});
await supervisor.run();
