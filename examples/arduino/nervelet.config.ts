import { defineConfig } from 'nervelet';
import { createSerialEnvironment } from 'nervelet/serial';

export default defineConfig({environment:()=>createSerialEnvironment({
  path:process.env.NERVELET_PORT ?? 'COM4', baudRate:115200, staleMs:2000,
  profile:{
    id:'arduino-bench',version:'1',
    instructions:'Arduino Uno R3, 5 V analog reference, TMP36 output on A0 and onboard LED on pin 13. temperatureC=(ADC*5/1023-0.5)*100. ledOutput is the output setting, not measured brightness. Serial packets every 100 ms. Device watchdog clears the LED after 1500 ms without a bridge heartbeat. Stop clears the LED.',
    commands:{
      set_led:{description:'Set the onboard LED output.',resource:'led',schema:{type:'object',properties:{on:{type:'boolean'}},required:['on'],additionalProperties:false}},
      sample:{description:'Request a fresh sensor packet.',schema:{type:'object',properties:{},additionalProperties:false}}
    }
  }
})});
