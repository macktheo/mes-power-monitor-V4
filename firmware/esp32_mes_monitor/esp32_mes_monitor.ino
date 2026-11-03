/*
  MES Power Monitor - Firmware ESP32 (MQTT real-time)
  ====================================================
  Alur: PZEM-004T -> ESP32 -> Broker MQTT -> Dashboard (WebSocket)

  Fitur Perubahan:
    - Memperbaiki deklarasi variabel MQTT_RETRY_MS pada netTask().
    - Saat menerima perintah RESET dalam kondisi FAULT (dari MQTT/Dashboard maupun Serial), 
      status mesin akan LANGSUNG berpindah ke RUNNING (relay langsung ON).
*/

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <PZEM004Tv30.h>
#include "secrets.h"

// Nilai bawaan jika secrets.h Anda belum memuat baris ini
#ifndef MQTT_USE_TLS
#define MQTT_USE_TLS 0          // 0 = TCP biasa (broker lokal), 1 = TLS (broker cloud)
#endif
#ifndef USE_INSECURE_TLS
#define USE_INSECURE_TLS 1      // hanya berlaku jika MQTT_USE_TLS 1
#endif

// ===================== PIN =====================
#define PZEM_RX_PIN 16
#define PZEM_TX_PIN 17
const int  relayPin = 26;
const bool RELAY_ACTIVE_HIGH = true;   // ubah ke false jika modul relay aktif-LOW

// ===================== TOPIK =====================
#define TOPIC_TELEMETRY "mes/power/telemetry"
#define TOPIC_STATUS    "mes/power/status"
#define TOPIC_EVENT     "mes/power/event"
#define TOPIC_COMMAND   "mes/power/command"

// ===================== PROTEKSI =====================
const float WARN_POWER_W       = 250.0;  // peringatan (toast di dashboard)
const float WARN_CURRENT_A     = 1.0;    // peringatan arus (toast di dashboard)
const float TRIP_POWER_W       = 310.0;  // trip Overpower
const float TRIP_CURRENT_A     = 1.5;    // trip Overcurrent
const int   TRIP_CONFIRM_READS = 1;      // pembacaan beruntun sebelum trip (1 = langsung)
const int   SENSOR_FAIL_LIMIT  = 10;     // pembacaan PZEM gagal beruntun -> trip (10 x 0,5 dtk = 5 dtk)

// ===================== INTERVAL =====================
const unsigned long SENSOR_INTERVAL_MS  = 500;
const unsigned long HEARTBEAT_MS        = 1000;   // publish minimal tiap ini walau tidak ada sampel baru
const unsigned long WIFI_RETRY_MS       = 20000;  
const unsigned long MQTT_RETRY_MS       = 3000;
const unsigned long OFFLINE_FAILSAFE_MS = 0;      // 0 = nonaktif
const unsigned long RUN_AFTER_RESET_BLOCK_MS = 1500;

// ===================== KLIEN MQTT =====================
#if MQTT_USE_TLS
WiFiClientSecure netClient;
#else
WiFiClient netClient;
#endif
PubSubClient mqtt(netClient);

// ===================== STATE =====================
enum StatusMesin { STOPPED, RUNNING, FAULT };
volatile StatusMesin statusSaatIni = STOPPED;

PZEM004Tv30 pzem(Serial2, PZEM_RX_PIN, PZEM_TX_PIN);

struct Snapshot {
  uint32_t seq;           // nomor sampel (sama di Serial & dashboard)
  float v, i, p, e;
  bool valid;
  StatusMesin st;
  bool hasEvent;
  bool evTrip;
  char event[100];
};
Snapshot snap = {0, 0, 0, 0, 0, false, STOPPED, false, false, ""};
portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;

volatile bool sendNow = false;            // minta netTask publish segera
volatile int  pendingRelay = 0;           // 0 = tidak ada, 1 = RUN, 2 = STOP
volatile bool pendingReset = false;
volatile unsigned long cmdRxMs = 0;       // waktu perintah terakhir diterima
volatile unsigned long lastBrokerOkMs = 0;
volatile bool mqttOk = false;             // status koneksi MQTT

