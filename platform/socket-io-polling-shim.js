/*
 * NSCF Cloudflare transport adapter for the unmodified Nightscout v15.0.7 UI.
 *
 * The upstream browser calls the Socket.IO client surface exposed at this URL.
 * Workers Free does not run the upstream Node Socket.IO server, so phase 1 maps
 * the small subset used by the homepage to bounded REST polling. This file has
 * no visual, chart, plugin, translation, or medical logic.
 */
(function installNSCFTransport(global) {
  "use strict";

  var POLL_INTERVAL_MS = 15000;
  var HISTORY_COUNT = 576;

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
      if (callback) callback({ read: true, write: false, write_treatment: false });
      this.poll(true);
    } else if (name === "loadRetro") {
      if (callback) callback({ result: "success" });
      this.dispatch("retroUpdate", { devicestatus: [] });
    } else if (callback) {
      callback({ result: "Not permitted" });
    }
    return this;
  };

  Emitter.prototype.poll = function poll(runNow) {
    var self = this;
    if (this.closed) return;

    function schedule() {
      global.clearTimeout(self.pollTimer);
      self.pollTimer = global.setTimeout(load, POLL_INTERVAL_MS);
    }

    function load() {
      var query = new URLSearchParams({
        count: String(HISTORY_COUNT),
        tenant: tenant(),
      });
      global.fetch("/api/v1/entries.json?" + query.toString(), {
        headers: { Accept: "application/json" },
        cache: "no-store",
      }).then(function parse(response) {
        if (!response.ok) throw new Error("entries request failed: " + response.status);
        return response.json();
      }).then(function deliver(entries) {
        var sgvs = entries.map(function toRuntimeEntry(entry) {
          return {
            _id: entry._id,
            mgdl: Number(entry.sgv),
            mills: Number(entry.date),
            device: entry.device,
            direction: entry.direction,
            type: "sgv",
          };
        }).sort(function byTime(a, b) {
          return a.mills - b.mills;
        });

        self.dispatch("dataUpdate", {
          delta: false,
          sgvs: sgvs,
          mbgs: [],
          cals: [],
          treatments: [],
          food: [],
          devicestatus: [],
          dbstats: {},
        });
      }).catch(function failed(error) {
        console.error("NSCF polling adapter", error);
      }).finally(schedule);
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
