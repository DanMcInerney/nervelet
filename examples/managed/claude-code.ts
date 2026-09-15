import { Bridge, Supervisor } from 'nervelet';
import { createDemoEnvironment } from 'nervelet/demo';
import { ClaudeCodeDriver } from 'nervelet/drivers/claude-code';

// Explicit opt-in: this uses real native inference and the caller's authentication.
const model=process.env.NERVELET_MODEL;
if(!model)throw new Error('Set NERVELET_MODEL to the exact native Claude model to qualify.');
const bridge=new Bridge(createDemoEnvironment(),'Inspect the simulated temperature. Wait for review in one second, inspect again, then stop. No hardware is connected.');
const driver=new ClaudeCodeDriver({model,cwd:process.cwd(),permissionMode:'default',settingSources:[],
  allowedTools:['mcp__nervelet__step','mcp__nervelet__describe','mcp__nervelet__cancel','mcp__nervelet__stop'],maxTurns:8,maxBudgetUsd:1});
const supervisor=new Supervisor(bridge,driver,{maxTurns:4,maxStepsPerTurn:12,turnMs:90000});
process.once('SIGINT',()=>{void supervisor.stop();});
await supervisor.run();