unsigned long lastSensorMs = 0;
unsigned long lastResetMs = 0;
uint32_t sensorSeq = 0;
int   sensorFail = 0;
int   tripCount = 0;
float lastEnergy = 0;

const char* namaStatus(StatusMesin s) {
  switch (s) {
    case STOPPED: return "STOPPED";
    case RUNNING: return "RUNNING";
    case FAULT:   return "FAULT";
  }
  return "UNKNOWN";
}

void setRelay(bool on) {
  digitalWrite(relayPin, (on == RELAY_ACTIVE_HIGH) ? HIGH : LOW);
}

// Hanya dipanggil dari loop() (core 1). Status berubah -> publish segera ke dashboard.
void ubahStatus(StatusMesin baru, const char* pemicu) {
  if (statusSaatIni == baru) return;
  statusSaatIni = baru;
  setRelay(baru == RUNNING);   // RUNNING -> relay ON, STOPPED & FAULT -> relay OFF

  portENTER_CRITICAL(&mux);
  snap.st = baru;
  snap.hasEvent = true;
  snap.evTrip = (baru == FAULT);
  strncpy(snap.event, pemicu, sizeof(snap.event) - 1);
  snap.event[sizeof(snap.event) - 1] = '\0';
  portEXIT_CRITICAL(&mux);
  sendNow = true;

  Serial.printf("\n[%lus] >>> STATUS: %s | %s\n\n", millis() / 1000, namaStatus(baru), pemicu);
}

// =================================================================
// SENSOR + PROTEKSI (core 1)
// =================================================================
void bacaSensorDanProteksi() {
  sensorSeq++;
  float v = pzem.voltage();
  float i = pzem.current();
  float p = pzem.power();
  float e = pzem.energy();

  if (isnan(v) || isnan(i) || isnan(p)) {
    sensorFail++;
    Serial.printf("[%lus] #%lu [%s] PZEM gagal baca (%d/%d)\n",
                  millis() / 1000, (unsigned long)sensorSeq, namaStatus(statusSaatIni), sensorFail, SENSOR_FAIL_LIMIT);
    portENTER_CRITICAL(&mux);
    snap.seq = sensorSeq;
    snap.valid = false;
    portEXIT_CRITICAL(&mux);
    sendNow = true;
    if (statusSaatIni == RUNNING && sensorFail >= SENSOR_FAIL_LIMIT) {
      ubahStatus(FAULT, "Sensor PZEM tidak terbaca. Memutus sumber listrik.");
    }
    return;
  }
  sensorFail = 0;
  if (!isnan(e)) lastEnergy = e;

  portENTER_CRITICAL(&mux);
  snap.seq = sensorSeq;
  snap.v = v; snap.i = i; snap.p = p; snap.e = lastEnergy; snap.valid = true;
  portEXIT_CRITICAL(&mux);
  sendNow = true;

  Serial.printf("[%lus] #%lu [%s] V: %.1f | I: %.3f A | P: %.1f W | E: %.3f kWh | MQTT:%s\n",
                millis() / 1000, (unsigned long)sensorSeq, namaStatus(statusSaatIni),
                v, i, p, lastEnergy, mqttOk ? "OK" : "--");

  if (statusSaatIni == RUNNING) {
    bool overP = p > TRIP_POWER_W;
    bool overI = i > TRIP_CURRENT_A;
    if (overP || overI) {
      if (++tripCount >= TRIP_CONFIRM_READS) {
        char msg[100];
        if (overP) snprintf(msg, sizeof(msg), "Overpower! %.1f W > %.0f W. Memutus sumber listrik.", p, TRIP_POWER_W);
        else       snprintf(msg, sizeof(msg), "Overcurrent! %.2f A > %.1f A. Memutus sumber listrik.", i, TRIP_CURRENT_A);
        ubahStatus(FAULT, msg);
        tripCount = 0;
      }
    } else {
      tripCount = 0;
      if (p >= WARN_POWER_W) Serial.println("      >>> [WARNING] Daya beban tinggi, mendekati batas trip <<<");
      if (i >= WARN_CURRENT_A) Serial.println("      >>> [WARNING] Arus beban tinggi, mendekati batas trip <<<");
    }
  }
}

