/**
 * 跑在 x.com 页面里，只为「未回关」转发只读 GET。
 * 不关注、不取关、不发帖。Bearer 是网页客户端公开令牌，不是用户密钥。
 */
(() => {
  if (window.__XRH_NF_PAGE__) return;
  window.__XRH_NF_PAGE__ = true;

  const TOKEN = Math.random().toString(36).slice(2) + Date.now().toString(36);
  document.documentElement.setAttribute("data-xrh-nf", TOKEN);

  const PUBLIC_BEARER =
    "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

  const OPS = new Set(["Following", "Followers", "UserByScreenName", "Viewer"]);
  const REST = new Set([
    "/i/api/1.1/account/verify_credentials.json",
    "/i/api/1.1/friends/list.json",
    "/i/api/1.1/friends/ids.json",
    "/i/api/1.1/followers/ids.json",
    "/i/api/1.1/users/lookup.json",
  ]);

  const inflight = new Map();

  function readCt0() {
    const match = document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : "";
  }

  function allowed(url) {
    let parsed;
    try {
      parsed = new URL(String(url || ""));
    } catch {
      return false;
    }
    if (parsed.protocol !== "https:") return false;
    const hostOk =
      parsed.hostname === location.hostname ||
      parsed.hostname === "x.com" ||
      parsed.hostname === "twitter.com";
    if (!hostOk) return false;
    if (REST.has(parsed.pathname)) return true;
    const op = parsed.pathname.match(/^\/i\/api\/graphql\/[A-Za-z0-9_-]+\/([A-Za-z0-9_]+)$/);
    return !!(op && OPS.has(op[1]));
  }

  function reply(id, payload) {
    window.postMessage(
      Object.assign({ source: "xrh-nf-res", token: TOKEN, id: id }, payload),
      location.origin
    );
  }

  async function doFetch(url, signal) {
    if (!allowed(url)) return { ok: false, error: "blocked_url", status: 0, text: "" };
    const ct0 = readCt0();
    if (!ct0) return { ok: false, error: "not_logged_in", status: 0, text: "" };
    const res = await fetch(url, {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      signal: signal,
      headers: {
        accept: "application/json, text/plain, */*",
        authorization: "Bearer " + PUBLIC_BEARER,
        "x-csrf-token": ct0,
        "x-twitter-auth-type": "OAuth2Session",
        "x-twitter-active-user": "yes",
        "x-twitter-client-language": "zh-cn",
      },
    });
    let text = await res.text();
    if (text.length > 2000000) text = text.slice(0, 2000000);
    return {
      ok: res.ok,
      status: res.status,
      text: text,
      retryAfter: res.headers.get("retry-after") || "",
      rateReset: res.headers.get("x-rate-limit-reset") || "",
    };
  }

  function scoreScript(url) {
    let score = 0;
    if (/\/api\./.test(url)) score += 50;
    if (/main\./.test(url)) score += 20;
    if (/bundle/.test(url)) score += 8;
    if (/vendor|i18n|icon/.test(url)) score -= 40;
    return score;
  }

  function collectScriptUrls() {
    const urls = new Set();
    document.querySelectorAll("script[src]").forEach((node) => {
      const src = node.src || "";
      if (src.includes("abs.twimg.com") && src.includes(".js")) urls.add(src.split("?")[0]);
    });
    performance.getEntriesByType("resource").forEach((entry) => {
      const name = entry.name || "";
      if (name.includes("abs.twimg.com") && name.includes(".js")) urls.add(name.split("?")[0]);
    });
    return [...urls].sort((a, b) => scoreScript(b) - scoreScript(a));
  }

  async function discover(need) {
    const wanted = new Set((need || []).filter((name) => OPS.has(name)));
    if (!wanted.size) wanted.add("Following");
    const queryIds = {};
    const features = {};
    const seen = new Set();
    let fetched = 0;

    async function scanUrl(url) {
      if (!url || seen.has(url) || fetched >= 8) return;
      seen.add(url);
      fetched += 1;
      let text = "";
      try {
        const res = await fetch(url, { credentials: "omit", cache: "force-cache" });
        if (!res.ok) return;
        text = await res.text();
      } catch {
        return;
      }
      if (!text.includes("operationName")) {
        text = "";
        return;
      }
      if (text.length > 2500000) text = text.slice(0, 2500000);
      const opRe = /queryId:"([A-Za-z0-9_-]{8,})",operationName:"([A-Za-z0-9_]+)"/g;
      let match;
      while ((match = opRe.exec(text))) {
        if (wanted.has(match[2]) && !queryIds[match[2]]) queryIds[match[2]] = match[1];
      }
      const featRe =
        /operationName:"(Following|Followers|UserByScreenName|Viewer)"[\s\S]{0,600}?featureSwitches:\[([^\]]*)\]/g;
      while ((match = featRe.exec(text))) {
        if (!wanted.has(match[1]) || features[match[1]]) continue;
        const names = [];
        const nameRe = /"([A-Za-z0-9_]+)"/g;
        let name;
        while ((name = nameRe.exec(match[2]))) names.push(name[1]);
        if (names.length) features[match[1]] = names.slice(0, 40);
      }
      text = "";
    }

    for (const url of collectScriptUrls()) {
      if ([...wanted].every((name) => queryIds[name])) break;
      await scanUrl(url);
    }

    if (![...wanted].every((name) => queryIds[name])) {
      try {
        const res = await fetch(location.origin + "/home", { credentials: "include", cache: "no-store" });
        if (res.ok) {
          let html = await res.text();
          html = html.replace(/\\\//g, "/");
          const found = html.match(/https:\/\/abs\.twimg\.com\/[^"'\\\s>]+\.js/g) || [];
          html = "";
          for (const url of found) {
            if ([...wanted].every((name) => queryIds[name])) break;
            await scanUrl(url.split("?")[0]);
          }
        }
      } catch {
        /* 找不到 bundle 时走内置 queryId */
      }
    }

    return { queryIds: queryIds, features: features };
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== "xrh-nf-req" || msg.token !== TOKEN) return;
    const id = String(msg.id || "");
    if (!id) return;

    if (msg.op === "abort") {
      const ctrl = inflight.get(id);
      if (ctrl) ctrl.abort();
      return;
    }

    if (msg.op === "discover") {
      discover(msg.need)
        .then((found) => reply(id, { ok: true, found: found }))
        .catch(() => reply(id, { ok: false, error: "discover" }));
      return;
    }

    if (msg.op !== "fetch") return;
    const ctrl = new AbortController();
    inflight.set(id, ctrl);
    doFetch(msg.url, ctrl.signal)
      .then((payload) => reply(id, payload))
      .catch((err) => reply(id, { ok: false, error: err && err.name ? err.name : "fetch", status: 0, text: "" }))
      .finally(() => inflight.delete(id));
  });
})();
