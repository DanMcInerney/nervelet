import type { Bundle, StepOptions } from './types.ts';
import { bytes, fail } from './util.ts';
import type { Bridge } from './core.ts';

/** Model-visible text excludes pixels; media keeps its independent byte ceiling. */
export function observationText(bundle: Bundle): string {
  const {attachments,...rest}=bundle;
  return JSON.stringify({...rest,...(attachments ? {attachments:attachments.map(({data:_data,...metadata})=>metadata)} : {})});
}
export function textSize(text:string, options:StepOptions):number {
  const overhead=options.wrapperBytes ?? 0;
  if(!Number.isSafeInteger(overhead) || overhead<0)fail('invalid_config','Invalid wrapper byte reserve.');
  return (options.textEncoding==='tool-result' ? bytes({content:[{type:'text',text}]}) : Buffer.byteLength(text))+overhead;
}
/** Additive size of a fragment inside the JSON text string, excluding its quotes. */
export function fragmentSize(text:string,options:StepOptions):number {
  return options.textEncoding==='tool-result' ? bytes(text)-2 : Buffer.byteLength(text);
}
/** Verify a native submission's actual envelope, with encoded pixels budgeted separately. */
export function checkTransportInput(bridge:Bridge,bundle:Bundle,input:unknown):void {
  const textBytes=bytes(input)-(bundle.attachments ?? []).reduce((sum,i)=>sum+i.data.length,0);
  if(textBytes>(bundle.recovery?bridge.limits.maxRecoveryBytes:bridge.limits.maxBundleBytes))fail('capacity','Native input including its transport wrapper exceeds the text budget; reserve wrapperBytes during assembly.');
}
