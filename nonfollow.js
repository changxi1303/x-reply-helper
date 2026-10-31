/**
 * X 回复助手 · 未回关（只读）
 * 在已登录的 x.com 页面里列出「我关注了、对方没回关」的账号。
 * 只打开主页，不关注、不取关、不发帖。
 */
(() => {
  if (window.__XRH_NF__) return;
  window.__XRH_NF__ = true;

  const core = window.XrhNonFollow;
  if (!core) return;

  const STORAGE_KEY = "xrhNonFollow";
  const CAP_KEY = "xrhNonFollowCap";
  const OPS_KEY = "xrhNfOps";
  const SKIP_HANDLES = new Set([
    "home", "explore", "notifications", "messages", "settings", "i", "compose",
    "search", "tos", "privacy", "login", "signup", "intent", "share", "jobs", "account",
  ]);
  const FALLBACK_IDS = {
    Following: "zx6e-TLzRkeDO_a7p4b3JQ",
    Followers: "IOh4aS6UdGWGJUYTqliQ7Q",
    UserByScreenName: "1VOOyvKkiI3FMmkeDNxM9A",
  };
  const DEFAULT_FEATURES = {
    responsive_web_graphql_exclude_directive_enabled: true,
    verified_phone_label_enabled: false,
    responsive_web_graphql_timeline_navigation_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    creator_subscriptions_tweet_preview_api_enabled: true,
    tweetypie_unmention_optimization_enabled: true,
    responsive_web_edit_tweet_api_enabled: true,
    graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
    view_counts_everywhere_api_enabled: true,
    longform_notetweets_consumption_enabled: true,
    responsive_web_twitter_article_tweet_consumption_enabled: true,
    tweet_awards_web_tipping_enabled: false,
    longform_notetweets_rich_text_read_enabled: true,
    freedom_of_speech_not_reach_fetch_enabled: true,
    standardized_nudges_misinfo: true,
    responsive_web_enhance_cards_enabled: false,
  };

  let memorySaver = true;
  let pageToken = "";
  let seq = 0;
  let opsCache = null;
  const runtimeFeatures = {};
  let scanning = false;
  let abortCtrl = null;
  let chipTimer = null;

  const ui = {
    items: [],
    note: "",
    displayLimit: 80,
    filter: "",
    sort: "default",
    scannedAt: 0,
    selfHandle: "",
  };

  function makeError(code, message) {
    const err = new Error(message || core.messageForCode(code) || "扫描失败");
    err.code = code;
    return err;
  }

  function isFatal(code) {
    return code === "cancelled" || code === "not_logged_in" || code === "csrf" || code === "locked";
  }

  function delay(ms, signal) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(finish, ms);
      function finish() {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }
      function onAbort() {
        clearTimeout(timer);
        reject(makeError("cancelled"));
      }
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  function waitIfHidden(signal) {
    if (!memorySaver || !document.hidden) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        if (!document.hidden) done(true);
      }, 500);
      function onAbort() {
        done(false);
      }
      function onVis() {
        if (!document.hidden) done(true);
      }
      function done(ok) {
        clearInterval(timer);
        document.removeEventListener("visibilitychange", onVis);
        signal?.removeEventListener("abort", onAbort);
        if (ok) resolve();
        else reject(makeError("cancelled"));
      }
      document.addEventListener("visibilitychange", onVis);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  async function pause(signal) {
    await waitIfHidden(signal);
    const gap = memorySaver ? core.LIMITS.memorySaverGapMs : core.LIMITS.pageGapMs;
    await delay(gap, signal);
  }

  async function ensurePage() {
    const res = await chrome.runtime.sendMessage({ type: "INJECT_NONFOLLOW_PAGE" });
    if (!res?.ok) throw makeError("network", res?.error || "无法接入当前页面的登录态");
    pageToken = document.documentElement.getAttribute("data-xrh-nf") || "";
    if (!pageToken) throw makeError("network", "页面还没准备好。请刷新 x.com 后再扫描。");
  }

  function pageMessage(id, payload, signal, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        window.postMessage({ source: "xrh-nf-req", token: pageToken, id: id, op: "abort" }, location.origin);
        reject(makeError("network", "请求超时"));
      }, timeoutMs);
      function onMsg(event) {
        if (event.source !== window || event.origin !== location.origin) return;
        const data = event.data;
        if (!data || data.source !== "xrh-nf-res" || data.id !== id || data.token !== pageToken) return;
        cleanup();
        resolve(data);
      }
      function onAbort() {
        cleanup();
        window.postMessage({ source: "xrh-nf-req", token: pageToken, id: id, op: "abort" }, location.origin);
        reject(makeError("cancelled"));
      }
      function cleanup() {
        clearTimeout(timer);
        window.removeEventListener("message", onMsg);
        signal?.removeEventListener("abort", onAbort);
      }
      window.addEventListener("message", onMsg);
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      window.postMessage(
        Object.assign({ source: "xrh-nf-req", token: pageToken, id: id }, payload),
        location.origin
      );
    });
  }

  async function xGet(url, signal) {
    if (!core.isAllowedApiUrl(url, location.origin)) throw makeError("api", "已拦截非列表读取");
    const id = "f" + ++seq;
    const res = await pageMessage(id, { op: "fetch", url: url }, signal, 25000);
    if (res.error === "not_logged_in") throw makeError("not_logged_in");
    if (res.error === "AbortError") throw makeError("cancelled");
    if (res.error === "blocked_url") throw makeError("api", "已拦截非列表读取");
    const classified = core.classifyXError(res.status, res.text || "");
    if (classified.code === "missing_features") {
      const err = makeError("missing_features", classified.message);
      err.features = classified.features || [];
      throw err;
    }
    if (classified.code !== "ok") {
      const err = makeError(classified.code, core.messageForCode(classified.code) || classified.message);
      err.detail = classified.message;
      throw err;
    }
    try {
      return JSON.parse(res.text || "null");
    } catch {
      throw makeError("parse");
    }
  }

  async function tryStep(fn) {
    try {
      return { ok: true, value: await fn() };
    } catch (err) {
      if (isFatal(err?.code) || err?.code === "rate_limit") throw err;
      return { ok: false, error: err };
    }
  }

  async function loadOps(force) {
    if (opsCache && !force) return opsCache;
    if (!force) {
      const stored = await chrome.storage.local.get({ [OPS_KEY]: null });
      const cached = stored[OPS_KEY];
      if (cached?.queryIds?.Following && Date.now() - (cached.savedAt || 0) < 12 * 60 * 60 * 1000) {
        opsCache = cached;
        return opsCache;
      }
    }
    const id = "d" + ++seq;
    const res = await pageMessage(
      id,
      { op: "discover", need: ["Following", "Followers", "UserByScreenName", "Viewer"] },
      null,
      40000
    );
    const found = res?.found || {};
    opsCache = {
      savedAt: Date.now(),
      queryIds: Object.assign({}, FALLBACK_IDS, found.queryIds || {}),
      features: found.features || {},
    };
    chrome.storage.local.set({ [OPS_KEY]: opsCache }).catch(() => {});
    return opsCache;
  }

  function featuresFor(op) {
    const bag = Object.assign({}, DEFAULT_FEATURES, runtimeFeatures[op] || {});
    const names = opsCache?.features?.[op] || [];
    for (const name of names) bag[name] = true;
    return bag;
  }

  async function gql(op, variables, signal) {
    let lastError = null;
    let forceOps = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const ops = await loadOps(forceOps);
      forceOps = false;
      const queryId = ops.queryIds?.[op] || FALLBACK_IDS[op];
      if (!queryId) throw makeError("not_found");
      let features = featuresFor(op);
      let url = core.buildGraphqlUrl(location.origin, queryId, op, variables, features);
      if (url.length > 11000) {
        features = Object.assign({}, DEFAULT_FEATURES, runtimeFeatures[op] || {});
        url = core.buildGraphqlUrl(location.origin, queryId, op, variables, features);
      }
      try {
        return await xGet(url, signal);
      } catch (err) {
        lastError = err;
        if (err.code === "missing_features" && err.features?.length) {
          runtimeFeatures[op] = Object.assign({}, runtimeFeatures[op]);
          for (const name of err.features) runtimeFeatures[op][name] = true;
          continue;
        }
        if (err.code === "not_found" && attempt === 0) {
          opsCache = null;
          chrome.storage.local.remove(OPS_KEY).catch(() => {});
          forceOps = true;
          continue;
        }
        throw err;
      }
    }
    throw lastError || makeError("not_found");
  }

  async function getMe(signal) {
    const url = core.buildRestUrl(location.origin, "/i/api/1.1/account/verify_credentials.json", {
      include_entities: "false",
      skip_status: "true",
      include_email: "false",
    });
    try {
      const json = await xGet(url, signal);
      const me = core.normalizeAccount(json);
      if (me?.id) return me;
    } catch (err) {
      if (isFatal(err?.code) || err?.code === "rate_limit") throw err;
    }

    const handle = selfHandleFromDom();
    if (handle) {
      try {
        const json = await gql(
          "UserByScreenName",
          { screen_name: handle, withSafetyModeUserFields: true },
          signal
        );
        const me = core.parseViewer(json);
        if (me?.id) return me;
      } catch (err) {
        if (isFatal(err?.code) || err?.code === "rate_limit") throw err;
      }
    }

    try {
      const json = await gql("Viewer", { withCommunitiesMemberships: false }, signal);
      const me = core.parseViewer(json);
      if (me?.id) return me;
    } catch (err) {
      if (isFatal(err?.code) || err?.code === "rate_limit") throw err;
    }
    throw makeError("not_logged_in");
  }

  function selfHandleFromDom() {
    try {
      const profile = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
      const href = profile?.getAttribute("href") || "";
      const match = href.match(/^\/([A-Za-z0-9_]{1,15})\/?$/);
      if (match && !SKIP_HANDLES.has(match[1].toLowerCase())) return match[1];
    } catch {
      /* ignore */
    }
    try {
      const sw = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
      const at = (sw?.innerText || "").match(/@([A-Za-z0-9_]{1,15})/);
      if (at) return at[1];
    } catch {
      /* ignore */
    }
    return "";
  }

  function isOwnSocialPage() {
    const self = selfHandleFromDom();
    if (!self) return false;
    const path = location.pathname || "";
    const re = new RegExp("^/" + self + "(?:/(?:following|followers|verified_followers))?/?$", "i");
    return re.test(path);
  }

  async function fetchRestList(userId, cursor, signal) {
    const params = {
      user_id: userId,
      count: core.LIMITS.restPage,
      skip_status: "true",
      include_user_entities: "false",
      cursor: cursor || "-1",
    };
    try {
      const json = await xGet(
        core.buildRestUrl(location.origin, "/i/api/1.1/friends/list.json", params),
        signal
      );
      return core.parseRestListPage(json);
    } catch (err) {
      if (err.code !== "api") throw err;
      const json = await xGet(
        core.buildRestUrl(location.origin, "/i/api/1.1/friends/list.json", Object.assign({}, params, { count: 20 })),
        signal
      );
      return core.parseRestListPage(json);
    }
  }

  async function fetchIdPage(kind, userId, cursor, signal) {
    const path = kind === "followers" ? "/i/api/1.1/followers/ids.json" : "/i/api/1.1/friends/ids.json";
    const json = await xGet(
      core.buildRestUrl(location.origin, path, {
        user_id: userId,
        count: core.LIMITS.idsPage,
        stringify_ids: "true",
        cursor: cursor || "-1",
      }),
      signal
    );
    return core.parseRestIdsPage(json);
  }

  async function fetchGqlPage(op, userId, cursor, signal) {
    const json = await gql(op, core.followingVariables(userId, core.LIMITS.gqlPage, cursor), signal);
    return core.parseTimelinePage(json);
  }

  function pushUsers(bucket, users, me, cap) {
    for (const user of core.excludeSelf(users, me)) {
      if (!user?.id || bucket.seen.has(user.id)) continue;
      if (bucket.users.length >= cap) return true;
      bucket.seen.add(user.id);
      bucket.users.push(user);
    }
    return bucket.users.length >= cap;
  }

  function pushIds(list, seen, ids, me, cap) {
    for (const id of ids || []) {
      if (!id || id === String(me.id) || seen.has(id)) continue;
      if (list.length >= cap) return true;
      seen.add(id);
      list.push(id);
    }
    return list.length >= cap;
  }

  function signaledItems(bucket) {
    const mode = core.signalMode(bucket.users);
    return core.trimStoredItems(core.selectNonMutual(bucket.users, mode));
  }

  async function paginateSignaled(kind, me, firstPage, cap, signal, hooks) {
    const bucket = { users: [], seen: new Set() };
    let page = firstPage;
    let prevCursor = kind === "rest" ? "-1" : "";
    let emptyStreak = 0;
    let truncated = false;
    let stopReason = "done";
    let guard = 0;

    while (guard++ < 500) {
      const reached = pushUsers(bucket, page.users, me, cap);
      const mode = core.signalMode(bucket.users);
      const items = signaledItems(bucket);
      hooks.onProgress({
        phase: "following",
        followingScanned: bucket.users.length,
        followersScanned: null,
        found: items.length,
        items: items,
      });
      if (reached) {
        truncated = !(Number.isFinite(me.followingCount) && me.followingCount <= bucket.users.length);
        stopReason = truncated ? "cap" : "done";
        break;
      }
      const decision = core.nextPageDecision(prevCursor, page, emptyStreak);
      if (decision.stop) {
        truncated = decision.truncated;
        if (decision.reason === "empty_pages") stopReason = "empty_pages";
        break;
      }
      emptyStreak = decision.emptyStreak;
      prevCursor = page.cursor;
      await pause(signal);
      page = kind === "rest"
        ? await fetchRestList(me.id, page.cursor, signal)
        : await fetchGqlPage("Following", me.id, page.cursor, signal);
    }

    const mode = core.signalMode(bucket.users);
    return {
      me: me,
      items: signaledItems(bucket),
      mode: mode === "none" ? "boolean" : mode,
      followingScanned: bucket.users.length,
      followersScanned: null,
      followingTruncated: truncated,
      followersTruncated: false,
      stopReason: stopReason,
    };
  }

  async function paginateIds(kind, me, firstPage, cap, signal, hooks, onCount) {
    const list = [];
    const seen = new Set();
    let page = firstPage;
    let prevCursor = "-1";
    let emptyStreak = 0;
    let truncated = false;
    let guard = 0;
    while (guard++ < 80) {
      const reached = pushIds(list, seen, page.ids, me, cap);
      onCount(list.length);
      if (reached) {
        const known = kind === "friends" ? me.followingCount : me.followersCount;
        truncated = !(Number.isFinite(known) && known <= list.length);
        break;
      }
      const decision = core.nextPageDecision(prevCursor, { ids: page.ids, cursor: page.cursor, terminated: page.terminated }, emptyStreak);
      if (decision.stop) {
        truncated = decision.truncated;
        break;
      }
      emptyStreak = decision.emptyStreak;
      prevCursor = page.cursor;
      await pause(signal);
      page = await fetchIdPage(kind, me.id, page.cursor, signal);
    }
    return { ids: list, truncated: truncated };
  }

  async function lookupUsers(ids, signal, hooks, progress) {
    const users = [];
    const batch = core.LIMITS.lookupBatch;
    for (let i = 0; i < ids.length; i += batch) {
      if (i > 0) await pause(signal);
      const slice = ids.slice(i, i + batch);
      try {
        const json = await xGet(
          core.buildRestUrl(location.origin, "/i/api/1.1/users/lookup.json", {
            user_id: slice.join(","),
            include_entities: "false",
          }),
          signal
        );
        const parsed = core.parseLookupUsers(json);
        const byId = new Map(parsed.map((user) => [user.id, user]));
        for (const id of slice) {
          users.push(byId.get(id) || { id: id, handle: "", name: "", avatar: "", followersCount: null, protected: false });
        }
      } catch (err) {
        if (isFatal(err?.code) || err?.code === "rate_limit") throw err;
        for (const id of slice) {
          users.push({ id: id, handle: "", name: "", avatar: "", followersCount: null, protected: false });
        }
      }
      hooks.onProgress(Object.assign({}, progress, { phase: "lookup", found: users.length, items: core.trimStoredItems(users) }));
    }
    return users;
  }

  async function completeIdDiff(me, friendsPage, followersPage, cap, signal, hooks) {
    hooks.onProgress({
      phase: "following",
      followingScanned: 0,
      followersScanned: 0,
      found: 0,
      items: [],
    });
    const friends = await paginateIds("friends", me, friendsPage, cap, signal, hooks, (count) => {
      hooks.onProgress({
        phase: "following",
        followingScanned: count,
        followersScanned: 0,
        found: 0,
        items: ui.items,
      });
    });
    const followerCap = Math.min(
      core.followerIdCeiling(cap),
      Number.isFinite(me.followersCount) && me.followersCount > 0 ? me.followersCount : core.LIMITS.followerIdCap
    );
    const followers = await paginateIds("followers", me, followersPage, followerCap, signal, hooks, (count) => {
      hooks.onProgress({
        phase: "followers",
        followingScanned: friends.ids.length,
        followersScanned: count,
        found: 0,
        items: ui.items,
      });
    });
    if (!friends.ids.length && Number(me.followingCount) > 0) throw makeError("parse");
    const missing = core.diffIds(friends.ids, new Set(followers.ids));
    const users = missing.length ? await lookupUsers(missing, signal, hooks, {
      followingScanned: friends.ids.length,
      followersScanned: followers.ids.length,
    }) : [];
    return {
      me: me,
      items: core.trimStoredItems(users),
      mode: "id_diff",
      followingScanned: friends.ids.length,
      followersScanned: followers.ids.length,
      followingTruncated: friends.truncated,
      followersTruncated: followers.truncated,
      stopReason: friends.truncated || followers.truncated ? "cap" : "done",
    };
  }

  async function scan(signal, hooks) {
    const cap = hooks.cap;
    const me = await getMe(signal);
    ui.selfHandle = me.handle || "";
    if (me.followingCount === 0) {
      return {
        me: me,
        items: [],
        mode: "boolean",
        followingScanned: 0,
        followersScanned: null,
        followingTruncated: false,
        followersTruncated: false,
        stopReason: "done",
      };
    }

    const listFirst = await tryStep(() => fetchRestList(me.id, "-1", signal));
    if (listFirst.ok && core.signalMode(listFirst.value.users) !== "none") {
      return paginateSignaled("rest", me, listFirst.value, cap, signal, hooks);
    }

    const idsProbe = await tryStep(async () => {
      const following = await fetchIdPage("friends", me.id, "-1", signal);
      await pause(signal);
      const followers = await fetchIdPage("followers", me.id, "-1", signal);
      return { following: following, followers: followers };
    });
    if (idsProbe.ok) {
      return completeIdDiff(me, idsProbe.value.following, idsProbe.value.followers, cap, signal, hooks);
    }

    const gqlFirst = await tryStep(() => fetchGqlPage("Following", me.id, "", signal));
    if (gqlFirst.ok && core.signalMode(gqlFirst.value.users) !== "none") {
      return paginateSignaled("gql", me, gqlFirst.value, cap, signal, hooks);
    }

    const followerGql = await tryStep(() => fetchGqlPage("Followers", me.id, "", signal));
    if ((listFirst.ok || gqlFirst.ok) && followerGql.ok) {
      const bucket = { users: [], seen: new Set() };
      let sourcePage = listFirst.ok ? listFirst.value : gqlFirst.value;
      let kind = listFirst.ok ? "rest" : "gql";
      let prevCursor = kind === "rest" ? "-1" : "";
      let emptyStreak = 0;
      let guard = 0;
      let followingTruncated = false;
      while (guard++ < 500) {
        if (pushUsers(bucket, sourcePage.users, me, cap)) {
          followingTruncated = !(Number.isFinite(me.followingCount) && me.followingCount <= bucket.users.length);
          break;
        }
        hooks.onProgress({
          phase: "following",
          followingScanned: bucket.users.length,
          followersScanned: 0,
          found: 0,
          items: [],
        });
        const decision = core.nextPageDecision(prevCursor, sourcePage, emptyStreak);
        if (decision.stop) {
          followingTruncated = decision.truncated;
          break;
        }
        emptyStreak = decision.emptyStreak;
        prevCursor = sourcePage.cursor;
        await pause(signal);
        sourcePage = kind === "rest"
          ? await fetchRestList(me.id, sourcePage.cursor, signal)
          : await fetchGqlPage("Following", me.id, sourcePage.cursor, signal);
      }

      const followerIds = new Set();
      let followerPage = followerGql.value;
      let followerPrev = "";
      let followerEmpty = 0;
      let followersTruncated = false;
      let followerGuard = 0;
      const followerCap = core.followerIdCeiling(cap);
      while (followerGuard++ < 500 && followerIds.size < followerCap) {
        for (const user of followerPage.users || []) {
          if (user?.id) followerIds.add(user.id);
          if (followerIds.size >= followerCap) break;
        }
        hooks.onProgress({
          phase: "followers",
          followingScanned: bucket.users.length,
          followersScanned: followerIds.size,
          found: 0,
          items: [],
        });
        if (followerIds.size >= followerCap) {
          followersTruncated = !(Number.isFinite(me.followersCount) && me.followersCount <= followerIds.size);
          break;
        }
        const decision = core.nextPageDecision(followerPrev, followerPage, followerEmpty);
        if (decision.stop) {
          followersTruncated = decision.truncated;
          break;
        }
        followerEmpty = decision.emptyStreak;
        followerPrev = followerPage.cursor;
        await pause(signal);
        followerPage = await fetchGqlPage("Followers", me.id, followerPage.cursor, signal);
      }
      const missing = new Set(core.diffIds(bucket.users.map((user) => user.id), followerIds));
      const items = core.trimStoredItems(bucket.users.filter((user) => missing.has(user.id)));
      return {
        me: me,
        items: items,
        mode: "id_diff",
        followingScanned: bucket.users.length,
        followersScanned: followerIds.size,
        followingTruncated: followingTruncated,
        followersTruncated: followersTruncated,
        stopReason: followingTruncated || followersTruncated ? "cap" : "done",
      };
    }

    throw makeError("no_signal");
  }

  function buildNote(result) {
    const bits = [];
    if (result.stopReason === "cancelled") bits.push(core.messageForCode("cancelled"));
    if (result.stopReason === "rate_limit") bits.push(core.messageForCode("rate_limit"));
    if (result.stopReason === "empty_pages" || result.followingTruncated && result.stopReason === "empty_pages") {
      bits.push("关注列表后段出现连续空页，可能没扫全。");
    }
    if (result.followingTruncated && result.stopReason !== "empty_pages") {
      bits.push("关注超过上限，只扫了前 " + result.followingScanned + " 个。可在设置里提高上限。");
    }
    if (result.followersTruncated) {
      bits.push("粉丝没有对完。没出现在已扫粉丝里的人会显示为未回关，可能把已回关的人算进来。");
    }
    if (result.mode === "boolean" || result.mode === "badge") {
      bits.push("回关与否来自关注列表上的标记，没有逐个打开主页，也不会自动取关。");
    } else if (result.mode === "id_diff") {
      bits.push("用已扫到的关注减去粉丝得到。只读，不会自动取关。");
    }
    if (result.me?.protected) bits.push("当前账号受保护，列表以这次登录态能看到的为准。");
    return bits.filter(Boolean).join("");
  }

  function progressLine(progress) {
    const fans = progress.followersScanned == null ? "—（标记判断）" : String(progress.followersScanned);
    const found = progress.found == null ? "" : " · 未回关 " + progress.found;
    return "已扫关注 " + (progress.followingScanned || 0) + " / 粉丝 " + fans + found;
  }

  async function readCap() {
    const stored = await chrome.storage.local.get({ [CAP_KEY]: core.LIMITS.defaultCap });
    return core.clampCap(stored[CAP_KEY]);
  }

  function snapshotFrom(result) {
    return {
      version: core.LIMITS.storageVersion,
      scannedAt: Date.now(),
      self: {
        id: result.me?.id || "",
        handle: result.me?.handle || "",
        name: result.me?.name || "",
      },
      followingScanned: result.followingScanned || 0,
      followersScanned: result.followersScanned,
      followingTruncated: !!result.followingTruncated,
      followersTruncated: !!result.followersTruncated,
      mode: result.mode || "",
      partial: result.stopReason === "cancelled" || result.stopReason === "rate_limit",
      stopReason: result.stopReason || "done",
      cap: result.cap || core.LIMITS.defaultCap,
      items: core.trimStoredItems(result.items || []),
      note: buildNote(result),
    };
  }

  async function persist(result, cap) {
    const stored = snapshotFrom(result);
    stored.cap = cap;
    stored.note = buildNote(result);
    await chrome.storage.local.set({ [STORAGE_KEY]: stored });
    return stored;
  }

  function formatWhen(ts) {
    if (!ts) return "";
    const date = new Date(ts);
    const p = (n) => String(n).padStart(2, "0");
    return (
      date.getFullYear() +
      "-" +
      p(date.getMonth() + 1) +
      "-" +
      p(date.getDate()) +
      " " +
      p(date.getHours()) +
      ":" +
      p(date.getMinutes())
    );
  }

  function ensurePanel() {
    let root = document.getElementById("xrh-nf-root");
    if (root) return root;
    root = document.createElement("div");
    root.id = "xrh-nf-root";
    root.className = "xrh-nf";
    root.hidden = true;

    const head = document.createElement("div");
    head.className = "xrh-nf-head";
    const title = document.createElement("div");
    title.className = "xrh-nf-title";
    title.textContent = "未回关";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "xrh-nf-icon";
    close.textContent = "×";
    close.title = "收起";
    close.addEventListener("click", () => {
      root.hidden = true;
    });
    head.appendChild(title);
    head.appendChild(close);

    const hint = document.createElement("p");
    hint.className = "xrh-nf-hint";
    hint.textContent = "只列出你关注、对方未回关的账号。可以打开主页，不会自动取关或关注。收起面板不会停止扫描，要停请点「停止」。";

    const actions = document.createElement("div");
    actions.className = "xrh-nf-actions";
    const scanBtn = document.createElement("button");
    scanBtn.type = "button";
    scanBtn.className = "xrh-nf-primary";
    scanBtn.dataset.xrhNf = "scan";
    scanBtn.textContent = "扫描未回关";
    const stopBtn = document.createElement("button");
    stopBtn.type = "button";
    stopBtn.className = "xrh-nf-ghost";
    stopBtn.dataset.xrhNf = "stop";
    stopBtn.textContent = "停止";
    stopBtn.disabled = true;
    const exportBtn = document.createElement("button");
    exportBtn.type = "button";
    exportBtn.className = "xrh-nf-ghost";
    exportBtn.textContent = "导出";
    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "xrh-nf-ghost";
    clearBtn.textContent = "清空";
    actions.appendChild(scanBtn);
    actions.appendChild(stopBtn);
    actions.appendChild(exportBtn);
    actions.appendChild(clearBtn);

    const status = document.createElement("div");
    status.className = "xrh-nf-status";
    status.dataset.xrhNf = "status";

    const tools = document.createElement("div");
    tools.className = "xrh-nf-tools";
    const filter = document.createElement("input");
    filter.type = "search";
    filter.className = "xrh-nf-filter";
    filter.placeholder = "筛选名字或 @";
    filter.setAttribute("aria-label", "筛选未回关");
    const sort = document.createElement("select");
    sort.className = "xrh-nf-sort";
    sort.setAttribute("aria-label", "排序");
    const optDefault = document.createElement("option");
    optDefault.value = "default";
    optDefault.textContent = "默认顺序";
    const optFans = document.createElement("option");
    optFans.value = "followers";
    optFans.textContent = "粉丝多到少";
    sort.appendChild(optDefault);
    sort.appendChild(optFans);
    tools.appendChild(filter);
    tools.appendChild(sort);

    const list = document.createElement("div");
    list.className = "xrh-nf-list";
    list.dataset.xrhNf = "list";

    const more = document.createElement("button");
    more.type = "button";
    more.className = "xrh-nf-more";
    more.dataset.xrhNf = "more";
    more.hidden = true;
    more.textContent = "再显示一批";

    root.appendChild(head);
    root.appendChild(hint);
    root.appendChild(actions);
    root.appendChild(status);
    root.appendChild(tools);
    root.appendChild(list);
    root.appendChild(more);

    root.addEventListener("mousedown", (event) => event.stopPropagation());
    root.addEventListener("click", (event) => event.stopPropagation());

    scanBtn.addEventListener("click", () => startScan());
    stopBtn.addEventListener("click", () => abortCtrl?.abort());
    exportBtn.addEventListener("click", () => {
      if (!ui.items.length) {
        setStatus("没有可导出的结果。", "");
        return;
      }
      const blob = new Blob([core.toCsv(ui.items)], { type: "text/csv;charset=utf-8" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = "xrh-nonfollow.csv";
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1500);
    });
    clearBtn.addEventListener("click", async () => {
      if (!confirm("清空本机保存的未回关结果？")) return;
      ui.items = [];
      ui.note = "";
      ui.scannedAt = 0;
      await chrome.storage.local.remove(STORAGE_KEY);
      syncList(true);
      setStatus("已清空。", "ok");
    });
    let filterTimer = null;
    filter.addEventListener("input", () => {
      if (filterTimer) clearTimeout(filterTimer);
      filterTimer = setTimeout(() => {
        ui.filter = filter.value || "";
        syncList(true);
      }, 160);
    });
    sort.addEventListener("change", () => {
      ui.sort = sort.value || "default";
      syncList(true);
    });
    more.addEventListener("click", () => {
      ui.displayLimit += 80;
      syncList(true);
    });

    document.documentElement.appendChild(root);
    return root;
  }

  function setStatus(text, kind) {
    const root = ensurePanel();
    const status = root.querySelector('[data-xrh-nf="status"]');
    if (!status) return;
    status.textContent = text || "";
    status.className = "xrh-nf-status" + (kind ? " " + kind : "");
  }

  function setScanning(on) {
    scanning = on;
    const root = document.getElementById("xrh-nf-root");
    if (!root) return;
    const scanBtn = root.querySelector('[data-xrh-nf="scan"]');
    const stopBtn = root.querySelector('[data-xrh-nf="stop"]');
    if (scanBtn) scanBtn.disabled = on;
    if (stopBtn) stopBtn.disabled = !on;
  }

  function rowFor(item) {
    const row = document.createElement("div");
    row.className = "xrh-nf-item";
    row.dataset.id = item.id;
    if (item.avatar) {
      const img = document.createElement("img");
      img.className = "xrh-nf-avatar";
      img.alt = "";
      img.referrerPolicy = "no-referrer";
      img.src = item.avatar;
      row.appendChild(img);
    } else {
      const ph = document.createElement("div");
      ph.className = "xrh-nf-avatar xrh-nf-ph";
      ph.textContent = (item.name || item.handle || "?").slice(0, 1);
      row.appendChild(ph);
    }
    const body = document.createElement("div");
    body.className = "xrh-nf-body";
    const name = document.createElement("div");
    name.className = "xrh-nf-name";
    name.textContent = item.name || item.handle || item.id;
    const meta = document.createElement("div");
    meta.className = "xrh-nf-meta";
    const fans = item.followersCount == null ? "" : " · 粉丝 " + core.formatCount(item.followersCount);
    const lock = item.protected ? " · 保护" : "";
    meta.textContent = (item.handle ? "@" + item.handle : "ID " + item.id) + fans + lock;
    const link = document.createElement("a");
    link.className = "xrh-nf-link";
    link.href = core.profileUrl(item);
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "打开主页";
    body.appendChild(name);
    body.appendChild(meta);
    body.appendChild(link);
    row.appendChild(body);
    return row;
  }

  function syncList(force) {
    const root = ensurePanel();
    const host = root.querySelector('[data-xrh-nf="list"]');
    const more = root.querySelector('[data-xrh-nf="more"]');
    if (!host) return;
    const view = core.sortItems(
      ui.items.filter((item) => core.matchesFilter(item, ui.filter)),
      ui.sort
    );
    const slice = view.slice(0, ui.displayLimit);
    if (force || ui.filter || ui.sort !== "default") {
      host.replaceChildren();
      for (const item of slice) host.appendChild(rowFor(item));
    } else {
      const have = new Set([...host.querySelectorAll("[data-id]")].map((node) => node.dataset.id));
      for (const item of slice) {
        if (have.has(item.id)) continue;
        host.appendChild(rowFor(item));
      }
    }
    if (!slice.length) {
      if (!host.querySelector(".xrh-nf-empty")) {
        const empty = document.createElement("div");
        empty.className = "xrh-nf-empty";
        empty.textContent = scanning ? "扫描开始后，未回关会显示在这里。" : "暂无名单。";
        if (!host.children.length) host.appendChild(empty);
      }
    } else {
      host.querySelector(".xrh-nf-empty")?.remove();
    }
    if (more) {
      more.hidden = view.length <= slice.length;
      more.textContent = "再显示一批（" + slice.length + "/" + view.length + "）";
    }
  }

  function applyStored(stored) {
    if (!core.isStoredResult(stored)) return;
    ui.items = core.trimStoredItems(stored.items);
    ui.note = stored.note || "";
    ui.scannedAt = stored.scannedAt || 0;
    ui.selfHandle = stored.self?.handle || "";
    const when = formatWhen(stored.scannedAt);
    const head = stored.items.length
      ? "上次结果 " + stored.items.length + " 个未回关" + (when ? " · " + when : "")
      : "上次扫描没有未回关" + (when ? " · " + when : "");
    setStatus(head + (stored.note ? "\n" + stored.note : ""), stored.partial ? "" : "ok");
    syncList(true);
  }

  async function openPanel() {
    const root = ensurePanel();
    root.hidden = false;
    root.classList.remove("xrh-nf-hide");
    if (!ui.items.length && !scanning) {
      const stored = await chrome.storage.local.get({ [STORAGE_KEY]: null });
      if (core.isStoredResult(stored[STORAGE_KEY])) applyStored(stored[STORAGE_KEY]);
      else setStatus("点「扫描未回关」。需要这个浏览器已经登录 x.com。", "");
    }
  }

  async function startScan() {
    if (scanning) {
      openPanel();
      return;
    }
    await openPanel();
    const cap = await readCap();
    abortCtrl = new AbortController();
    setScanning(true);
    ui.items = [];
    ui.displayLimit = 80;
    ui.note = "";
    const root = ensurePanel();
    root.querySelector('[data-xrh-nf="list"]')?.replaceChildren();
    setStatus("正在确认登录…\n已扫关注 0 / 粉丝 0\n上限 " + cap + "。页与页之间会停一下，避免把 X 打限流。", "");
    let lastProgress = { followingScanned: 0, followersScanned: null };
    try {
      await ensurePage();
      const result = await scan(abortCtrl.signal, {
        cap: cap,
        onProgress(progress) {
          lastProgress = progress;
          if (Array.isArray(progress.items)) ui.items = progress.items;
          setStatus(progressLine(progress), "");
          syncList(false);
        },
      });
      result.cap = cap;
      const stored = await persist(result, cap);
      ui.items = stored.items;
      ui.scannedAt = stored.scannedAt;
      ui.note = stored.note;
      const headline = stored.items.length
        ? "未回关 " + stored.items.length + " 个"
        : "这次扫描范围内没有未回关。";
      setStatus(headline + "\n" + progressLine({
        followingScanned: result.followingScanned,
        followersScanned: result.followersScanned,
        found: stored.items.length,
      }) + (stored.note ? "\n" + stored.note : ""), "ok");
      syncList(true);
    } catch (err) {
      const code = err?.code || "api";
      if ((code === "cancelled" || code === "rate_limit") && ui.items.length) {
        const partial = {
          me: { id: "", handle: ui.selfHandle, name: "" },
          items: ui.items,
          mode: lastProgress.followersScanned == null ? "boolean" : "id_diff",
          followingScanned: lastProgress.followingScanned || ui.items.length,
          followersScanned: lastProgress.followersScanned,
          followingTruncated: true,
          followersTruncated: !!lastProgress.followersTruncated,
          stopReason: code,
          cap: cap,
        };
        const stored = await persist(partial, cap);
        ui.note = stored.note;
        setStatus((core.messageForCode(code) || err.message) + (stored.note ? "\n" + stored.note : ""), code === "rate_limit" ? "error" : "");
        syncList(true);
      } else {
        setStatus(
          core.messageForCode(code) || err?.message || "扫描失败",
          code === "cancelled" ? "" : "error"
        );
      }
    } finally {
      setScanning(false);
      abortCtrl = null;
    }
  }

  function syncChip() {
    if (document.hidden && memorySaver) return;
    let chip = document.getElementById("xrh-nf-chip");
    if (!isOwnSocialPage()) {
      chip?.remove();
      return;
    }
    if (chip) return;
    chip = document.createElement("button");
    chip.id = "xrh-nf-chip";
    chip.type = "button";
    chip.className = "xrh-nf-chip";
    chip.textContent = "未回关";
    chip.title = "查看你关注但未回关的账号（只读）";
    chip.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openPanel();
    });
    document.documentElement.appendChild(chip);
  }

  let chipTries = 0;

  function looksLikeProfilePath() {
    const match = (location.pathname || "").match(
      /^\/([A-Za-z0-9_]{1,15})(?:\/(?:following|followers|verified_followers))?\/?$/
    );
    if (!match) return false;
    return !SKIP_HANDLES.has(match[1].toLowerCase());
  }

  function scheduleChip(fromNav) {
    if (fromNav) chipTries = 0;
    if (chipTimer) clearTimeout(chipTimer);
    chipTimer = setTimeout(() => {
      chipTimer = null;
      syncChip();
      if (!document.getElementById("xrh-nf-chip") && chipTries < 8 && looksLikeProfilePath()) {
        chipTries += 1;
        scheduleChip(false);
      }
    }, 700);
  }

  function hookHistory() {
    if (history.__xrhNfHook) return;
    history.__xrhNfHook = true;
    const wrap = (fn) =>
      function () {
        const ret = fn.apply(this, arguments);
        scheduleChip(true);
        return ret;
      };
    history.pushState = wrap(history.pushState);
    history.replaceState = wrap(history.replaceState);
    window.addEventListener("popstate", () => scheduleChip(true));
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "OPEN_NONFOLLOW") {
      openPanel();
      sendResponse({ ok: true });
      return false;
    }
    return undefined;
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const root = document.getElementById("xrh-nf-root");
    if (!root || root.hidden) return;
    root.hidden = true;
  });

  window.addEventListener("pagehide", () => {
    if (abortCtrl) abortCtrl.abort();
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) scheduleChip(true);
  });

  chrome.storage.sync.get({ memorySaver: true }, (data) => {
    memorySaver = data.memorySaver !== false;
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.memorySaver) memorySaver = changes.memorySaver.newValue !== false;
  });

  hookHistory();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => scheduleChip(true), { once: true });
  } else {
    scheduleChip(true);
  }
})();
