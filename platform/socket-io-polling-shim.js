/*
 * Cloudflare polling transport adapter for the unmodified Nightscout UI.
 *
 * The upstream browser calls the Socket.IO client surface exposed at this URL.
 * Workers Free does not run the upstream Node Socket.IO server, so this adapter maps
 * the small subset used by the homepage to bounded REST polling. This file has
 * no visual, chart, plugin, translation, or medical logic.
 */
(function installCloudflareTransport(global) {
  "use strict";

  var POLL_INTERVAL_MS = 15000;

  function tenant() {
    var selected = new URLSearchParams(global.location.search).get("tenant");
    return selected || "demo";
  }

  function Emitter(namespace) {
    this.namespace = namespace || "/";
    this.handlers = Object.create(null);
    this.pollTimer = null;
    this.closed = false;
    var self = this;
    global.setTimeout(function connected() {
      self.dispatch("connect");
    }, 0);
  }

  Emitter.prototype.on = function on(name, handler) {
    if (!this.handlers[name]) this.handlers[name] = [];
    this.handlers[name].push(handler);
    return this;
  };

  Emitter.prototype.dispatch = function dispatch(name, payload) {
    var callbacks = this.handlers[name] || [];
    callbacks.forEach(function invoke(handler) {
      handler(payload);
    });
  };

  Emitter.prototype.emit = function emit(name, payload, callback) {
    if (this.namespace === "/alarm") {
      if (name === "subscribe" && callback) {
        callback({ success: true, read: true });
      }
      return this;
    }

    if (name === "authorize") {
      var authorization = { read: true, write: false, write_treatment: false };
      // Upstream websocket.js sends the initial dataUpdate before invoking the
      // authorize callback. Preserve that ordering because the official client
      // initializes profile-dependent plugins from that first data payload.
      this.poll(true, function afterInitialData() {
        if (callback) callback(authorization);
      });
    } else if (name === "loadRetro") {
      if (callback) callback({ result: "success" });
      this.dispatch("retroUpdate", { devicestatus: [] });
    } else if (callback) {
      callback({ result: "Not permitted" });
    }
    return this;
  };

  Emitter.prototype.poll = function poll(runNow, firstLoadDone) {
    var self = this;
    if (this.closed) return;
    var firstLoadPending = typeof firstLoadDone === "function";

    function completeFirstLoad() {
      if (!firstLoadPending) return;
      firstLoadPending = false;
      firstLoadDone();
    }

    function schedule() {
      global.clearTimeout(self.pollTimer);
      self.pollTimer = global.setTimeout(load, POLL_INTERVAL_MS);
    }

    function load() {
      var query = new URLSearchParams({ tenant: tenant() });
      global.fetch("/api/v2/ddata/at?" + query.toString(), {
        headers: { Accept: "application/json" },
        cache: "no-store",
      }).then(function parse(response) {
        if (!response.ok) throw new Error("data request failed: " + response.status);
        return response.json();
      }).then(function deliver(data) {
        data.delta = false;
        self.dispatch("dataUpdate", data);
      }).catch(function failed(error) {
        console.error("Nightscout polling adapter", error);
      }).finally(completeFirstLoad).finally(schedule);
    }

    if (runNow) load();
    else schedule();
  };

  Emitter.prototype.disconnect = function disconnect() {
    this.closed = true;
    global.clearTimeout(this.pollTimer);
    this.dispatch("disconnect");
    return this;
  };

  global.io = {
    connect: function connect(namespace) {
      return new Emitter(typeof namespace === "string" ? namespace : "/");
    },
  };
})(window);
