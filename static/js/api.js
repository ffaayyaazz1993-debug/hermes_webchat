function api(path, opts) {
  var o = Object.assign({ headers: {} }, opts || {});
  o.headers = Object.assign({ "Content-Type": "application/json" }, o.headers);
  if (KEY) o.headers["Authorization"] = "Bearer " + KEY;
  return fetch(path, o).then(function (res) {
    if (res.status === 401) { var e = new Error("Unauthorized - the API key was rejected."); e.status = 401; throw e; }
    if (!res.ok) {
      return res.text().then(function (t) {
        var msg = "HTTP " + res.status;
        try {
          var j = JSON.parse(t);
          // Hermes returns {error:{message}}; this app's own routes return {error:"text"}.
          msg = (j.error && j.error.message) || (typeof j.error === "string" && j.error) ||
                j.message || msg;
        } catch (e) {}
        var err = new Error(msg); err.status = res.status; throw err;
      });
    }
    return res;
  });
}
function apiJSON(p, o) { return api(p, o).then(function (r) { return r.json(); }); }
