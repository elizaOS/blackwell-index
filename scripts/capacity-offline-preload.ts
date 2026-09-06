/** Test-harness guard only. Load before the capacity script's other imports. */
import { createRequire, syncBuiltinESMExports } from "node:module";
const require = createRequire(import.meta.url);
const forbidden = () => { throw new Error("CAPACITY_NETWORK_FORBIDDEN"); };
Object.defineProperty(globalThis, "fetch", { value: Object.assign(forbidden, { preconnect: forbidden }), configurable: false, writable: false });
const http = require("node:http") as typeof import("node:http"), https = require("node:https") as typeof import("node:https");
http.request = forbidden; http.get = forbidden; https.request = forbidden; https.get = forbidden;
const net = require("node:net") as typeof import("node:net");
net.connect = forbidden; net.createConnection = forbidden; net.Socket.prototype.connect = forbidden;
const tls = require("node:tls") as typeof import("node:tls"); tls.connect = forbidden;
const dgram = require("node:dgram") as typeof import("node:dgram"); dgram.createSocket = forbidden;
const dns = require("node:dns") as typeof import("node:dns"); Object.defineProperty(dns, "lookup", { value: forbidden, configurable: false, writable: false });
const webSocket = class { constructor() { forbidden(); } };
Object.defineProperty(globalThis, "WebSocket", { value: webSocket, configurable: false, writable: false });
// Bun's native network APIs do not necessarily route through Node's sockets.
if (typeof Bun !== "undefined") {
  for (const name of ["connect", "listen", "serve", "udpSocket"] as const) Object.defineProperty(Bun, name, { value: forbidden, configurable: false, writable: false });
}
syncBuiltinESMExports();