// =================================================================
// PERINTAH (core 1) - dieksekusi segera setelah diterima netTask
// =================================================================
void prosesPerintah() {
  if (pendingReset) {
    pendingReset = false;
    Serial.printf("[CMD] RESET diproses (+%lu ms sejak diterima)\n", millis() - cmdRxMs);
    if (statusSaatIni == FAULT) {
      ubahStatus(RUNNING, "Reset FAULT dikonfirmasi dari dashboard. Mesin RUNNING.");
      lastResetMs = millis();
    } else {
      Serial.println("[CMD] RESET diabaikan: mesin tidak dalam status FAULT.");
    }
  }

  int c = pendingRelay;
  if (c != 0) {
    pendingRelay = 0;
    Serial.printf("[CMD] %s diproses (+%lu ms sejak diterima)\n", c == 1 ? "RUN" : "STOP", millis() - cmdRxMs);
    if (c == 1) {
      if (lastResetMs != 0 && millis() - lastResetMs < RUN_AFTER_RESET_BLOCK_MS) {
        Serial.println("[CMD] RUN diabaikan: terlalu dekat dengan RESET.");
      } else if (statusSaatIni == STOPPED) {
        ubahStatus(RUNNING, "Perintah dashboard: RUN");
      } else if (statusSaatIni == FAULT) {
        Serial.println("[CMD] RUN ditolak: status FAULT. Reset FAULT dulu.");
      } else {
        Serial.println("[CMD] RUN diabaikan: mesin sudah RUNNING.");
      }
    } else {
      if (statusSaatIni == RUNNING) ubahStatus(STOPPED, "Perintah dashboard: STOP");
      else Serial.println("[CMD] STOP diabaikan: mesin tidak sedang RUNNING.");
    }
  }

  if (OFFLINE_FAILSAFE_MS > 0 && statusSaatIni == RUNNING &&
      millis() - lastBrokerOkMs > OFFLINE_FAILSAFE_MS) {
    ubahStatus(STOPPED, "Fail-safe: broker MQTT terputus terlalu lama.");
  }
}

void prosesSerial() {
  if (Serial.available() <= 0) return;
  String cmd = Serial.readStringUntil('\n');
  cmd.trim();
  cmd.toLowerCase();
  if (cmd == "nyalakan") {
    if (statusSaatIni == STOPPED) ubahStatus(RUNNING, "Perintah Serial: RUN");
    else Serial.println("[CMD] Tidak bisa RUN dari status ini.");
  } else if (cmd == "matikan") {
    if (statusSaatIni == RUNNING) ubahStatus(STOPPED, "Perintah Serial: STOP");
  } else if (cmd == "reset") {
    if (statusSaatIni == FAULT) {
      ubahStatus(RUNNING, "Reset FAULT via Serial (akses fisik). Mesin RUNNING.");
      lastResetMs = millis();
    }
  }
}

// =================================================================
// MQTT (core 0)
// =================================================================
void onMqttMessage(char* topic, byte* payload, unsigned int len) {
  if (strcmp(topic, TOPIC_COMMAND) != 0) return;
  JsonDocument doc;
  if (deserializeJson(doc, payload, len)) return;
  const char* cmd = doc["cmd"] | "";
  cmdRxMs = millis();
  Serial.printf("[MQTT] perintah diterima dari dashboard: %s\n", cmd);
  if      (strcmp(cmd, "RUN")   == 0) pendingRelay = 1;
  else if (strcmp(cmd, "STOP")  == 0) pendingRelay = 2;
  else if (strcmp(cmd, "RESET") == 0) pendingReset = true;
}

