/**
 * ============================================================
 * LAKE ROOTS — FORMS HUB DEDICATED PROXY
 *
 * Hosted on: lakeroots-forms-proxy.netlify.app
 * Repo:      github.com/carlie-bit/lakeroots-forms-proxy
 *
 * Purpose: dedicated proxy ONLY for the Forms Hub dashboard
 * (lakeroots-forms.netlify.app). Completely isolated from the
 * calendar proxy at lakeroots-calendar.netlify.app — they never
 * share infrastructure.
 *
 * Supported actions:
 *   GET  ?action=form_data&form=<slug>     → reads sheet data
 *   POST ?action=form_update               → writes back to sheet
 *                                            body: {form, row, updates}
 *
 * CORS: open (Access-Control-Allow-Origin: *)
 * Handles OPTIONS preflight requests for POST.
 * ============================================================ */

const https = require("https");
const { URL } = require("url");

// Apps Script Web App URL — current production deployment @46
// Contains: getFormData_, updateFormRow_, doPost router
const GAS_URL = "https://script.google.com/macros/s/AKfycbze-3pGiyMcJigvO_N0MPs4E5tnvI3AZz7FO4oNP30d8DKW8p1duwB7jTgdcBgKIEQMnw/exec";

// Only allow Forms Hub-specific actions — clean allowlist
const VALID_ACTIONS = ["form_data", "form_update"];

// Standard CORS headers — applied to every response
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400"
};

/**
 * Forwards request to Apps Script, following any redirects (Apps Script
 * frequently returns 302 to googleusercontent.com).
 */
function forward(method, url, body, redirectCount, resolve) {
  if (redirectCount > 10) {
    resolve({
      statusCode: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Too many redirects" })
    });
    return;
  }

  const parsed = new URL(url);
  const options = {
    method: method,
    hostname: parsed.hostname,
    path: parsed.pathname + parsed.search,
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "application/json"
    }
  };

  if (method === "POST" && body) {
    options.headers["Content-Type"] = "application/json";
    options.headers["Content-Length"] = Buffer.byteLength(body);
  }

  const req = https.request(options, function(res) {
    // Follow redirects (Apps Script uses these heavily)
    if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 303 || res.statusCode === 307) {
      const location = res.headers.location;
      if (!location) {
        resolve({
          statusCode: 500,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
          body: JSON.stringify({ error: "Redirect with no location" })
        });
        return;
      }
      // On a 307, preserve the method. Other redirects → GET.
      const nextMethod = res.statusCode === 307 ? method : "GET";
      const nextBody = nextMethod === "POST" ? body : null;
      forward(nextMethod, location, nextBody, redirectCount + 1, resolve);
      return;
    }

    let data = "";
    res.on("data", function(chunk) { data += chunk; });
    res.on("end", function() {
      resolve({
        statusCode: 200,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        body: data
      });
    });
  });

  req.on("error", function(err) {
    resolve({
      statusCode: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ error: err.message })
    });
  });

  if (method === "POST" && body) {
    req.write(body);
  }
  req.end();
}

exports.handler = async function(event) {
  // ───────── OPTIONS preflight (CORS) ─────────
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: CORS_HEADERS,
      body: ""
    };
  }

  const params = event.queryStringParameters || {};
  const action = params.action || "";

  // ───────── Action allowlist ─────────
  if (VALID_ACTIONS.indexOf(action) === -1) {
    return {
      statusCode: 400,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "Unknown or disallowed action: " + action,
        validActions: VALID_ACTIONS
      })
    };
  }

  // ───────── Build forwarded URL ─────────
  let url = GAS_URL + "?action=" + encodeURIComponent(action);

  // Pass through other query params (form, item, etc.)
  Object.keys(params).forEach(function(k) {
    if (k !== "action" && params[k] !== undefined && params[k] !== null) {
      url += "&" + encodeURIComponent(k) + "=" + encodeURIComponent(params[k]);
    }
  });

  // ───────── GET: form_data ─────────
  if (event.httpMethod === "GET") {
    return new Promise(function(resolve) {
      forward("GET", url, null, 0, resolve);
    });
  }

  // ───────── POST: form_update ─────────
  if (event.httpMethod === "POST") {
    const body = event.body || "{}";
    return new Promise(function(resolve) {
      forward("POST", url, body, 0, resolve);
    });
  }

  // ───────── Unsupported method ─────────
  return {
    statusCode: 405,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ error: "Method not allowed: " + event.httpMethod })
  };
};
