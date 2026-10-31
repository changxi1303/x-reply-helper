/**
 * X 回复助手 · 未回关 — 纯函数
 * 只做列表解析、差集和错误分类。不发请求，不关注、不取关。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.XrhNonFollow = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const LIMITS = {
    defaultCap: 2000,
    capChoices: [200, 500, 2000, 5000, 10000],
    maxCap: 10000,
    restPage: 200,
    gqlPage: 20,
    idsPage: 5000,
    followerIdCap: 50000,
    lookupBatch: 100,
    pageGapMs: 700,
    memorySaverGapMs: 1000,
    emptyPageStop: 3,
    storageItemCap: 2500,
    storageVersion: 1,
  };

  const FOLLOWS_YOU_RE =
    /follows you|followed you|关注了你|關注了你|フォローされています|te sigue|sigue tú|vous suit/i;

  const ALLOWED_GQL_OPS = [
    "Following",
    "Followers",
    "UserByScreenName",
    "Viewer",
  ];

  const ALLOWED_REST_PATHS = [
    "/i/api/1.1/account/verify_credentials.json",
    "/i/api/1.1/friends/list.json",
    "/i/api/1.1/friends/ids.json",
    "/i/api/1.1/followers/ids.json",
    "/i/api/1.1/users/lookup.json",
  ];

  function clampCap(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return LIMITS.defaultCap;
    let best = LIMITS.capChoices[0];
    let dist = Infinity;
    for (const c of LIMITS.capChoices) {
      const d = Math.abs(c - n);
      if (d < dist) {
        dist = d;
        best = c;
      }
    }
    if (LIMITS.capChoices.includes(n)) return n;
    return Math.min(LIMITS.maxCap, Math.max(LIMITS.capChoices[0], best));
  }

  function followerIdCeiling(followingCap) {
    const cap = clampCap(followingCap);
    return Math.min(LIMITS.followerIdCap, Math.max(cap * 4, 8000));
  }

  function isValidHandle(handle) {
    return /^[A-Za-z0-9_]{1,15}$/.test(String(handle || ""));
  }

  function safeAvatar(url) {
    try {
      const u = new URL(String(url || ""));
      if (u.protocol !== "https:") return "";
      if (u.hostname !== "pbs.twimg.com" && u.hostname !== "abs.twimg.com") return "";
      return u.toString();
    } catch {
      return "";
    }
  }

  function profileUrl(user) {
    const handle = String(user?.handle || "").replace(/^@/, "");
    if (isValidHandle(handle)) return "https://x.com/" + handle;
    const id = String(user?.id || "");
    if (/^\d{1,32}$/.test(id)) return "https://x.com/i/user/" + id;
    return "";
  }

  function formatCount(n) {
    const v = Number(n);
    if (!Number.isFinite(v) || v < 0) return "";
    if (v < 10000) return String(Math.round(v));
    if (v < 100000000) {
      const w = v / 10000;
      const rounded = w >= 100 ? Math.round(w) : Math.round(w * 10) / 10;
      return String(rounded) + "万";
    }
    return String(Math.round((v / 100000000) * 10) / 10) + "亿";
  }

  function csvCell(value) {
    const s = String(value ?? "");
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function toCsv(items) {
    const lines = ["handle,name,followers,profile_url"];
    for (const it of items || []) {
      lines.push(
        [
          it.handle || "",
          it.name || "",
          it.followersCount == null ? "" : it.followersCount,
          profileUrl(it),
        ]
          .map(csvCell)
          .join(",")
      );
    }
    return "\uFEFF" + lines.join("\r\n");
  }

  function compactUser(user) {
    if (!user || !user.id) return null;
    const handle = String(user.handle || "").replace(/^@/, "");
    const item = {
      id: String(user.id),
      handle: isValidHandle(handle) ? handle : "",
      name: String(user.name || "").replace(/\s+/g, " ").trim().slice(0, 80),
      avatar: safeAvatar(user.avatar),
      followersCount:
        user.followersCount == null || !Number.isFinite(Number(user.followersCount))
          ? null
          : Math.max(0, Math.round(Number(user.followersCount))),
      protected: !!user.protected,
    };
    if (!/^\d{1,32}$/.test(item.id)) return null;
    return item;
  }

  function trimStoredItems(items) {
    const out = [];
    const seen = new Set();
    for (const raw of items || []) {
      const item = compactUser(raw);
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
      if (out.length >= LIMITS.storageItemCap) break;
    }
    return out;
  }

  function isStoredResult(value) {
    return !!(
      value &&
      value.version === LIMITS.storageVersion &&
      Array.isArray(value.items) &&
      typeof value.scannedAt === "number"
    );
  }

  function excludeSelf(users, me) {
    const id = String(me?.id || "");
    const handle = String(me?.handle || "").replace(/^@/, "").toLowerCase();
    return (users || []).filter((u) => {
      if (!u) return false;
      if (id && String(u.id) === id) return false;
      if (handle && String(u.handle || "").toLowerCase() === handle) return false;
      return true;
    });
  }

  function signalMode(users) {
    let bools = 0;
    let slots = 0;
    for (const u of users || []) {
      if (!u) continue;
      if (typeof u.followedBy === "boolean") bools += 1;
      if (u.hasSocialSlot || u.followsYouBadge) slots += 1;
    }
    if (bools > 0) return "boolean";
    if (slots > 0) return "badge";
    return "none";
  }

  function isNonMutual(user, mode) {
    if (!user || (mode !== "boolean" && mode !== "badge")) return false;
    if (user.followedBy === true || user.followsYouBadge) return false;
    return true;
  }

  function selectNonMutual(users, mode) {
    if (mode !== "boolean" && mode !== "badge") return [];
    const out = [];
    const seen = new Set();
    for (const u of users || []) {
      if (!isNonMutual(u, mode)) continue;
      const id = String(u.id || "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(u);
    }
    return out;
  }

  function diffIds(followingIds, followerIds) {
    const followers = followerIds instanceof Set ? followerIds : new Set(followerIds || []);
    const out = [];
    const seen = new Set();
    for (const raw of followingIds || []) {
      const id = String(raw || "");
      if (!id || seen.has(id) || followers.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  }

  function nextPageDecision(prevCursor, page, emptyStreak) {
    const users = page?.users || page?.ids || [];
    const count = Array.isArray(users) ? users.length : 0;
    const cursor = page?.cursor ? String(page.cursor) : "";
    if (page?.terminated || !cursor || cursor === prevCursor) {
      return { stop: true, reason: "end", emptyStreak: emptyStreak || 0, truncated: false };
    }
    if (!count) {
      const streak = (emptyStreak || 0) + 1;
      if (streak >= LIMITS.emptyPageStop) {
        return { stop: true, reason: "empty_pages", emptyStreak: streak, truncated: true };
      }
      return { stop: false, reason: "", emptyStreak: streak, truncated: false };
    }
    return { stop: false, reason: "", emptyStreak: 0, truncated: false };
  }

  function findFollowedByFlag(userNode) {
    const stack = [{ n: userNode, d: 0 }];
    while (stack.length) {
      const { n, d } = stack.pop();
      if (!n || typeof n !== "object" || d > 5) continue;
      if (typeof n.followed_by === "boolean") return n.followed_by;
      const keys = Object.keys(n);
      for (let i = keys.length - 1; i >= 0; i--) {
        const k = keys[i];
        if (k === "status" || k === "entities" || k === "description") continue;
        const v = n[k];
        if (v && typeof v === "object") stack.push({ n: v, d: d + 1 });
      }
    }
    return null;
  }

  function readHandleName(node) {
    const legacy = node.legacy || {};
    const core = node.core || {};
    const handle = String(
      legacy.screen_name || core.screen_name || node.screen_name || ""
    ).replace(/^@/, "");
    const name = String(legacy.name || core.name || node.name || "");
    const avatar =
      legacy.profile_image_url_https ||
      node.avatar?.image_url ||
      node.profile_image_url_https ||
      "";
    const followers =
      legacy.followers_count ??
      legacy.normal_followers_count ??
      node.followers_count ??
      node.relationship_counts?.followers ??
      null;
    const isProtected = legacy.protected === true || node.privacy?.protected === true || node.protected === true;
    return { handle, name, avatar, followers, isProtected };
  }

  function userFromGqlResult(result) {
    if (!result || typeof result !== "object") return null;
    if (result.__typename === "UserUnavailable") return null;
    const id = String(result.rest_id || result.id_str || result.id || "");
    if (!/^\d{1,32}$/.test(id)) return null;
    const info = readHandleName(result);
    return {
      id,
      handle: info.handle,
      name: info.name,
      avatar: safeAvatar(info.avatar),
      followersCount: info.followers == null ? null : Number(info.followers),
      protected: info.isProtected,
      followedBy: findFollowedByFlag(result),
      followsYouBadge: false,
      hasSocialSlot: false,
    };
  }

  function normalizeRestUser(raw) {
    if (!raw || typeof raw !== "object") return null;
    const id = String(raw.id_str || raw.id || "");
    if (!/^\d{1,32}$/.test(id)) return null;
    let followedBy = null;
    if (typeof raw.followed_by === "boolean") followedBy = raw.followed_by;
    else if (Array.isArray(raw.connections) && raw.connections.includes("followed_by")) followedBy = true;
    return {
      id,
      handle: String(raw.screen_name || "").replace(/^@/, ""),
      name: String(raw.name || ""),
      avatar: safeAvatar(raw.profile_image_url_https || ""),
      followersCount: raw.followers_count == null ? null : Number(raw.followers_count),
      protected: raw.protected === true,
      followedBy,
      followsYouBadge: false,
      hasSocialSlot: false,
    };
  }

  function walkObjects(root, visit, maxNodes) {
    const stack = [root];
    let seen = 0;
    const cap = maxNodes || 8000;
    while (stack.length && seen < cap) {
      const node = stack.pop();
      if (!node || typeof node !== "object") continue;
      seen += 1;
      visit(node);
      if (Array.isArray(node)) {
        for (let i = node.length - 1; i >= 0; i--) {
          if (node[i] && typeof node[i] === "object") stack.push(node[i]);
        }
      } else {
        const keys = Object.keys(node);
        for (let i = keys.length - 1; i >= 0; i--) {
          const v = node[keys[i]];
          if (v && typeof v === "object") stack.push(v);
        }
      }
    }
  }

  function badgeFromSocial(social) {
    if (!social || typeof social !== "object") return false;
    const text = String(social.text || social.description || "");
    if (FOLLOWS_YOU_RE.test(text)) return true;
    const kind = String(social.contextType || social.type || "");
    if (/^followed?_by$/i.test(kind)) return true;
    if (/^follow(s)?$/i.test(kind) && FOLLOWS_YOU_RE.test(text)) return true;
    return false;
  }

  function applyEntrySignals(user, entry) {
    if (!user || !entry) return user;
    let hasSlot = false;
    let badge = false;
    walkObjects(entry, (node) => {
      if (!node.socialContext || typeof node.socialContext !== "object") return;
      hasSlot = true;
      if (badgeFromSocial(node.socialContext)) badge = true;
    }, 800);
    user.hasSocialSlot = hasSlot;
    user.followsYouBadge = badge;
    return user;
  }

  function parseTimelinePage(json) {
    const users = [];
    const seen = new Set();
    let cursor = "";
    let terminated = false;
    const entries = [];

    walkObjects(
      json,
      (node) => {
        if (node.type === "TimelineTerminateTimeline") terminated = true;
        if (typeof node.entryId === "string") entries.push(node);
        const cursorType = String(node.cursorType || "");
        if (/^bottom$/i.test(cursorType) && typeof node.value === "string" && node.value) {
          cursor = node.value;
        }
      },
      20000
    );

    for (const entry of entries) {
      if (entry.content?.promotedMetadata || entry.promotedMetadata) continue;
      let result = null;
      walkObjects(entry, (node) => {
        if (result) return;
        const candidate = node.user_results?.result || node.result;
        if (candidate && (candidate.rest_id || candidate.__typename === "User" || candidate.__typename === "UserUnavailable")) {
          if (candidate.legacy || candidate.core || candidate.rest_id) result = candidate;
        }
      }, 500);
      if (!result && entry.content?.itemContent?.user_results?.result) {
        result = entry.content.itemContent.user_results.result;
      }
      const user = applyEntrySignals(userFromGqlResult(result), entry);
      if (!user || seen.has(user.id)) continue;
      seen.add(user.id);
      users.push(user);
    }

    if (!users.length) {
      walkObjects(json, (node) => {
        if (node.__typename !== "User" && !node.rest_id) return;
        if (!(node.legacy || node.core)) return;
        const user = userFromGqlResult(node);
        if (!user || seen.has(user.id)) return;
        seen.add(user.id);
        users.push(user);
      });
    }

    return { users, cursor: terminated ? "" : cursor, terminated: terminated || !cursor };
  }

  function parseRestListPage(json) {
    const users = [];
    const seen = new Set();
    for (const raw of json?.users || []) {
      const user = normalizeRestUser(raw);
      if (!user || seen.has(user.id)) continue;
      seen.add(user.id);
      users.push(user);
    }
    const rawCursor = json?.next_cursor_str != null ? json.next_cursor_str : json?.next_cursor;
    const cursor = rawCursor == null ? "" : String(rawCursor);
    const end = !cursor || cursor === "0";
    return { users, cursor: end ? "" : cursor, terminated: end };
  }

  function parseRestIdsPage(json) {
    const ids = [];
    const seen = new Set();
    for (const raw of json?.ids || []) {
      const id = String(raw || "");
      if (!/^\d{1,32}$/.test(id) || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    const rawCursor = json?.next_cursor_str != null ? json.next_cursor_str : json?.next_cursor;
    const cursor = rawCursor == null ? "" : String(rawCursor);
    const end = !cursor || cursor === "0";
    return { ids, cursor: end ? "" : cursor, terminated: end };
  }

  function parseLookupUsers(json) {
    const list = Array.isArray(json) ? json : json?.users || [];
    const users = [];
    for (const raw of list) {
      const user = normalizeRestUser(raw);
      if (user) users.push(user);
    }
    return users;
  }

  function parseViewer(json) {
    let found = null;
    walkObjects(json, (node) => {
      if (found) return;
      const result = node.user_results?.result || node.result;
      if (result?.rest_id && (result.legacy || result.core)) found = result;
    }, 2000);
    if (!found && json?.id_str) return normalizeAccount(json);
    const user = userFromGqlResult(found);
    if (!user) return null;
    const legacy = found.legacy || {};
    return {
      id: user.id,
      handle: user.handle,
      name: user.name,
      protected: user.protected,
      followingCount: Number(legacy.friends_count ?? found.friends_count ?? NaN),
      followersCount: Number(legacy.followers_count ?? found.followers_count ?? NaN),
    };
  }

  function normalizeAccount(raw) {
    if (!raw || typeof raw !== "object") return null;
    const id = String(raw.id_str || raw.id || raw.rest_id || "");
    if (!/^\d{1,32}$/.test(id)) return null;
    const handle = String(raw.screen_name || raw.legacy?.screen_name || "").replace(/^@/, "");
    return {
      id,
      handle,
      name: String(raw.name || raw.legacy?.name || ""),
      protected: raw.protected === true || raw.legacy?.protected === true,
      followingCount: Number(raw.friends_count ?? raw.legacy?.friends_count ?? NaN),
      followersCount: Number(raw.followers_count ?? raw.legacy?.followers_count ?? NaN),
    };
  }

  function parseMissingFeatures(text) {
    const blob = String(text || "");
    const out = [];
    const cannot = blob.match(/cannot be null:\s*([A-Za-z0-9_,\s]+)/i);
    if (cannot) out.push(...cannot[1].split(","));
    const switches = blob.matchAll(/feature switch ["']([A-Za-z0-9_]+)["']/gi);
    for (const m of switches) out.push(m[1]);
    const dep = blob.matchAll(/"([a-z][a-z0-9_]{2,})"\s*(?:feature|must be specified)/gi);
    for (const m of dep) out.push(m[1]);
    return [...new Set(out.map((s) => s.trim()).filter((s) => /^[A-Za-z0-9_]+$/.test(s)))];
  }

  function classifyXError(status, bodyText) {
    const text = String(bodyText || "");
    const statusNum = Number(status) || 0;
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    const apiMsg = String(
      data?.errors?.[0]?.message || data?.error?.message || data?.error || ""
    );
    const codeNum = Number(data?.errors?.[0]?.code || 0);
    const blob = (apiMsg + " " + text.slice(0, 800)).toLowerCase();
    const missing = parseMissingFeatures(apiMsg + " " + text.slice(0, 1500));

    if (statusNum === 429 || codeNum === 88 || /rate limit|too many requests/.test(blob)) {
      return { code: "rate_limit", message: "触发 X 频率限制" };
    }
    if (missing.length && (statusNum === 400 || statusNum === 200 || statusNum === 422)) {
      return { code: "missing_features", message: "接口要求补全功能开关", features: missing };
    }
    if (
      statusNum === 401 ||
      codeNum === 32 ||
      codeNum === 215 ||
      /could not authenticate|not logged in|unauthorized/.test(blob)
    ) {
      return { code: "not_logged_in", message: "未登录或登录已失效" };
    }
    if (codeNum === 353 || /csrf/.test(blob)) {
      return { code: "csrf", message: "登录校验失败" };
    }
    if (statusNum === 404 || statusNum === 410) {
      return { code: "not_found", message: "接口不存在或已变更" };
    }
    if (codeNum === 64 || codeNum === 326 || /temporarily locked|suspended/.test(blob)) {
      return { code: "locked", message: "账号可能被暂时限制" };
    }
    if (/protected|not authorized to (see|view)|cannot view/.test(blob)) {
      return { code: "protected", message: "没有权限查看该列表" };
    }
    if (statusNum >= 400) {
      const short = (apiMsg || text || "HTTP " + statusNum).replace(/\s+/g, " ").slice(0, 180);
      return { code: "api", message: short || "接口错误" };
    }
    if (statusNum === 200 && data?.errors?.length && !data?.data && !data?.users && !data?.ids && !Array.isArray(data)) {
      const short = (apiMsg || "接口返回错误").replace(/\s+/g, " ").slice(0, 180);
      return { code: "api", message: short };
    }
    return { code: "ok", message: "" };
  }

  function buildRestUrl(origin, path, params) {
    const u = new URL(path, origin || "https://x.com");
    for (const [k, v] of Object.entries(params || {})) {
      if (v == null || v === "") continue;
      u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  function compactFeatures(features) {
    const out = {};
    for (const [k, v] of Object.entries(features || {})) {
      if (v === false) continue;
      out[k] = v === true ? true : v;
    }
    return out;
  }

  function buildGraphqlUrl(origin, queryId, operationName, variables, features, fieldToggles) {
    if (!ALLOWED_GQL_OPS.includes(operationName)) {
      throw new Error("不允许的操作");
    }
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(String(queryId || ""))) {
      throw new Error("无效的 queryId");
    }
    const u = new URL(
      "/i/api/graphql/" + queryId + "/" + operationName,
      origin || "https://x.com"
    );
    u.searchParams.set("variables", JSON.stringify(variables || {}));
    u.searchParams.set("features", JSON.stringify(compactFeatures(features)));
    if (fieldToggles && Object.keys(fieldToggles).length) {
      u.searchParams.set("fieldToggles", JSON.stringify(fieldToggles));
    }
    return u.toString();
  }

  function followingVariables(userId, count, cursor) {
    const v = {
      userId: String(userId),
      count: count || LIMITS.gqlPage,
      includePromotedContent: false,
    };
    if (cursor) v.cursor = String(cursor);
    return v;
  }

  function isAllowedApiUrl(url, pageOrigin) {
    let u;
    try {
      u = new URL(String(url || ""));
    } catch {
      return false;
    }
    if (u.protocol !== "https:") return false;
    let originHost = "";
    try {
      originHost = new URL(pageOrigin || "https://x.com").hostname;
    } catch {
      originHost = "x.com";
    }
    const hostOk = u.hostname === originHost || u.hostname === "x.com" || u.hostname === "twitter.com";
    if (!hostOk) return false;
    if (ALLOWED_REST_PATHS.includes(u.pathname)) return true;
    const m = u.pathname.match(/^\/i\/api\/graphql\/[A-Za-z0-9_-]+\/([A-Za-z0-9_]+)$/);
    return !!(m && ALLOWED_GQL_OPS.includes(m[1]));
  }

  function matchesFilter(item, query) {
    const q = String(query || "").trim().toLowerCase().replace(/^@/, "");
    if (!q) return true;
    return (
      String(item?.handle || "").toLowerCase().includes(q) ||
      String(item?.name || "").toLowerCase().includes(q)
    );
  }

  function sortItems(items, mode) {
    const list = (items || []).slice();
    if (mode === "followers") {
      list.sort((a, b) => (b.followersCount || 0) - (a.followersCount || 0));
    }
    return list;
  }

  function messageForCode(code) {
    switch (code) {
      case "not_logged_in":
        return "未登录或登录已失效。请在这个浏览器里打开 x.com 并登录，刷新页面后再扫描。";
      case "csrf":
        return "登录校验失败。请刷新 x.com 后再扫描，不要使用无痕窗口以外的另一套登录态。";
      case "rate_limit":
        return "触发 X 频率限制。已保留目前扫到的结果，请过一会儿再继续。";
      case "locked":
        return "账号可能被暂时限制。请先在 X 网页确认自己能打开「正在关注」。";
      case "protected":
        return "没有权限读取粉丝或关注列表。请确认当前登录的是你自己的账号。";
      case "not_found":
        return "X 的列表接口有变化，这次没读到。请刷新 x.com 后再试。";
      case "no_signal":
        return "关注列表没有带回关标记，完整粉丝列表也被 X 拦住了。为避免把已回关的人算进来，这次不展示名单。请刷新 x.com 后再试。";
      case "cancelled":
        return "已停止。下面是停下来之前扫到的未回关，可能不完整。";
      case "network":
        return "网络请求失败。请确认 x.com 已打开且网络正常。";
      case "parse":
        return "列表解析失败，X 的返回格式可能已变更。请刷新后再试。";
      default:
        return "";
    }
  }

  return {
    LIMITS,
    ALLOWED_GQL_OPS,
    ALLOWED_REST_PATHS,
    clampCap,
    followerIdCeiling,
    isValidHandle,
    safeAvatar,
    profileUrl,
    formatCount,
    toCsv,
    compactUser,
    trimStoredItems,
    isStoredResult,
    excludeSelf,
    signalMode,
    isNonMutual,
    selectNonMutual,
    diffIds,
    nextPageDecision,
    findFollowedByFlag,
    normalizeRestUser,
    userFromGqlResult,
    parseTimelinePage,
    parseRestListPage,
    parseRestIdsPage,
    parseLookupUsers,
    parseViewer,
    normalizeAccount,
    parseMissingFeatures,
    classifyXError,
    buildRestUrl,
    buildGraphqlUrl,
    followingVariables,
    compactFeatures,
    isAllowedApiUrl,
    matchesFilter,
    sortItems,
    messageForCode,
  };
});