bool mqttConnect() {
  String cid = String("mes-esp32-") + String((uint32_t)ESP.getEfuseMac(), HEX);
  bool ok = mqtt.connect(cid.c_str(), MQTT_USER, MQTT_PASS, TOPIC_STATUS, 1, true, "offline");
  if (ok) {
    netClient.setNoDelay(true);
    mqtt.publish(TOPIC_STATUS, "online", true);
    mqtt.subscribe(TOPIC_COMMAND, 1);
    sendNow = true;
  }
  return ok;
}

void publishTelemetry() {
  Snapshot s;
  portENTER_CRITICAL(&mux);
  s = snap;
  portEXIT_CRITICAL(&mux);

  JsonDocument doc;
  doc["seq"]      = s.seq;
  doc["status"]   = namaStatus(s.st);
  doc["sensorOk"] = s.valid;
  if (s.valid) {
    doc["voltage"] = s.v;
    doc["current"] = s.i;
    doc["power"]   = s.p;
    doc["energy"]  = s.e;
  }
  String body;
  serializeJson(doc, body);
  mqtt.publish(TOPIC_TELEMETRY, body.c_str());

  if (s.hasEvent) {
    JsonDocument ev;
    ev["type"]   = s.evTrip ? "TRIP" : "DEVICE";
    ev["detail"] = s.event;
    String eb;
    serializeJson(ev, eb);
    if (mqtt.publish(TOPIC_EVENT, eb.c_str())) {
      portENTER_CRITICAL(&mux);
      if (snap.hasEvent && strcmp(snap.event, s.event) == 0) snap.hasEvent = false;
      portEXIT_CRITICAL(&mux);
    }
  }
}

const char* wifiStatusText(wl_status_t st) {
  if (st == WL_CONNECTED)       return "terhubung";
  if (st == WL_NO_SSID_AVAIL)   return "SSID TIDAK DITEMUKAN (nama salah / WiFi 5 GHz / terlalu jauh)";
  if (st == WL_CONNECT_FAILED)  return "GAGAL (password salah / ditolak router)";
  if (st == WL_CONNECTION_LOST) return "koneksi hilang";
  if (st == WL_DISCONNECTED)    return "terputus / belum tersambung";
  if (st == WL_IDLE_STATUS)     return "sedang mencoba menyambung";
  return "status lain";
}

void scanWifi() {
  Serial.println("[NET] Memindai WiFi sekitar (ESP32 hanya melihat 2.4 GHz)...");
  int n = WiFi.scanNetworks();
  bool found = false;
  for (int k = 0; k < n; k++) {
    bool match = (WiFi.SSID(k) == WIFI_SSID);
    if (match) found = true;
    Serial.printf("   %s %-32s ch%-2d %4d dBm\n", match ? "->" : "  ", WiFi.SSID(k).c_str(), (int)WiFi.channel(k), (int)WiFi.RSSI(k));
  }
  if (n <= 0)      Serial.println("   (tidak ada jaringan terdeteksi)");
  else if (!found) Serial.printf("   SSID \"%s\" TIDAK ADA di daftar: cek ejaan/huruf besar-kecil di secrets.h, dan pastikan 2.4 GHz.\n", WIFI_SSID);
  else             Serial.println("   SSID ditemukan -> kemungkinan besar PASSWORD salah (atau router menolak perangkat ini).");
  WiFi.scanDelete();
}

