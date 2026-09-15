// Arduino Uno R3 + TMP36 on A0. Requires ArduinoJson 7.
// Example protocol firmware; hardware behavior must be verified on the actual board.
#include <ArduinoJson.h>

char line[384];
size_t used = 0;
bool overflow = false;
bool led = false;
unsigned long lastSample = 0, lastHeartbeat = 0, seq = 0;

void setLed(bool on) { led = on; digitalWrite(LED_BUILTIN, on ? HIGH : LOW); }
void sample() {
  JsonDocument doc;
  doc["type"] = "sample";
  // A sequence reset is detected by the adapter and requires reconciliation.
  doc["clock"] = "board";
  doc["seq"] = ++seq;
  doc["atMs"] = millis();
  doc["valid"] = true;
  doc["state"]["ledOutput"] = led;
  doc["samples"]["temperatureC"] = (analogRead(A0) * (5.0 / 1023.0) - 0.5) * 100.0;
  serializeJson(doc, Serial); Serial.println();
}
void receive() {
  JsonDocument input;
  if (deserializeJson(input, line)) { setLed(false); return; }
  const char* type = input["type"] | "";
  if (!strcmp(type, "heartbeat")) { lastHeartbeat = millis(); return; }
  const char* id = input["id"] | "";
  if (!*id || strlen(id) > 80) { setLed(false); return; }
  JsonDocument result;
  result["id"] = id;
  if (!strcmp(type, "stop") || !strcmp(type, "cancel")) {
    setLed(false); result["type"] = "control"; result["ok"] = true;
  } else if (!strcmp(type, "command")) {
    result["type"] = "receipt";
    const char* kind = input["kind"] | "";
    if (!strcmp(kind, "set_led") && input["args"]["on"].is<bool>()) {
      setLed(input["args"]["on"].as<bool>()); result["status"] = "completed";
    } else if (!strcmp(kind, "sample")) {
      result["status"] = "completed";
    } else { result["status"] = "rejected"; result["reason"] = "unknown_command_or_arguments"; }
  } else { setLed(false); return; }
  serializeJson(result, Serial); Serial.println(); sample();
}
void setup() {
  pinMode(LED_BUILTIN, OUTPUT); setLed(false); Serial.begin(115200);
}
void loop() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n') {
      if (!overflow) { line[used] = 0; receive(); }
      else setLed(false);
      used = 0; overflow = false;
    } else if (c != '\r') {
      if (used < sizeof(line) - 1 && !overflow) line[used++] = c;
      else overflow = true;
    }
  }
  unsigned long at = millis();
  if (at - lastHeartbeat > 1500) setLed(false);
  if (at - lastSample >= 100) { lastSample = at; sample(); }
}