void netTask(void* param) {
  unsigned long lastPub = 0, lastWifiTry = millis(), lastMqttTry = 0;
  bool firstMqttTry = true;
  bool wasConnected = false;
  bool wifiWasUp = (WiFi.status() == WL_CONNECTED);

  for (;;) {
    if (WiFi.status() != WL_CONNECTED) {
      mqttOk = false;
      wifiWasUp = false;
      if (millis() - lastWifiTry > WIFI_RETRY_MS) {
        lastWifiTry = millis();
        Serial.printf("[NET] WiFi belum tersambung: %s. Mencoba ulang...\n", wifiStatusText(WiFi.status()));
        WiFi.disconnect();
        WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
      }
      vTaskDelay(pdMS_TO_TICKS(500));
      continue;
    }
    if (!wifiWasUp) {
      wifiWasUp = true;
      Serial.printf("[NET] WiFi tersambung. IP ESP32: %s | sinyal %d dBm\n", WiFi.localIP().toString().c_str(), (int)WiFi.RSSI());
    }

    if (!mqtt.connected()) {
      mqttOk = false;
      if (wasConnected) { wasConnected = false; Serial.println("[MQTT] koneksi terputus, mencoba menyambung ulang..."); }
      if (firstMqttTry || millis() - lastMqttTry >= MQTT_RETRY_MS) {
        firstMqttTry = false;
        lastMqttTry = millis();
        Serial.printf("[MQTT] menyambung ke %s:%d ...\n", MQTT_HOST, MQTT_PORT);
        if (mqttConnect()) {
          wasConnected = true;
          Serial.println("[MQTT] terhubung. Data dikirim real-time ke dashboard.");
        } else {
          Serial.printf("[MQTT] gagal, rc=%d (-2 = broker tak terjangkau, 5 = user/password salah)\n", mqtt.state());
        }
      }
      vTaskDelay(pdMS_TO_TICKS(100));
      continue;
    }

    mqtt.loop();
    mqttOk = mqtt.connected();
    lastBrokerOkMs = millis();

    unsigned long now = millis();
    if (sendNow || now - lastPub >= HEARTBEAT_MS) {
      sendNow = false;
      lastPub = now;
      publishTelemetry();
    }
    vTaskDelay(pdMS_TO_TICKS(5));
  }
}

// =================================================================
void setup() {
  Serial.begin(115200);
  delay(300);

  pinMode(relayPin, OUTPUT);
  setRelay(false);

  Serial.println("\n==============================================");
  Serial.println(" MES Power Monitor - MQTT real-time");
  Serial.printf(" Broker : %s:%d  (TLS: %s)\n", MQTT_HOST, MQTT_PORT, MQTT_USE_TLS ? "ya" : "tidak");
  Serial.println(" Serial : nyalakan | matikan | reset");
  Serial.println("==============================================");

#if MQTT_USE_TLS
  #if USE_INSECURE_TLS
  netClient.setInsecure();
  #else
  netClient.setCACert(ROOT_CA);
  #endif
#endif
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(onMqttMessage);
  mqtt.setBufferSize(512);
  mqtt.setKeepAlive(15);
  mqtt.setSocketTimeout(5);

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.setAutoReconnect(true);
  WiFi.persistent(false);
  Serial.printf("[NET] SSID: \"%s\" | panjang password: %d karakter\n", WIFI_SSID, (int)strlen(WIFI_PASSWORD));
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  Serial.print("[NET] Menghubungkan ke WiFi");
  for (int retry = 0; WiFi.status() != WL_CONNECTED && retry < 30; retry++) {
    delay(500);
    Serial.print(".");
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\n[NET] WiFi terhubung. IP ESP32: %s | sinyal %d dBm\n", WiFi.localIP().toString().c_str(), (int)WiFi.RSSI());
  } else {
    Serial.printf("\n[NET] WiFi GAGAL: %s\n", wifiStatusText(WiFi.status()));
    WiFi.disconnect();
    scanWifi();
    Serial.println("[NET] Dilanjutkan di background (proteksi lokal tetap aktif)...");
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  }

  lastBrokerOkMs = millis();
  xTaskCreatePinnedToCore(netTask, "net", 12288, NULL, 1, NULL, 0);
}

void loop() {
  prosesSerial();
  prosesPerintah();

  if (millis() - lastSensorMs >= SENSOR_INTERVAL_MS) {
    lastSensorMs = millis();
    bacaSensorDanProteksi();
  }
  delay(2);
}