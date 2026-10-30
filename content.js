/**
 * X 回复助手 - content script
 * 回复框旁闪电一键；草稿面板固定右下角。
 * 抓取线程上文 + 同作者可见帖；同帖缓存；可选自动填入第 1 条。
 * 「多角度」最多 5 条可选草稿；通知/提及页「今日待回」尽力抓取。
 * 草稿评价（满意/不行）写入本地；硬过滤踩雷近重复 + 理由规则。
 * 可选：回复发送后给原帖点赞（默认关）；快速模式加速生成。
 * 当前帖高亮 + 自动生成「下一条」指引。
 * 楼中楼：回某条评论时带线程上下文；写完即赞仍点原帖。
 * v1.5.1：大幅降低 DOM 扫描（浅层 MutationObserver / 可视区「回这条」/ 防抖），缓解 x.com 卡顿。
 * v1.5.2：省内存模式默认开；标签隐藏断开 MutationObserver；WeakMap/上限/截断；滚动 rAF 合并指引。
 * 不会自动发帖或提交回复。
 */

(() => {
  if (window.__XRH_INIT__) return;
  window.__XRH_INIT__ = true;

  const ROOT_ID = "xrh-root";
  const TB_BTN_ID = "xrh-toolbar-btn";
  const TB_CLASS = "xrh-toolbar-ai";

  let lastUrl = location.href;
  let generating = false;
  let mountTimer = null;
  let autoTimer = null;
  let observer = null;
  let autoGenerateEnabled = false;
  let cacheEnabled = true;
  let autoFillFirst = false;
  let commentLimit = 15;
  let likeAfterReply = false;
  let fastMode = true;
  let qualityFirst = false;
  /** Prefer lower retained heap / fewer DOM hooks (default on) */
  let memorySaver = true;
  /** statusId we intend to like after a successful reply send */
  let pendingLikeStatusId = "";
  let likeInFlight = false;
  let replyHookInstalled = false;
  /** @type {Set<string>} */
  const autoDoneKeys = new Set();
  const AUTO_DONE_CAP = 40;
  let autoPausedUntil = 0; // rate-limit cool-down (ms epoch)
  let lastRenderedKey = "";
  /** @type {string[]} */
  let currentDrafts = [];
  let currentDraftIndex = 0;
  /** @type {{postSnippet:string, modes:string[], multiAngle:boolean}} */
  let lastGenContext = { postSnippet: "", modes: [], multiAngle: false };
  /** @type {Element|null} */
  let highlightedArticle = null;
  /** @type {Element|null} */
  let nextAutoGuideArticle = null;
  /** @type {Element|null} */
  let highlightedCommentArticle = null;
  /** Active楼中楼 target; null = reply to root post */
  let activeReplyToComment = null;
  let replyThisInjectTimer = null;
  let sourceLabelTimer = null;
  let activePersonaId = "default";
  /** @type {{id:string,label:string}[]} */
  let personaPresets = [];

  /** Perf: pause MutationObserver while we walk/mutate DOM */
  let observerPaused = false;
  /** @type {IntersectionObserver|null} */
  let replyThisIO = null;
  /** Articles already observed for「回这条」 */
  const replyThisObserved = new WeakSet();
  /** article →「回这条」button (WeakMap so detached nodes can GC) */
  const replyThisBtnByArticle = new WeakMap();
  let mountIdleHandle = null;
  let lastInboxScrapeAt = 0;
  let lastGuideUpdateAt = 0;
  let scrollGuideTimer = null;
  let guideRaf = 0;
  let scrollFastUntil = 0;
  const MOUNT_DEBOUNCE_MS = 420;
  const INJECT_DEBOUNCE_MS = 450;
  const SCROLL_THROTTLE_MS = 500;
  const INBOX_SCRAPE_MIN_MS = 4500;
  const REPLY_THIS_MAX_DEFAULT = 15;
  const REPLY_THIS_MAX_SAVER = 8;
  const TEXT_CAP_POST = 2000;
  const TEXT_CAP_COMMENT = 400;
  function replyThisMax() {
    return memorySaver ? REPLY_THIS_MAX_SAVER : REPLY_THIS_MAX_DEFAULT;
  }
  function capAutoDoneKeys() {
    if (autoDoneKeys.size <= AUTO_DONE_CAP) return;
    const keep = [...autoDoneKeys].slice(-Math.floor(AUTO_DONE_CAP / 2));
    autoDoneKeys.clear();
    keep.forEach((k) => autoDoneKeys.add(k));
  }
  function truncText(s, n) {
    const t = String(s || "");
    return t.length > n ? t.slice(0, n) : t;
  }

  function isStatusPage() {
    return /\/(?:i\/web\/)?status\/\d+/i.test(location.pathname) ||
      /\/[^/]+\/status\/\d+/i.test(location.pathname);
  }

  function isReplyContext() {
    if (isStatusPage()) return true;
    if (/\/compose\//i.test(location.pathname)) return true;
    if (document.querySelector('[data-testid="tweetTextarea_0"], [data-testid="toolBar"]')) {
      if (document.querySelector('article[data-testid="tweet"], div[data-testid="tweetText"]')) return true;
    }
    return false;
  }

  function qs(sel, root = document) {
    return root.querySelector(sel);
  }

  function qsa(sel, root = document) {
    return Array.from(root.querySelectorAll(sel));
  }

  function getArticleNodes() {
    return qsa('article[data-testid="tweet"]');
  }

  function extractTweetText(article) {
    if (!article) return "";
    const all = qsa('div[data-testid="tweetText"]', article);
    const own = all.filter((el) => !el.closest('[role="link"]'));
    return (own.length ? own : all)
      .map((el) => (el.innerText || el.textContent || "").trim())
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  function extractQuotedText(article) {
    if (!article) return "";
    const quoted = qsa('div[data-testid="tweetText"]', article).filter((el) =>
      el.closest('[role="link"]')
    );
    return quoted
      .map((el) => (el.innerText || el.textContent || "").trim())
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  function extractAuthor(article) {
    if (!article) return "";
    const user = qs('[data-testid="User-Name"]', article);
    return (user?.innerText || "").replace(/\s+/g, " ").trim();
  }

  const SKIP_HANDLES = new Set([
    "home", "explore", "search", "i", "settings", "messages", "notifications",
    "compose", "login", "signup", "tos", "privacy", "intent", "share", "hashtag",
  ]);

  function extractHandle(article) {
    if (!article) return "";
    const nameRoot = qs('[data-testid="User-Name"]', article) || article;
    const links = qsa("a[href]", nameRoot);
    for (const a of links) {
      const href = (a.getAttribute("href") || "").split("?")[0];
      const m = href.match(/^\/([A-Za-z0-9_]{1,15})(?:\/)?$/);
      if (!m) continue;
      const h = m[1];
      if (SKIP_HANDLES.has(h.toLowerCase())) continue;
      return h;
    }
    const text = extractAuthor(article);
    const at = text.match(/@([A-Za-z0-9_]{1,15})/);
    return at ? at[1] : "";
  }

  function parseCount(raw) {
    const s = String(raw || "").trim().replace(/,/g, "").toLowerCase();
    const m = s.match(/(\d+(?:\.\d+)?)\s*([kmb])?/);
    if (!m) return 0;
    const n = parseFloat(m[1]);
    const mult = m[2] === "k" ? 1e3 : m[2] === "m" ? 1e6 : m[2] === "b" ? 1e9 : 1;
    return Math.round(n * mult);
  }

  function extractLikeCount(article) {
    if (!article) return 0;
    const like = qs('[data-testid="like"]', article);
    if (!like) return 0;
    const aria = like.getAttribute("aria-label") || "";
    const text = (like.innerText || like.textContent || "").trim();
    const raw = `${aria} ${text}`.trim();
    const m = raw.match(/([\d,.]+\s*[kmb]?)\s*(?:likes?|喜欢|点赞|次喜欢)/i);
    if (m) return parseCount(m[1]);
    const fallback = text.match(/([\d,.]+\s*[kmb]?)/i);
    return fallback ? parseCount(fallback[1]) : 0;
  }

  function normalizeCommentText(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, "")
      .replace(/@[a-z0-9_]{1,15}/gi, "")
      .replace(/[\s\p{P}\p{S}]/gu, "");
  }

  function isLowInfoComment(text) {
    const t = String(text || "").trim();
    if (!t) return true;
    if (t.length <= 4) return true;
    return /^(?:确实|太真实了?|真实|哈哈+|笑死|同感|支持|说得对|太对了|好文|收藏了?|mark|\+1|同意|牛|牛逼|厉害了|学到了|谢谢分享)[\s!！。.,，~～]*$/i.test(t);
  }

  function similarComment(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    if (a.length >= 20 && b.length >= 20) {
      if (a.slice(0, 30) === b.slice(0, 30)) return true;
      if (a.includes(b) || b.includes(a)) return true;
    }
    return false;
  }

  /**
   * 评论区不是越多越好：作者回复优先，其次点赞，再其次提问；
   * 去重、去低信息、同一人最多两条。
   */
  function pickComments(candidates, limit) {
    const max = Math.max(3, Math.min(30, Number(limit) || 15));
    const out = [];
    const seen = [];
    const perHandle = new Map();
    const sorted = [...candidates].sort(
      (a, b) =>
        (b.isAuthor ? 1 : 0) - (a.isAuthor ? 1 : 0) ||
        (b.likes || 0) - (a.likes || 0) ||
        (b.isQuestion ? 1 : 0) - (a.isQuestion ? 1 : 0) ||
        (a.pos || 0) - (b.pos || 0)
    );
    for (const c of sorted) {
      if (out.length >= max) break;
      if (c.low && !c.isAuthor) continue;
      const norm = normalizeCommentText(c.text);
      if (!norm || norm.length < 4) continue;
      if (seen.some((s) => similarComment(s, norm))) continue;
      const h = (c.handle || "").toLowerCase();
      if (!c.isAuthor && h && (perHandle.get(h) || 0) >= 2) continue;
      seen.push(norm);
      out.push(c);
      if (h) perHandle.set(h, (perHandle.get(h) || 0) + 1);
    }
    return out;
  }

  function articleStatusId(article) {
    if (!article) return "";
    const links = qsa('a[href*="/status/"]', article);
    for (const link of links) {
      const href = link.getAttribute("href") || link.href || "";
      const m = href.match(/status\/(\d+)/i);
      if (m) return m[1];
    }
    return "";
  }

  /** Stable key for "once per post" auto-generate / cache. */
  function getPostKey() {
    const fromLoc = location.href.match(/status\/(\d+)/i);
    if (fromLoc) return fromLoc[1];
    const articles = getArticleNodes();
    for (const art of articles) {
      const id = articleStatusId(art);
      if (id) return id;
    }
    const scraped = scrapePostAndComments();
    if (scraped.postText) return "t:" + scraped.postText.slice(0, 80);
    return location.pathname + location.search;
  }

  /**
   * Scrape main post + comments + thread ancestors + same-author tweets visible in DOM.
   */
  function scrapePostAndComments() {
    const articles = getArticleNodes();
    if (!articles.length) {
      const texts = qsa('div[data-testid="tweetText"]')
        .map((el) => (el.innerText || "").trim())
        .filter(Boolean);
      if (texts.length) {
        return {
          postText: truncText(texts[0], TEXT_CAP_POST),
          quotedText: "",
          comments: texts.slice(1, 13).map((x) => truncText(x, TEXT_CAP_COMMENT)),
          commentTotal: Math.max(0, texts.length - 1),
          author: "",
          authorHandle: "",
          threadTexts: [],
          authorRecent: [],
          postId: getPostKey(),
          mainArticle: null,
        };
      }
        return {
          postText: "",
          quotedText: "",
          comments: [],
          commentTotal: 0,
          author: "",
          authorHandle: "",
          threadTexts: [],
          authorRecent: [],
          postId: "",
          mainArticle: null,
      };
    }

    const urlIdMatch = location.href.match(/status\/(\d+)/i);
    const preferId = urlIdMatch ? urlIdMatch[1] : "";

    let mainIdx = 0;
    if (preferId) {
      for (let i = 0; i < articles.length; i++) {
        if (articleStatusId(articles[i]) === preferId) {
          mainIdx = i;
          break;
        }
      }
    }

    const main = articles[mainIdx];
    const author = extractAuthor(main);
    const authorHandle = extractHandle(main);
    const postText = extractTweetText(main);
    const quotedText = extractQuotedText(main);
    const postId = preferId || articleStatusId(main) || getPostKey();

    // Thread上文：主帖之前的 article（对话链）
    const threadTexts = [];
    for (let i = 0; i < mainIdx; i++) {
      const t = extractTweetText(articles[i]);
      if (!t) continue;
      const h = extractHandle(articles[i]) || extractAuthor(articles[i]).split(" ")[0] || "";
      threadTexts.push((h ? `@${h.replace(/^@/, "")}: ` : "") + t);
      if (threadTexts.length >= 8) break;
    }

    // 评论：主帖之后，按作者回复/点赞/提问精选；去重、去低信息
    const candidates = [];
    for (let i = mainIdx + 1; i < articles.length; i++) {
      const art = articles[i];
      if (qs('[data-testid="promotedIndicator"]', art)) continue;
      const text = extractTweetText(art);
      if (!text) continue;
      if (text === postText) continue;
      const h = extractHandle(art);
      const isAuthor = !!authorHandle && h.toLowerCase() === authorHandle.toLowerCase();
      candidates.push({
        text,
        handle: h,
        likes: extractLikeCount(art),
        isAuthor,
        isQuestion:
          /[?？]/.test(text) ||
          /(怎么|如何|为什么|哪个|有没有|求推荐|想问|请问|能不能)/.test(text),
        low: isLowInfoComment(text),
        pos: candidates.length,
      });
    }
    const picked = pickComments(candidates, commentLimit);
    const comments = picked.map(
      (c) => (c.isAuthor ? "[作者] " : c.handle ? `@${c.handle}: ` : "") + c.text
    );

    if (!comments.length) {
      const allTexts = qsa('div[data-testid="tweetText"]')
        .map((el) => (el.innerText || "").trim())
        .filter(Boolean);
      for (const t of allTexts) {
        if (t === postText || isLowInfoComment(t)) continue;
        const norm = normalizeCommentText(t);
        if (!norm || comments.some((c) => similarComment(normalizeCommentText(c), norm))) continue;
        comments.push(t);
        if (comments.length >= Math.min(commentLimit, 12)) break;
      }
    }

    // 同作者其他可见帖（线程里自回、或同页其它卡）
    const authorRecent = [];
    const handleLower = (authorHandle || "").toLowerCase();
    if (handleLower) {
      for (let i = 0; i < articles.length; i++) {
        if (i === mainIdx) continue;
        const h = (extractHandle(articles[i]) || "").toLowerCase();
        if (h !== handleLower) continue;
        const t = extractTweetText(articles[i]);
        if (!t || t === postText) continue;
        if (authorRecent.includes(t)) continue;
        authorRecent.push(t);
        if (authorRecent.length >= 5) break;
      }
    }

    // Truncate strings; do not keep full-page HTML. mainArticle is a live Element ref only.
    return {
      postText: truncText(postText, TEXT_CAP_POST),
      quotedText: truncText(quotedText, 800),
      comments: comments.map((x) => truncText(x, TEXT_CAP_COMMENT)),
      commentTotal: candidates.length,
      author: truncText(author, 80),
      authorHandle: truncText(authorHandle, 40),
      threadTexts: threadTexts.map((x) => truncText(x, TEXT_CAP_COMMENT)).slice(0, 8),
      authorRecent: authorRecent.map((x) => truncText(x, TEXT_CAP_COMMENT)).slice(0, 5),
      postId,
      mainArticle: main,
    };
  }


  const SOURCE_HL_CLASS = "xrh-source-highlight";
  const COMMENT_HL_CLASS = "xrh-comment-highlight";
  const NEXT_AUTO_CLASS = "xrh-next-auto-guide";
  const REPLY_THIS_CLASS = "xrh-reply-this";

  function clearCommentHighlight() {
    if (highlightedCommentArticle && highlightedCommentArticle.classList) {
      highlightedCommentArticle.classList.remove(COMMENT_HL_CLASS);
    }
    highlightedCommentArticle = null;
  }

  function setCommentHighlight(article) {
    clearCommentHighlight();
    if (!article || !article.classList) return;
    article.classList.add(COMMENT_HL_CLASS);
    highlightedCommentArticle = article;
  }

  function findArticleContaining(el) {
    if (!el || !el.closest) return null;
    return el.closest('article[data-testid="tweet"]');
  }

  /** Composer may sit in a reply modal; find the tweet being replied to. */
  function findReplyModalTargetArticle() {
    const modal =
      qs('[aria-labelledby="modal-header"]') ||
      qs('[data-testid="twc-cc-mask"]')?.parentElement ||
      qs('[role="dialog"]');
    if (!modal) return null;
    const arts = qsa('article[data-testid="tweet"]', modal);
    // Usually the first article in the dialog is the tweet being replied to
    return arts[0] || null;
  }

  function findComposerNearestArticle(composerEl) {
    const fromSelf = findArticleContaining(composerEl);
    if (fromSelf) return fromSelf;
    // Inline reply often places composer as sibling after article; walk up then look
    let node = composerEl;
    for (let i = 0; i < 12 && node; i++) {
      const art = node.previousElementSibling;
      if (art && art.matches?.('article[data-testid="tweet"]')) return art;
      const arts = node.querySelectorAll?.('article[data-testid="tweet"]');
      if (arts && arts.length) return arts[arts.length - 1];
      node = node.parentElement;
    }
    return findReplyModalTargetArticle();
  }

  function describeCommentTarget(article) {
    if (!article) return null;
    const text = extractTweetText(article);
    if (!text) return null;
    const handle = (extractHandle(article) || "").replace(/^@/, "");
    const author = extractAuthor(article);
    const statusId = articleStatusId(article);
    const statusLink = statusId
      ? `https://x.com/${handle || "i"}/status/${statusId}`
      : "";
    return {
      text,
      author,
      handle,
      statusId,
      statusLink,
      article,
    };
  }

  /**
   * Build楼中楼 context: root + chain to target + siblings near target.
   */
  function buildReplyToCommentPayload(targetArticle) {
    const scraped = scrapePostAndComments();
    const root = scraped.mainArticle;
    const rootId = scraped.postId;
    const target = describeCommentTarget(targetArticle);
    if (!target) return { scraped, replyToComment: null, threadTexts: scraped.threadTexts || [], siblingReplies: [] };

    // If target is the root post, not楼中楼
    const targetId = target.statusId;
    if (targetId && rootId && String(targetId) === String(rootId)) {
      return { scraped, replyToComment: null, threadTexts: scraped.threadTexts || [], siblingReplies: [] };
    }
    if (root && targetArticle === root) {
      return { scraped, replyToComment: null, threadTexts: scraped.threadTexts || [], siblingReplies: [] };
    }

    const articles = getArticleNodes();
    let rootIdx = 0;
    let targetIdx = -1;
    for (let i = 0; i < articles.length; i++) {
      if (root && articles[i] === root) rootIdx = i;
      if (articles[i] === targetArticle) targetIdx = i;
    }
    if (targetIdx < 0) {
      // target may be in modal only
      targetIdx = articles.indexOf(targetArticle);
    }

    const chain = [];
    if (targetIdx >= 0) {
      const start = Math.max(rootIdx + 1, targetIdx - 5);
      for (let i = start; i < targetIdx; i++) {
        const t = extractTweetText(articles[i]);
        if (!t) continue;
        const h = extractHandle(articles[i]) || "";
        chain.push((h ? `@${h.replace(/^@/, "")}: ` : "") + t);
        if (chain.length >= 5) break;
      }
    }

    // Prefer scrape thread + chain (dedupe)
    const threadTexts = [];
    const seen = new Set();
    for (const t of [...(scraped.threadTexts || []), ...chain]) {
      const key = normalizeCommentText(t);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      threadTexts.push(t);
      if (threadTexts.length >= 5) break;
    }

    // Sibling replies: nearby articles after root around target
    const siblingReplies = [];
    if (targetIdx >= 0) {
      for (let i = Math.max(rootIdx + 1, targetIdx - 2); i <= Math.min(articles.length - 1, targetIdx + 4); i++) {
        if (i === targetIdx) continue;
        const art = articles[i];
        if (root && art === root) continue;
        const t = extractTweetText(art);
        if (!t || t === scraped.postText || t === target.text) continue;
        const h = extractHandle(art) || "";
        siblingReplies.push((h ? `@${h.replace(/^@/, "")}: ` : "") + t);
        if (siblingReplies.length >= 4) break;
      }
    }

    const replyToComment = {
      text: target.text,
      author: target.author,
      handle: target.handle,
      statusId: target.statusId || "",
      statusLink: target.statusLink || "",
    };

    return { scraped, replyToComment, threadTexts, siblingReplies, targetArticle };
  }

  function setActiveReplyToComment(targetArticle, metaLabel) {
    const built = buildReplyToCommentPayload(targetArticle);
    if (!built.replyToComment) {
      activeReplyToComment = null;
      clearCommentHighlight();
      return built;
    }
    activeReplyToComment = {
      ...built.replyToComment,
      threadTexts: built.threadTexts,
      siblingReplies: built.siblingReplies,
      article: built.targetArticle || targetArticle,
    };
    setCommentHighlight(built.targetArticle || targetArticle);
    // Keep root highlight too
    const rootArt = built.scraped.mainArticle || findMainArticleFromScrape(built.scraped);
    if (rootArt) {
      // don't clear comment when setting root
      if (highlightedArticle && highlightedArticle !== rootArt) {
        highlightedArticle.classList.remove(SOURCE_HL_CLASS);
      }
      rootArt.classList.add(SOURCE_HL_CLASS);
      highlightedArticle = rootArt;
    }
    updateSourceTargetLabel({
      authorHandle: built.scraped.authorHandle,
      postText: built.scraped.postText,
      replyToComment: built.replyToComment,
    });
    return built;
  }

  function clearActiveReplyToComment() {
    activeReplyToComment = null;
    clearCommentHighlight();
  }

  /** Detect楼中楼 from focused composer / open reply UI. */
  function detectReplyTargetFromComposer() {
    const composer =
      qs('[data-testid="tweetTextarea_0"]') ||
      document.activeElement?.closest?.('[data-testid="tweetTextarea_0"]') ||
      (document.activeElement?.getAttribute?.("data-testid") === "tweetTextarea_0"
        ? document.activeElement
        : null);
    if (!composer && !qs('[data-testid="toolBar"]')) return null;

    const composeEl = composer || qs('[data-testid="toolBar"]');
    let art = findComposerNearestArticle(composeEl);
    if (!art) art = findReplyModalTargetArticle();
    if (!art) return null;

    const scraped = scrapePostAndComments();
    const root = scraped.mainArticle;
    const rootId = scraped.postId;
    const tid = articleStatusId(art);
    if (root && art === root) return null;
    if (tid && rootId && String(tid) === String(rootId)) return null;
    // On timeline without status URL, first article is often "main" — still allow if composer nested under a later article
    return art;
  }

  function getRootArticleLite() {
    const urlIdMatch = location.href.match(/status\/(\d+)/i);
    const preferId = urlIdMatch ? urlIdMatch[1] : "";
    const articles = getArticleNodes();
    if (!articles.length) return { root: null, rootId: preferId || "" };
    if (preferId) {
      for (const art of articles) {
        if (articleStatusId(art) === preferId) return { root: art, rootId: preferId };
      }
    }
    return { root: articles[0], rootId: preferId || articleStatusId(articles[0]) || "" };
  }

  function ensureReplyThisIO() {
    if (replyThisIO) return replyThisIO;
    replyThisIO = new IntersectionObserver(
      (entries) => {
        let live = document.querySelectorAll("." + REPLY_THIS_CLASS).length;
        const rootLite = getRootArticleLite();
        const maxBtn = replyThisMax();
        for (const ent of entries) {
          const art = ent.target;
          if (!(art instanceof Element)) continue;
          if (!ent.isIntersecting) {
            const mapped = replyThisBtnByArticle.get(art);
            const btn = mapped || art.querySelector(":scope ." + REPLY_THIS_CLASS);
            if (btn) {
              try { btn.remove(); } catch { /* ignore */ }
            }
            replyThisBtnByArticle.delete(art);
            continue;
          }
          if (live >= maxBtn) continue;
          if (replyThisBtnByArticle.get(art) || art.querySelector(":scope ." + REPLY_THIS_CLASS)) continue;
          if (mountReplyThisButton(art, rootLite)) live += 1;
        }
      },
      { root: null, rootMargin: memorySaver ? "40px 0px" : "80px 0px", threshold: 0.05 }
    );
    return replyThisIO;
  }

  function mountReplyThisButton(art, rootLite) {
    if (!art || !(art instanceof Element)) return false;
    const { root, rootId } = rootLite || getRootArticleLite();
    if (root && art === root) return false;
    const sid = articleStatusId(art);
    if (sid && rootId && String(sid) === String(rootId)) return false;
    // cheap text presence check without full extract
    if (!qs('div[data-testid="tweetText"]', art)) return false;
    if (art.querySelector(":scope ." + REPLY_THIS_CLASS)) return false;
    if (document.querySelectorAll("." + REPLY_THIS_CLASS).length >= replyThisMax()) return false;

    const replyBtn = qs('[data-testid="reply"]', art);
    if (!replyBtn) return false;
    const wrap =
      replyBtn.closest('[role="group"]') ||
      replyBtn.parentElement ||
      replyBtn;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = REPLY_THIS_CLASS;
    btn.title = "针对这条评论生成回复草稿（不代发）";
    btn.textContent = "回这条";
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      setActiveReplyToComment(art);
      const rootEl = ensureRoot();
      rootEl.classList.remove("xrh-collapsed");
      const panel = rootEl.querySelector('[data-xrh="panel"]');
      if (panel) panel.hidden = false;
      onGenerate({ source: "manual", multiAngle: false, replyToComment: true });
    });
    try {
      wrap.appendChild(btn);
    } catch {
      try { replyBtn.insertAdjacentElement("afterend", btn); } catch { return false; }
    }
    replyThisBtnByArticle.set(art, btn);
    return true;
  }

  function injectReplyThisButtons() {
    if (!(isReplyContext() || isStatusPage())) return;
    const io = ensureReplyThisIO();
    const { root, rootId } = getRootArticleLite();
    const articles = getArticleNodes();
    let observed = 0;
    for (const art of articles) {
      if (root && art === root) continue;
      const sid = articleStatusId(art);
      if (sid && rootId && String(sid) === String(rootId)) continue;
      if (replyThisObserved.has(art)) continue;
      replyThisObserved.add(art);
      io.observe(art);
      observed += 1;
      // don't attach hundreds of observers in one tick
      if (observed >= 40) break;
    }
  }

  function runWhenIdle(fn, timeout = 800) {
    if (typeof requestIdleCallback === "function") {
      return requestIdleCallback(() => { try { fn(); } catch { /* ignore */ } }, { timeout });
    }
    return setTimeout(() => { try { fn(); } catch { /* ignore */ } }, Math.min(timeout, 120));
  }

  function withObserverPaused(fn) {
    if (!observer || observerPaused) {
      try { return fn(); } catch { return undefined; }
    }
    observerPaused = true;
    try { observer.disconnect(); } catch { /* ignore */ }
    observerAttached = false;
    try {
      return fn();
    } finally {
      observerPaused = false;
      if (!document.hidden) {
        try {
          observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
          });
          observerAttached = true;
        } catch { /* ignore */ }
      }
    }
  }

  function scheduleInjectReplyThis() {
    if (!(isReplyContext() || isStatusPage())) return;
    if (replyThisInjectTimer) clearTimeout(replyThisInjectTimer);
    replyThisInjectTimer = setTimeout(() => {
      replyThisInjectTimer = null;
      runWhenIdle(() => {
        withObserverPaused(() => injectReplyThisButtons());
      }, 900);
    }, INJECT_DEBOUNCE_MS);
  }


  function clearSourceHighlight() {
    if (highlightedArticle && highlightedArticle.classList) {
      highlightedArticle.classList.remove(SOURCE_HL_CLASS);
    }
    highlightedArticle = null;
  }

  function clearNextAutoGuide() {
    if (nextAutoGuideArticle && nextAutoGuideArticle.classList) {
      nextAutoGuideArticle.classList.remove(NEXT_AUTO_CLASS);
      const badge = nextAutoGuideArticle.querySelector(":scope > .xrh-next-auto-badge");
      if (badge) badge.remove();
    }
    nextAutoGuideArticle = null;
  }

  function setSourceHighlight(article, meta = {}) {
    clearSourceHighlight();
    if (!article || !article.classList) {
      updateSourceTargetLabel(meta);
      return;
    }
    article.classList.add(SOURCE_HL_CLASS);
    highlightedArticle = article;
    updateSourceTargetLabel(meta);
  }

  function updateSourceTargetLabel(meta = {}) {
    const root = document.getElementById(ROOT_ID);
    const el = root?.querySelector?.('[data-xrh="source-target"]');
    if (!el) return;
    const rtc = meta.replyToComment || activeReplyToComment;
    const handle = String(meta.authorHandle || "").replace(/^@/, "").trim();
    const snippet = String(meta.postText || meta.postSnippet || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 20);
    if (rtc && (rtc.handle || rtc.text)) {
      const ch = String(rtc.handle || "").replace(/^@/, "").trim();
      const cs = String(rtc.text || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 20);
      const who = ch ? "@" + ch : "未知";
      el.hidden = false;
      el.classList.add("xrh-source-target-comment");
      const rootBit = handle || snippet
        ? ` · 原帖 @${handle || "?"} ${snippet || ""}`.trim()
        : "";
      el.textContent = `回评论：${who} · ${cs || "（无正文）"}${rootBit}`;
      return;
    }
    el.classList.remove("xrh-source-target-comment");
    if (!handle && !snippet) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    const who = handle ? "@" + handle : "未知作者";
    el.hidden = false;
    el.textContent = `当前：${who} · ${snippet || "（无正文）"}`;
  }

  function markNextAutoGuide(article) {
    clearNextAutoGuide();
    if (!article || !article.classList) return;
    if (article.classList.contains(SOURCE_HL_CLASS)) return;
    article.classList.add(NEXT_AUTO_CLASS);
    nextAutoGuideArticle = article;
    let badge = article.querySelector(":scope > .xrh-next-auto-badge");
    if (!badge) {
      badge = document.createElement("div");
      badge.className = "xrh-next-auto-badge";
      badge.textContent = "下一条自动生成";
      try {
        article.style.position = article.style.position || "relative";
      } catch {
        // ignore
      }
      article.appendChild(badge);
    }
  }

  function findMainArticleFromScrape(scraped) {
    if (scraped?.mainArticle) return scraped.mainArticle;
    const postId = String(scraped?.postId || "").replace(/^t:.*/, "");
    if (/^\d+$/.test(postId)) {
      const art = findArticleByStatusId(postId);
      if (art) return art;
    }
    const articles = getArticleNodes();
    return articles[0] || null;
  }

  /** When auto-gen is on: badge the next not-yet-done status article roughly in/below viewport. */
  function updateNextAutoGuide() {
    if (!autoGenerateEnabled) {
      clearNextAutoGuide();
      return;
    }
    const articles = getArticleNodes();
    if (!articles.length) {
      clearNextAutoGuide();
      return;
    }
    const vh = window.innerHeight || 800;
    let candidate = null;
    for (const art of articles) {
      if (art.classList.contains(SOURCE_HL_CLASS)) continue;
      const sid = articleStatusId(art);
      const key = sid || "";
      if (key && autoDoneKeys.has(key)) continue;
      if (key && key === lastRenderedKey) continue;
      const rect = art.getBoundingClientRect();
      // prefer first article whose top is below mid-viewport or still slightly above bottom
      if (rect.bottom < 80) continue;
      if (rect.top > vh * 0.95) {
        candidate = art;
        break;
      }
      if (rect.top >= vh * 0.35) {
        candidate = art;
        break;
      }
      if (!candidate) candidate = art;
    }
    if (candidate) markNextAutoGuide(candidate);
    else clearNextAutoGuide();
  }


  function purgeDuplicates() {
    // Only if duplicates likely; avoid full walks every call
    const roots = document.querySelectorAll(`#${ROOT_ID}, .xrh-root`);
    if (roots.length <= 1) {
      const orphanBtns = document.querySelectorAll(`.${TB_CLASS}:not(#${TB_BTN_ID})`);
      orphanBtns.forEach((el) => el.remove());
      return;
    }
    let seenRoot = false;
    roots.forEach((el) => {
      if (el.id === ROOT_ID && !seenRoot) {
        seenRoot = true;
        return;
      }
      el.remove();
    });
  }

  function ensureRoot() {
    let root = document.getElementById(ROOT_ID);
    if (root) return root;
    purgeDuplicates();
    root = document.getElementById(ROOT_ID);
    if (root) return root;

    root = document.createElement("div");
    root.id = ROOT_ID;
    root.className = "xrh-root xrh-floating";
    root.innerHTML = `
      <div class="xrh-bar">
        <button type="button" class="xrh-btn" data-xrh="generate" title="Alt+Shift+G">生成回复</button>
        <button type="button" class="xrh-btn xrh-btn-multi" data-xrh="multi" title="生成 5 条不同角度">多角度</button>
        <button type="button" class="xrh-btn xrh-btn-secondary" data-xrh="inbox" title="今日待回">待回</button>
        <button type="button" class="xrh-btn xrh-btn-secondary" data-xrh="settings">设置</button>
        <button type="button" class="xrh-btn xrh-btn-ghost" data-xrh="close" title="收起">×</button>
      </div>
      <div class="xrh-panel" data-xrh="panel" hidden>
        <div class="xrh-title">回复草稿（仅复制，不会代发）</div>
        <div class="xrh-source-target" data-xrh="source-target" hidden></div>
        <div class="xrh-persona" data-xrh="persona"></div>
        <div class="xrh-toggles" data-xrh="toggles">
          <label class="xrh-toggle" title="楼中楼回复发送后也只给根帖点赞，不会给评论点赞"><input type="checkbox" data-xrh="like-after" /> 回复后给原帖点赞</label>
          <label class="xrh-toggle"><input type="checkbox" data-xrh="fast-mode" checked /> 快速模式</label>
          <label class="xrh-toggle"><input type="checkbox" data-xrh="quality-first" /> 质量优先</label>
        </div>
        <div class="xrh-status" data-xrh="status"></div>
        <div class="xrh-actions-row" data-xrh="status-actions" hidden></div>
        <div class="xrh-chooser-hint" data-xrh="chooser-hint" hidden>点一条填入回复框（多角度）</div>
        <div data-xrh="list"></div>
        <div class="xrh-inbox" data-xrh="inbox-panel" hidden>
          <div class="xrh-title">今日待回 <span class="xrh-inbox-note">尽力抓取</span></div>
          <div class="xrh-status" data-xrh="inbox-status"></div>
          <div data-xrh="inbox-list"></div>
          <div class="xrh-hint">在通知/提及页浏览后会收入列表；点「已回」或填入草稿可标记。检测是尽力而为，可能漏检。</div>
        </div>
        <div class="xrh-hint">热键：Alt+Shift+G 生成 · F 填入第1条 · N 下一条。选一条「填入」或「复制」，再自己点发送。可选「回复后给原帖点赞」（默认关；楼中楼也只赞原帖不赞评论）。可点评论旁「回这条」。草稿可点 👍/👎。</div>
        <div class="xrh-feedback-toolbar">
          <button type="button" class="xrh-btn xrh-btn-ghost xrh-btn-clear-fb" data-xrh="clear-feedback" title="清空本地评价记录">清空评价记录</button>
        </div>
      </div>
    `;

    root.querySelector('[data-xrh="generate"]').addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onGenerate({ source: "manual", multiAngle: false });
    });
    root.querySelector('[data-xrh="multi"]').addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onGenerate({ source: "manual", multiAngle: true });
    });
    root.querySelector('[data-xrh="inbox"]').addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleInboxPanel();
    });
    root.querySelector('[data-xrh="settings"]').addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" });
    });
    root.querySelector('[data-xrh="clear-feedback"]').addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!confirm("清空全部草稿评价记录？下次生成将不再参考这些偏好。")) return;
      try {
        const res = await chrome.runtime.sendMessage({ type: "CLEAR_REPLY_FEEDBACK" });
        if (res?.ok) setStatus("已清空评价记录。", "ok");
        else setStatus(res?.error || "清空失败", "error");
      } catch (err) {
        setStatus(`清空失败：${err?.message || err}`, "error");
      }
    });
    root.querySelector('[data-xrh="close"]').addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const panel = root.querySelector('[data-xrh="panel"]');
      if (panel) panel.hidden = true;
      root.classList.add("xrh-collapsed");
    });

    document.body.appendChild(root);
    refreshPersonaChips(root);
    wirePanelToggles(root);
    syncPanelToggles(root);
    return root;
  }


  function wirePanelToggles(root) {
    if (!root || root.__xrhTogglesWired) return;
    root.__xrhTogglesWired = true;
    const likeEl = root.querySelector('[data-xrh="like-after"]');
    const fastEl = root.querySelector('[data-xrh="fast-mode"]');
    const qualityEl = root.querySelector('[data-xrh="quality-first"]');
    likeEl?.addEventListener("change", () => {
      likeAfterReply = !!likeEl.checked;
      chrome.storage.sync.set({ likeAfterReply });
      setStatus(
        likeAfterReply
          ? "已开：回复发送后会尽量给原帖点赞（默认随机等 0.3–0.7 秒；自己的帖/已赞过跳过）。仍不代发。"
          : "已关：回复后不再自动点赞。",
        "ok"
      );
    });
    fastEl?.addEventListener("change", () => {
      fastMode = !!fastEl.checked;
      chrome.storage.sync.set({ fastMode });
      if (fastMode && qualityFirst) {
        qualityFirst = false;
        chrome.storage.sync.set({ qualityFirst: false });
        if (qualityEl) qualityEl.checked = false;
      }
      setStatus(fastMode ? "快速模式：开（更短提示、更少上下文）。" : "快速模式：关。", "ok");
    });
    qualityEl?.addEventListener("change", () => {
      qualityFirst = !!qualityEl.checked;
      chrome.storage.sync.set({ qualityFirst });
      if (qualityFirst) {
        // 质量优先覆盖快速捷径；UI 上仍可保留快速勾选状态，实际生成以 qualityFirst 为准
        setStatus("质量优先：开（完整提示与相似度重写；忽略快速捷径）。", "ok");
      } else {
        setStatus("质量优先：关。", "ok");
      }
    });
  }

  function syncPanelToggles(root) {
    if (!root) return;
    const likeEl = root.querySelector('[data-xrh="like-after"]');
    const fastEl = root.querySelector('[data-xrh="fast-mode"]');
    const qualityEl = root.querySelector('[data-xrh="quality-first"]');
    if (likeEl) likeEl.checked = !!likeAfterReply;
    if (fastEl) fastEl.checked = fastMode !== false;
    if (qualityEl) qualityEl.checked = !!qualityFirst;
  }

  function getSelfHandle() {
    try {
      const profile = qs('a[data-testid="AppTabBar_Profile_Link"]');
      const href = profile?.getAttribute("href") || "";
      const m = href.match(/^\/([A-Za-z0-9_]{1,15})\/?$/);
      if (m && !SKIP_HANDLES.has(m[1].toLowerCase())) return m[1];
    } catch { /* ignore */ }
    try {
      const switcher = qs('[data-testid="SideNav_AccountSwitcher_Button"]');
      const text = (switcher?.innerText || switcher?.textContent || "");
      const at = text.match(/@([A-Za-z0-9_]{1,15})/);
      if (at) return at[1];
    } catch { /* ignore */ }
    return "";
  }

  function findArticleByStatusId(statusId) {
    const sid = String(statusId || "").trim();
    if (!sid) return null;
    for (const art of getArticleNodes()) {
      if (articleStatusId(art) === sid) return art;
    }
    // compose dialog / quote card sometimes nests status link without matching article order
    for (const art of getArticleNodes()) {
      const a = qs(`a[href*="/status/${sid}"]`, art);
      if (a) return art;
    }
    return null;
  }

  function articleAlreadyLiked(article) {
    if (!article) return false;
    if (qs('[data-testid="unlike"]', article)) return true;
    const like = qs('[data-testid="like"]', article);
    if (!like) return false;
    const pressed = like.getAttribute("aria-pressed");
    return pressed === "true";
  }

  function isOwnArticle(article) {
    const self = (getSelfHandle() || "").toLowerCase();
    if (!self) return false;
    const h = (extractHandle(article) || "").toLowerCase();
    return !!h && h === self;
  }

  /**
   * Best-effort: click like on root status after user sends a reply.
   * Skips own tweets & already-liked. Never auto-posts.
   */
  async function maybeLikeAfterReply(statusId) {
    if (!likeAfterReply || likeInFlight) return;
    const sid = String(statusId || pendingLikeStatusId || "").trim();
    if (!sid) return;
    likeInFlight = true;
    const wait = 300 + Math.floor(Math.random() * 401); // 300–700ms
    try {
      await new Promise((r) => setTimeout(r, wait));
      let article = findArticleByStatusId(sid);
      if (!article) {
        // brief retry — DOM may reflow after send
        await new Promise((r) => setTimeout(r, 400));
        article = findArticleByStatusId(sid);
      }
      if (!article) {
        setStatus("写完即赞：找不到原帖 DOM（可能已离开该帖）。", "error");
        return;
      }
      if (isOwnArticle(article)) {
        setStatus("写完即赞：跳过自己的帖。", "ok");
        return;
      }
      if (articleAlreadyLiked(article)) {
        setStatus("写完即赞：原帖已赞过，跳过。", "ok");
        return;
      }
      const likeBtn = qs('[data-testid="like"]', article);
      if (!likeBtn) {
        setStatus("写完即赞：找不到点赞按钮（X DOM 可能变了）。", "error");
        return;
      }
      likeBtn.click();
      setStatus(`写完即赞：已尝试给原帖点赞（延迟 ${wait}ms）。`, "ok");
    } catch (err) {
      setStatus("写完即赞失败：" + (err?.message || err), "error");
    } finally {
      likeInFlight = false;
      pendingLikeStatusId = "";
    }
  }

  function captureReplyTargetStatusId() {
    // 写完即赞永远对准「原帖 / 根帖」，不对评论点赞（楼中楼也一样）
    const fromUrl = location.href.match(/status\/(\d+)/i);
    if (fromUrl) return fromUrl[1];
    try {
      const scraped = scrapePostAndComments();
      if (scraped?.postId && /^\d+$/.test(scraped.postId)) return scraped.postId;
      const mainId = scraped?.mainArticle ? articleStatusId(scraped.mainArticle) : "";
      if (mainId && /^\d+$/.test(mainId)) return mainId;
    } catch { /* ignore */ }
    const key = getPostKey();
    return /^\d+$/.test(String(key)) ? key : "";
  }

  function isTweetSubmitButton(el) {
    if (!el || el.nodeType !== 1) return false;
    const btn =
      el.closest?.('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]') ||
      (el.matches?.('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]') ? el : null);
    return !!btn;
  }

  function installReplySendHook() {
    if (replyHookInstalled) return;
    replyHookInstalled = true;
    document.addEventListener(
      "click",
      (e) => {
        if (!likeAfterReply) return;
        const t = e.target;
        if (!isTweetSubmitButton(t)) return;
        // Only when there is reply compose context
        const hasCompose =
          qs('[data-testid="tweetTextarea_0"]') ||
          qs('[data-testid="toolBar"]');
        if (!hasCompose) return;
        const sid = captureReplyTargetStatusId();
        if (!sid || !/^\d+$/.test(String(sid))) return;
        pendingLikeStatusId = String(sid);
        // Observe composer clear / button disable as soft "sent" signal, then like
        scheduleLikeAfterSend(sid);
      },
      true
    );
  }

  let likeWatchTimer = null;
  function scheduleLikeAfterSend(statusId) {
    if (likeWatchTimer) {
      clearTimeout(likeWatchTimer);
      likeWatchTimer = null;
    }
    const start = Date.now();
    const composer = qs('[data-testid="tweetTextarea_0"]');
    const beforeText = (composer?.innerText || composer?.textContent || "").trim();

    const tick = () => {
      likeWatchTimer = null;
      if (!likeAfterReply) return;
      const elapsed = Date.now() - start;
      const comp = qs('[data-testid="tweetTextarea_0"]');
      const nowText = (comp?.innerText || comp?.textContent || "").trim();
      // Heuristic: composer emptied or removed after having content → likely sent
      const cleared = beforeText.length > 0 && (!comp || nowText.length === 0 || nowText.length < Math.min(3, beforeText.length));
      const dialogGone =
        beforeText.length > 0 &&
        !qs('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]') &&
        !qs('[aria-labelledby="modal-header"] [data-testid="tweetTextarea_0"]');
      if (cleared || dialogGone || elapsed >= 2500) {
        maybeLikeAfterReply(statusId);
        return;
      }
      likeWatchTimer = setTimeout(tick, 200);
    };
    likeWatchTimer = setTimeout(tick, 350);
  }

  function refreshPersonaChips(root) {
    const host = root?.querySelector?.('[data-xrh="persona"]');
    if (!host) return;
    const presets = personaPresets.length
      ? personaPresets
      : [
          { id: "default", label: "默认友善" },
          { id: "serena", label: "Serena" },
          { id: "awe0", label: "awe0" },
          { id: "stanley", label: "Stanley" },
          { id: "custom", label: "自定义" },
        ];
    host.innerHTML = "";
    const label = document.createElement("div");
    label.className = "xrh-persona-label";
    label.textContent = "人设";
    host.appendChild(label);
    const row = document.createElement("div");
    row.className = "xrh-persona-row";
    for (const p of presets) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "xrh-persona-chip" + (p.id === activePersonaId ? " active" : "");
      btn.textContent = p.label;
      btn.title = "切换人设：" + p.label;
      btn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await switchPersona(p.id);
      });
      row.appendChild(btn);
    }
    host.appendChild(row);
  }

  async function loadPersonaState() {
    try {
      const result = await chrome.runtime.sendMessage({ type: "GET_PERSONA_STATE" });
      if (result?.ok) {
        activePersonaId = result.personaId || "default";
        personaPresets = Array.isArray(result.presets) ? result.presets : [];
        const root = document.getElementById(ROOT_ID);
        if (root) refreshPersonaChips(root);
      }
    } catch {
      // ignore
    }
  }

  async function switchPersona(personaId) {
    try {
      const result = await chrome.runtime.sendMessage({
        type: "SET_ACTIVE_PERSONA",
        payload: { personaId },
      });
      if (!result?.ok) {
        setStatus(result?.error || "切换人设失败", "error");
        return;
      }
      activePersonaId = result.personaId || personaId;
      personaPresets = Array.isArray(result.presets) ? result.presets : personaPresets;
      const root = document.getElementById(ROOT_ID);
      if (root) refreshPersonaChips(root);
      const label = (personaPresets.find((p) => p.id === activePersonaId) || {}).label || activePersonaId;
      setStatus("已切换人设：" + label + "。下次生成生效（不会代发）。", "ok");
    } catch (err) {
      setStatus("切换人设失败：" + (err?.message || err), "error");
    }
  }

  function ensureToolbarButton() {
    const toolBar = qs('[data-testid="toolBar"]');
    if (!toolBar) return null;

    qsa(`#${TB_BTN_ID}, .${TB_CLASS}`).forEach((el) => {
      if (!toolBar.contains(el)) el.remove();
    });

    let btn = toolBar.querySelector(`#${TB_BTN_ID}`);
    if (btn) return btn;

    btn = document.createElement("button");
    btn.id = TB_BTN_ID;
    btn.type = "button";
    btn.className = TB_CLASS;
    btn.title = "AI 生成回复草稿（仅复制，不代发）";
    btn.setAttribute("aria-label", "AI 生成回复");
    btn.innerHTML = `
      <span class="xrh-toolbar-ai-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
          <path d="M13 2L4 14h6l-1 8 10-14h-6l1-6z"/>
        </svg>
      </span>
    `;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const root = ensureRoot();
      root.classList.remove("xrh-collapsed");
      onGenerate({ source: "manual" });
    });

    const leftGroup =
      toolBar.querySelector(":scope > div") ||
      toolBar.firstElementChild ||
      toolBar;

    const children = Array.from(leftGroup.children || []);
    let inserted = false;
    for (let i = children.length - 1; i >= 0; i--) {
      const el = children[i];
      if (el.id === TB_BTN_ID) continue;
      if (el.getAttribute && el.getAttribute("role") === "button") {
        el.insertAdjacentElement("afterend", btn);
        inserted = true;
        break;
      }
      if (el.tagName === "BUTTON" || el.querySelector?.('button,[role="button"]')) {
        el.insertAdjacentElement("afterend", btn);
        inserted = true;
        break;
      }
    }
    if (!inserted) leftGroup.appendChild(btn);
    return btn;
  }

  function isNotificationsOrMentionsPage() {
    const p = location.pathname || "";
    return /^\/notifications(?:\/|$)/i.test(p) || /^\/mentions(?:\/|$)/i.test(p);
  }

  function mountUi() {
    if (isNotificationsOrMentionsPage()) {
      ensureRoot();
      qsa(`#${TB_BTN_ID}, .${TB_CLASS}`).forEach((el) => el.remove());
      scheduleInboxScrape();
      return;
    }
    if (!isReplyContext()) {
      // keep root if inbox open? remove to avoid clutter on home/timeline
      const existing = document.getElementById(ROOT_ID);
      if (existing && !existing.querySelector('[data-xrh="inbox-panel"]:not([hidden])')) {
        existing.remove();
      }
      qsa(`#${TB_BTN_ID}, .${TB_CLASS}`).forEach((el) => el.remove());
      return;
    }

    ensureRoot();
    ensureToolbarButton();
    scheduleInjectReplyThis();
    scheduleAutoGenerate();
  }

  function cancelMountIdle() {
    if (mountIdleHandle == null) return;
    try {
      if (typeof cancelIdleCallback === "function") cancelIdleCallback(mountIdleHandle);
      else clearTimeout(mountIdleHandle);
    } catch {
      try { clearTimeout(mountIdleHandle); } catch { /* ignore */ }
    }
    mountIdleHandle = null;
  }

  function scheduleMount() {
    if (mountTimer) clearTimeout(mountTimer);
    cancelMountIdle();
    mountTimer = setTimeout(() => {
      mountTimer = null;
      mountIdleHandle = runWhenIdle(() => {
        mountIdleHandle = null;
        withObserverPaused(() => mountUi());
      }, 1000);
    }, MOUNT_DEBOUNCE_MS);
  }

  function clearStatusActions() {
    const root = document.getElementById(ROOT_ID);
    const actions = root?.querySelector?.('[data-xrh="status-actions"]');
    if (!actions) return;
    actions.innerHTML = "";
    actions.hidden = true;
  }

  function setStatus(text, kind = "", action) {
    const root = ensureRoot();
    root.classList.remove("xrh-collapsed");
    const panel = root.querySelector('[data-xrh="panel"]');
    const status = root.querySelector('[data-xrh="status"]');
    const actions = root.querySelector('[data-xrh="status-actions"]');
    panel.hidden = false;
    status.className = "xrh-status" + (kind ? ` ${kind}` : "");
    status.textContent = text || "";
    if (actions) {
      actions.innerHTML = "";
      if (action && typeof action.onClick === "function") {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "xrh-retry";
        btn.textContent = action.label || "重试";
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          action.onClick();
        });
        actions.appendChild(btn);
        actions.hidden = false;
      } else {
        actions.hidden = true;
      }
    }
  }

  function setToolbarBusy(busy) {
    const btn = document.getElementById(TB_BTN_ID);
    if (!btn) return;
    btn.disabled = !!busy;
    btn.classList.toggle("xrh-busy", !!busy);
  }

  function findComposerBox() {
    return (
      qs('[data-testid="tweetTextarea_0"]') ||
      qs('[contenteditable="true"][data-testid="tweetTextarea_0"]') ||
      qs('[contenteditable="true"][role="textbox"]') ||
      qs('div.public-DraftEditor-content[contenteditable="true"]') ||
      qs('div[contenteditable="true"]')
    );
  }

  function insertIntoComposer(text) {
    const box = findComposerBox();
    if (!box) {
      setStatus("没找到回复输入框，请先点开回复，再用「复制」。", "error");
      return;
    }

    const clean = String(text || "").trim();
    if (!clean) return;

    box.focus();

    try {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(box);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch {
      // ignore
    }

    let inserted = false;
    try {
      inserted = document.execCommand("insertText", false, clean);
    } catch {
      inserted = false;
    }

    const now = (box.innerText || box.textContent || "").replace(/\u200B/g, "").trim();
    if (now === clean || now.endsWith(clean) || now.includes(clean)) {
      setStatus("已填入回复框，请检查后自己点发送。", "ok");
      markCurrentStatusReplied();
      return;
    }

    if (!inserted) {
      try {
        navigator.clipboard.writeText(clean).then(() => {
          setStatus("无法直接填入，已复制到剪贴板，请 Ctrl+V 粘贴一次。", "ok");
        }).catch(() => {
          setStatus("填入失败，请改用「复制」。", "error");
        });
        return;
      } catch {
        setStatus("填入失败，请改用「复制」。", "error");
        return;
      }
    }

    setStatus("已填入回复框，请检查后自己点发送。", "ok");
    markCurrentStatusReplied();
  }

  function markActiveDraft(index) {
    const root = document.getElementById(ROOT_ID);
    if (!root) return;
    const items = root.querySelectorAll(".xrh-item");
    items.forEach((el, i) => {
      el.classList.toggle("xrh-item-active", i === index);
    });
  }

  function fillDraftAt(index) {
    if (!currentDrafts.length) {
      setStatus("还没有草稿。先按 Alt+Shift+G 或点「生成回复」。", "error");
      return;
    }
    const i = ((index % currentDrafts.length) + currentDrafts.length) % currentDrafts.length;
    currentDraftIndex = i;
    markActiveDraft(i);
    insertIntoComposer(currentDrafts[i]);
    setStatus(`已填入第 ${i + 1}/${currentDrafts.length} 条（Alt+Shift+N 可切换下一条）。仍需你自己点发送。`, "ok");
  }

  function fillFirstDraft() {
    fillDraftAt(0);
  }

  function cycleNextDraft() {
    if (!currentDrafts.length) {
      setStatus("还没有草稿。先生成再切换。", "error");
      return;
    }
    fillDraftAt(currentDraftIndex + 1);
  }

  async function submitDraftFeedback(rating, draftText, itemEl, reason) {
    const payload = {
      personaId: activePersonaId || "default",
      postSnippet: lastGenContext.postSnippet || "",
      draft: String(draftText || ""),
      rating: rating === "down" ? "down" : "up",
      reason: String(reason || "").trim(),
      modes: lastGenContext.modes || [],
    };
    try {
      const res = await chrome.runtime.sendMessage({ type: "SAVE_REPLY_FEEDBACK", payload });
      if (!res?.ok) {
        setStatus(res?.error || "评价保存失败", "error");
        return false;
      }
      const label = rating === "down" ? "不行" : "满意";
      setStatus(`已记「${label}」${payload.reason ? "（含理由）" : ""}。共 ${res.count || "?"} 条，下次生成会参考。`, "ok");
      if (itemEl) {
        itemEl.querySelectorAll(".xrh-fb-up, .xrh-fb-down").forEach((b) => {
          b.classList.remove("active");
          b.disabled = true;
        });
        const activeBtn = itemEl.querySelector(rating === "down" ? ".xrh-fb-down" : ".xrh-fb-up");
        if (activeBtn) activeBtn.classList.add("active");
        const reasonRow = itemEl.querySelector(".xrh-feedback-reason");
        if (reasonRow) reasonRow.hidden = true;
      }
      return true;
    } catch (err) {
      setStatus(`评价保存失败：${err?.message || err}`, "error");
      return false;
    }
  }

  function renderReplies(replies, modes = [], opts = {}) {
    const root = ensureRoot();
    const list = root.querySelector('[data-xrh="list"]');
    const inboxPanel = root.querySelector('[data-xrh="inbox-panel"]');
    if (inboxPanel) inboxPanel.hidden = true;
    const chooser = root.querySelector('[data-xrh="chooser-hint"]');
    if (chooser) {
      const multi = !!opts.multiAngle || (replies || []).length >= 5;
      chooser.hidden = !multi;
      chooser.textContent = multi
        ? "多角度：点一条「填入」选角度（认同 / 补充 / 异议 / 玩笑 / 答问）"
        : "";
    }
    list.innerHTML = "";
    currentDrafts = (replies || []).map(String);
    currentDraftIndex = 0;
    if (Array.isArray(modes)) {
      lastGenContext.modes = modes.map(String);
    }
    if (typeof opts.multiAngle === "boolean") {
      lastGenContext.multiAngle = opts.multiAngle;
    }
    replies.forEach((text, idx) => {
      const item = document.createElement("div");
      item.className = "xrh-item" + (idx === 0 ? " xrh-item-active" : "");
      const modeLabel = modes[idx];
      if (modeLabel) {
        const badge = document.createElement("span");
        badge.className = "xrh-item-mode";
        badge.textContent = modeLabel;
        item.appendChild(badge);
      }
      const p = document.createElement("p");
      p.className = "xrh-item-text";
      p.textContent = text;
      const actions = document.createElement("div");
      actions.className = "xrh-item-actions";

      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "xrh-copy";
      copyBtn.textContent = "复制";
      copyBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(text);
          copyBtn.textContent = "已复制";
          setTimeout(() => { copyBtn.textContent = "复制"; }, 1500);
        } catch {
          const ta = document.createElement("textarea");
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          ta.remove();
          copyBtn.textContent = "已复制";
          setTimeout(() => { copyBtn.textContent = "复制"; }, 1500);
        }
      });

      const insertBtn = document.createElement("button");
      insertBtn.type = "button";
      insertBtn.className = "xrh-insert";
      insertBtn.textContent = idx === 0 ? "填入回复框 ★" : "填入回复框";
      insertBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        currentDraftIndex = idx;
        markActiveDraft(idx);
        insertIntoComposer(text);
      });

      const upBtn = document.createElement("button");
      upBtn.type = "button";
      upBtn.className = "xrh-fb-up";
      upBtn.title = "满意：下次多写这种";
      upBtn.textContent = "👍满意";
      const downBtn = document.createElement("button");
      downBtn.type = "button";
      downBtn.className = "xrh-fb-down";
      downBtn.title = "不行：下次少写这种";
      downBtn.textContent = "👎不行";

      const reasonRow = document.createElement("div");
      reasonRow.className = "xrh-feedback-reason";
      reasonRow.hidden = true;
      const reasonInput = document.createElement("input");
      reasonInput.type = "text";
      reasonInput.className = "xrh-feedback-input";
      reasonInput.placeholder = "可选：一句话理由";
      reasonInput.maxLength = 200;
      const reasonSkip = document.createElement("button");
      reasonSkip.type = "button";
      reasonSkip.className = "xrh-fb-skip";
      reasonSkip.textContent = "跳过";
      const reasonOk = document.createElement("button");
      reasonOk.type = "button";
      reasonOk.className = "xrh-fb-submit";
      reasonOk.textContent = "提交";
      let pendingRating = null;

      function openReason(rating) {
        pendingRating = rating;
        reasonRow.hidden = false;
        reasonInput.value = "";
        reasonInput.focus();
        upBtn.classList.toggle("pending", rating === "up");
        downBtn.classList.toggle("pending", rating === "down");
      }

      upBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openReason("up");
      });
      downBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openReason("down");
      });
      reasonOk.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!pendingRating) return;
        await submitDraftFeedback(pendingRating, text, item, reasonInput.value);
      });
      reasonSkip.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!pendingRating) return;
        await submitDraftFeedback(pendingRating, text, item, "");
      });
      reasonInput.addEventListener("keydown", async (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          if (!pendingRating) return;
          await submitDraftFeedback(pendingRating, text, item, reasonInput.value);
        }
      });

      reasonRow.appendChild(reasonInput);
      reasonRow.appendChild(reasonSkip);
      reasonRow.appendChild(reasonOk);

      actions.appendChild(copyBtn);
      actions.appendChild(insertBtn);
      actions.appendChild(upBtn);
      actions.appendChild(downBtn);
      item.appendChild(p);
      item.appendChild(actions);
      item.appendChild(reasonRow);
      list.appendChild(item);
    });
  }

  function looksLikeRateLimit(errText, errorCode) {
    if (errorCode === "rate_limit") return true;
    const s = String(errText || "").toLowerCase();
    return (
      s.includes("rate limit") ||
      s.includes("rate_limit") ||
      s.includes("429") ||
      s.includes("too many") ||
      s.includes("quota") ||
      s.includes("限流") ||
      s.includes("频率")
    );
  }

  function looksLikeTimeout(errText, errorCode) {
    if (errorCode === "timeout") return true;
    const s = String(errText || "").toLowerCase();
    return s.includes("timeout") || s.includes("timed out") || s.includes("超时") || s.includes("aborted");
  }

  /**
   * 手动生成前，尽量展开当前页面的「更多回复」；自动生成不展开，避免打扰。
   */
  async function expandVisibleReplies(maxClicks = 2) {
    const buttons = qsa('button, [role="button"]')
      .filter((el) => {
        const t = (el.innerText || "").trim();
        return /show more replies|显示更多回复|更多回复|查看更多回复/i.test(t);
      })
      .slice(0, maxClicks);
    if (!buttons.length) return;
    for (const b of buttons) {
      try {
        b.click();
      } catch {
        // ignore
      }
      await new Promise((r) => setTimeout(r, 700));
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  /**
   * @param {{ source?: "manual"|"auto", forceRefresh?: boolean, multiAngle?: boolean, replyToComment?: boolean|object }} opts
   */
  async function onGenerate(opts = {}) {
    const source = opts.source || "manual";
    const multiAngle = !!opts.multiAngle;
    if (generating) return;
    ensureRoot();
    const root = document.getElementById(ROOT_ID);
    const btn = root?.querySelector('[data-xrh="generate"]');
    const multiBtn = root?.querySelector('[data-xrh="multi"]');
    const list = root?.querySelector('[data-xrh="list"]');

    if (source !== "auto") await expandVisibleReplies();

    // Resolve楼中楼 target: explicit opts / active / focused composer
    let replyTargetArt = null;
    if (opts.replyToComment && opts.replyToComment !== true && opts.replyToComment.article) {
      replyTargetArt = opts.replyToComment.article;
    } else if (opts.replyToComment === true && activeReplyToComment?.article) {
      replyTargetArt = activeReplyToComment.article;
    } else if (source === "manual") {
      replyTargetArt = detectReplyTargetFromComposer();
      if (replyTargetArt) setActiveReplyToComment(replyTargetArt);
    }

    let scraped;
    let replyToComment = null;
    let siblingReplies = [];
    let threadTextsExtra = [];

    if (replyTargetArt || (activeReplyToComment && opts.replyToComment !== false && source === "manual")) {
      const built = buildReplyToCommentPayload(replyTargetArt || activeReplyToComment?.article);
      scraped = built.scraped;
      replyToComment = built.replyToComment;
      siblingReplies = built.siblingReplies || [];
      threadTextsExtra = built.threadTexts || [];
      if (replyToComment) {
        activeReplyToComment = {
          ...replyToComment,
          threadTexts: threadTextsExtra,
          siblingReplies,
          article: built.targetArticle || replyTargetArt,
        };
        setCommentHighlight(built.targetArticle || replyTargetArt);
      } else {
        clearActiveReplyToComment();
      }
    } else {
      scraped = scrapePostAndComments();
      if (source === "auto") clearActiveReplyToComment();
    }

    const {
      postText,
      quotedText,
      comments,
      commentTotal,
      author,
      authorHandle,
      authorRecent,
      postId,
      mainArticle,
    } = scraped;
    let threadTexts = Array.isArray(scraped.threadTexts) ? scraped.threadTexts.slice() : [];
    if (replyToComment && threadTextsExtra.length) {
      threadTexts = threadTextsExtra;
    }

    if (!postText) {
      if (source === "manual") {
        setStatus("没读到帖子正文。请确认在单条帖子页或回复弹窗，并等页面加载完再试。", "error");
      }
      return;
    }

    const postKeyBase = postId || getPostKey();
    const postKey = replyToComment?.statusId
      ? `${postKeyBase}:c:${replyToComment.statusId}`
      : replyToComment
        ? `${postKeyBase}:c:${normalizeCommentText(replyToComment.text).slice(0, 40)}`
        : postKeyBase;
    const sourceArt = mainArticle || findMainArticleFromScrape(scraped);
    setSourceHighlight(sourceArt, {
      authorHandle,
      postText,
      replyToComment: replyToComment || null,
    });
    if (replyToComment && (replyTargetArt || activeReplyToComment?.article)) {
      setCommentHighlight(replyTargetArt || activeReplyToComment.article);
    } else {
      clearCommentHighlight();
    }
    clearNextAutoGuide();
    const alreadyShown =
      lastRenderedKey === postKey && list && list.children && list.children.length > 0;
    // 已有草稿时再点手动生成 → 强制刷新；自动生成优先走缓存
    const forceRefresh =
      !!opts.forceRefresh || (source === "manual" && alreadyShown);

    if (list) list.innerHTML = "";

    if (source === "auto") {
      if (autoDoneKeys.has(postKey)) return;
      autoDoneKeys.add(postKey);
    capAutoDoneKeys();
    }

    generating = true;
    setToolbarBusy(true);
    if (btn) {
      btn.disabled = true;
      btn.textContent = multiAngle ? "生成中…" : (forceRefresh ? "刷新中…" : "生成中…");
    }
    if (multiBtn) {
      multiBtn.disabled = true;
      multiBtn.textContent = multiAngle ? "多角度…" : "多角度";
    }

    const ctxBits = [];
    if (threadTexts.length) ctxBits.push(`线程 ${threadTexts.length}`);
    if (authorRecent.length) ctxBits.push(`作者近帖 ${authorRecent.length}`);
    const ctxHint = ctxBits.length ? `，上下文：${ctxBits.join(" / ")}` : "";

    const rtcHint = replyToComment
      ? `；楼中楼回 @${(replyToComment.handle || "").replace(/^@/, "") || "?"}「${String(replyToComment.text || "").replace(/\s+/g, " ").slice(0, 24)}」`
      : "";
    setStatus(
      `${multiAngle ? "多角度：" : ""}${source === "auto" ? "自动生成：" : ""}${forceRefresh ? "强制刷新：" : ""}已抓取正文 ${postText.length} 字、精选评论 ${comments.length}/${commentTotal ?? comments.length} 条${ctxHint}${authorHandle ? `（@${authorHandle}）` : author ? `（作者：${author.split(" ")[0]}）` : ""}${rtcHint}。正在调用模型…`
    );

    try {
      const commentsForPrompt = replyToComment
        ? [
            ...siblingReplies.slice(0, 4),
            ...comments.filter((c) => !String(c).includes(String(replyToComment.text || "").slice(0, 40))).slice(0, 8),
          ]
        : comments;

      const result = await chrome.runtime.sendMessage({
        type: "GENERATE_REPLIES",
        payload: {
          postText,
          quotedText,
          comments: commentsForPrompt,
          author,
          authorHandle,
          threadTexts,
          authorRecent,
          postId: postKey,
          url: location.href,
          forceRefresh,
          multiAngle,
          replyToComment: replyToComment
            ? {
                text: replyToComment.text,
                author: replyToComment.author,
                handle: replyToComment.handle,
                statusId: replyToComment.statusId || "",
              }
            : null,
          siblingReplies,
        },
      });

      if (!result?.ok) {
        const retryAction = result?.retryable !== false
          ? { label: "重试", onClick: () => onGenerate({ source: "manual", forceRefresh: true, multiAngle }) }
          : null;
        if (looksLikeRateLimit(result?.error, result?.errorCode)) {
          autoPausedUntil = Date.now() + 60_000;
          setStatus(
            (result?.error || "触发限流") + "\n已暂停自动生成 60 秒；可稍后再点「重试」或闪电手动生成。",
            "error",
            retryAction
          );
        } else if (looksLikeTimeout(result?.error, result?.errorCode)) {
          setStatus(
            (result?.error || "请求超时") + "\n可点「重试」。若用 OpenCode Go，请确认 Endpoint 正确（扩展会自动带 x-opencode-session）。",
            "error",
            retryAction
          );
        } else if (result?.needSetup) {
          setStatus(result.error + "\n也可点旁边的「设置」填写 API Key。", "error");
        } else {
          setStatus(result?.error || "生成失败", "error", retryAction);
        }
        return;
      }

      clearStatusActions();

      const replies = result.replies || [];
      lastGenContext = {
        postSnippet: String(postText || "").slice(0, 200),
        modes: Array.isArray(result.modes) ? result.modes.map(String) : [],
        multiAngle: multiAngle || !!result.multiAngle,
      };
      renderReplies((replies || []).slice(0, 5), result.modes || [], { multiAngle: multiAngle || !!result.multiAngle });
      lastRenderedKey = postKey;
      capAutoDoneKeys();

      const shouldAutoFill =
        typeof result.autoFillFirst === "boolean" ? result.autoFillFirst : autoFillFirst;

      const modeHint =
        Array.isArray(result.modes) && result.modes.length
          ? `（${result.modes.join(" / ")}）`
          : "";
      let statusMsg;
      const msBit =
        typeof result.elapsedMs === "number" && result.elapsedMs >= 0
          ? ` · ${result.elapsedMs}ms`
          : "";
      const modeBit =
        result.fastMode === false
          ? " · 质量"
          : result.fastMode
            ? " · 快速"
            : "";
      const filterBit =
        typeof result.filteredDropped === "number" && result.filteredDropped > 0
          ? ` · 已滤掉 ${result.filteredDropped} 条踩雷相似`
          : "";
      if (result.cached) {
        statusMsg = `缓存命中（约 ${result.cacheAgeSec || "?"} 秒前），${replies.length} 条草稿${modeHint}${modeBit}${msBit}${filterBit}。再点「生成」可强制刷新。`;
      } else {
        statusMsg = `已生成 ${replies.length} 条草稿${modeHint}${source === "auto" ? "（自动）" : ""}${modeBit}${msBit}${filterBit}，点「填入」/「复制」，或 👍/👎 评价；仍需手动发送。`;
      }
      setStatus(statusMsg, "ok");
      if (autoGenerateEnabled) {
        try { updateNextAutoGuide(); } catch { /* ignore */ }
      }

      if (shouldAutoFill && replies[0]) {
        // slight delay so panel paints first
        setTimeout(() => insertIntoComposer(replies[0]), 80);
      }
    } catch (err) {
      setStatus(`扩展通信失败：${err?.message || err}`, "error");
    } finally {
      generating = false;
      setToolbarBusy(false);
      if (btn) {
        btn.disabled = false;
        btn.textContent = "生成回复";
      }
      if (multiBtn) {
        multiBtn.disabled = false;
        multiBtn.textContent = "多角度";
      }
      if (autoGenerateEnabled) {
        try { updateNextAutoGuide(); } catch { /* ignore */ }
      }
    }
  }

  function scheduleAutoGenerate() {
    if (!autoGenerateEnabled) {
      clearNextAutoGuide();
      return;
    }
    if (!isReplyContext()) return;
    try { updateNextAutoGuide(); } catch { /* ignore */ }
    if (Date.now() < autoPausedUntil) return;
    if (generating) return;

    if (autoTimer) clearTimeout(autoTimer);
    autoTimer = setTimeout(() => {
      autoTimer = null;
      maybeAutoGenerate();
    }, 600);
  }

  function maybeAutoGenerate() {
    if (!autoGenerateEnabled) return;
    if (!isReplyContext()) return;
    if (Date.now() < autoPausedUntil) return;
    if (generating) return;

    const toolBar = qs('[data-testid="toolBar"]');
    const composer = findComposerBox();
    if (!toolBar && !composer && !isStatusPage()) return;

    const { postText } = scrapePostAndComments();
    if (!postText) return;

    const postKey = getPostKey();
    if (autoDoneKeys.has(postKey)) return;

    ensureRoot();
    const root = document.getElementById(ROOT_ID);
    root?.classList.remove("xrh-collapsed");
    onGenerate({ source: "auto" });
  }


  let inboxTimer = null;
  let inboxBusy = false;

  function getSelfHandle() {
    const profile = qs('a[data-testid="AppTabBar_Profile_Link"]') || qs('a[href][aria-label*="Profile" i]');
    const href = profile?.getAttribute?.("href") || "";
    const m = href.match(/^\/([A-Za-z0-9_]{1,15})(?:\/|$)/);
    if (m && !SKIP_HANDLES.has(m[1].toLowerCase())) return m[1];
    // fallback: account switcher
    const sw = qs('[data-testid="SideNav_AccountSwitcher_Button"]');
    const t = (sw?.innerText || "").trim();
    const at = t.match(/@([A-Za-z0-9_]{1,15})/);
    return at ? at[1] : "";
  }

  function markCurrentStatusReplied() {
    const m = location.href.match(/status\/(\d+)/i);
    const statusId = m ? m[1] : "";
    if (!statusId) return;
    chrome.runtime
      .sendMessage({ type: "INBOX_MARK_REPLIED", payload: { id: statusId, statusId } })
      .then(() => refreshInboxPanel())
      .catch(() => {});
  }

  function scheduleInboxScrape() {
    if (!isNotificationsOrMentionsPage()) return;
    const now = Date.now();
    const wait = Math.max(INBOX_SCRAPE_MIN_MS - (now - lastInboxScrapeAt), 800);
    if (inboxTimer) clearTimeout(inboxTimer);
    inboxTimer = setTimeout(() => {
      inboxTimer = null;
      if (!isNotificationsOrMentionsPage()) return;
      lastInboxScrapeAt = Date.now();
      runWhenIdle(() => scrapeAndUpsertInbox(), 1200);
    }, wait);
  }

  /**
   * Best-effort: scrape visible notification / mention cards into「今日待回」.
   * Cannot reliably know if you already replied without X write API.
   */
  function scrapeNotificationsCards() {
    const self = (getSelfHandle() || "").toLowerCase();
    const items = [];
    const cells = qsa('[data-testid="cellInnerDiv"], article, [data-testid="notification"]');
    const seen = new Set();

    for (const cell of cells) {
      const links = qsa('a[href*="/status/"]', cell);
      let statusUrl = "";
      let statusId = "";
      for (const a of links) {
        const href = a.getAttribute("href") || "";
        const m = href.match(/\/([^/?#]+)\/status\/(\d+)/i) || href.match(/status\/(\d+)/i);
        if (!m) continue;
        if (m.length >= 3) {
          statusId = m[2];
          statusUrl = href.startsWith("http") ? href : `https://x.com${href.split("?")[0]}`;
        } else {
          statusId = m[1];
          statusUrl = href.startsWith("http") ? href : `https://x.com${href.split("?")[0]}`;
        }
        if (statusId) break;
      }
      if (!statusId || seen.has(statusId)) continue;

      const raw = (cell.innerText || "").replace(/\s+/g, " ").trim();
      if (!raw || raw.length < 8) continue;

      // Skip pure likes/follows/reposts without reply intent when obvious
      const kindHint = raw.slice(0, 80);
      let kind = "interaction";
      if (/replied|回复了|回覆了|mentioned|提及|提到了|quoted|引用了/i.test(kindHint)) kind = "reply";
      else if (/liked|喜欢了|喜歡了|followed|关注了|關注了|repost|转帖|轉發/i.test(kindHint) &&
               !/replied|回复|提及|mentioned|quoted|引用/i.test(kindHint)) {
        // likes/follows: skip for unreplied inbox
        continue;
      }

      let from = "";
      const user = qs('[data-testid="User-Name"]', cell);
      if (user) {
        const at = (user.innerText || "").match(/@([A-Za-z0-9_]{1,15})/);
        from = at ? at[1] : (user.innerText || "").split("\n")[0].trim();
      }
      if (self && from && from.toLowerCase() === self) continue;

      const preview = raw.slice(0, 160);
      seen.add(statusId);
      items.push({
        id: statusId,
        statusId,
        url: statusUrl || `https://x.com/i/status/${statusId}`,
        from,
        preview,
        kind,
        ts: Date.now(),
        source: isNotificationsOrMentionsPage() ? "notifications" : "dom",
      });
      if (items.length >= 40) break;
    }
    return items;
  }

  async function scrapeAndUpsertInbox() {
    if (inboxBusy) return;
    if (!isNotificationsOrMentionsPage()) return;
    const items = scrapeNotificationsCards();
    if (!items.length) return;
    inboxBusy = true;
    try {
      await chrome.runtime.sendMessage({ type: "INBOX_UPSERT", payload: { items } });
      const root = document.getElementById(ROOT_ID);
      if (root && root.querySelector('[data-xrh="inbox-panel"]:not([hidden])')) {
        await refreshInboxPanel();
      }
    } catch {
      // ignore
    } finally {
      inboxBusy = false;
    }
  }

  async function toggleInboxPanel() {
    const root = ensureRoot();
    root.classList.remove("xrh-collapsed");
    const panel = root.querySelector('[data-xrh="panel"]');
    const inbox = root.querySelector('[data-xrh="inbox-panel"]');
    const list = root.querySelector('[data-xrh="list"]');
    if (!panel || !inbox) return;
    panel.hidden = false;
    const opening = inbox.hidden;
    inbox.hidden = !opening;
    if (opening) {
      if (list) list.innerHTML = "";
      const chooser = root.querySelector('[data-xrh="chooser-hint"]');
      if (chooser) chooser.hidden = true;
      if (isNotificationsOrMentionsPage()) await scrapeAndUpsertInbox();
      await refreshInboxPanel();
    }
  }

  async function refreshInboxPanel() {
    const root = document.getElementById(ROOT_ID) || ensureRoot();
    const host = root.querySelector('[data-xrh="inbox-list"]');
    const status = root.querySelector('[data-xrh="inbox-status"]');
    const inbox = root.querySelector('[data-xrh="inbox-panel"]');
    if (!host || !status) return;
    try {
      const result = await chrome.runtime.sendMessage({ type: "INBOX_LIST" });
      if (!result?.ok) {
        status.textContent = result?.error || "读取待回失败";
        status.className = "xrh-status error";
        return;
      }
      const items = result.items || [];
      status.className = "xrh-status ok";
      status.textContent = items.length
        ? `今日待回 ${items.length} 条（尽力抓取，可能漏检）`
        : "今日暂无待回。打开通知/提及页刷一下再点「待回」。";
      host.innerHTML = "";
      for (const it of items) {
        const row = document.createElement("div");
        row.className = "xrh-inbox-item";
        const meta = document.createElement("div");
        meta.className = "xrh-inbox-meta";
        meta.textContent = `${it.from ? "@" + it.from + " · " : ""}${it.kind || "interaction"}`;
        const prev = document.createElement("div");
        prev.className = "xrh-inbox-preview";
        prev.textContent = it.preview || it.statusId || "";
        const actions = document.createElement("div");
        actions.className = "xrh-item-actions";

        const openBtn = document.createElement("a");
        openBtn.className = "xrh-inbox-link";
        openBtn.href = it.url || `https://x.com/i/status/${it.statusId}`;
        openBtn.target = "_blank";
        openBtn.rel = "noopener noreferrer";
        openBtn.textContent = "打开";

        const doneBtn = document.createElement("button");
        doneBtn.type = "button";
        doneBtn.className = "xrh-copy";
        doneBtn.textContent = "已回";
        doneBtn.addEventListener("click", async (e) => {
          e.preventDefault();
          e.stopPropagation();
          await chrome.runtime.sendMessage({
            type: "INBOX_MARK_REPLIED",
            payload: { id: it.id, statusId: it.statusId },
          });
          await refreshInboxPanel();
        });

        const skipBtn = document.createElement("button");
        skipBtn.type = "button";
        skipBtn.className = "xrh-copy";
        skipBtn.textContent = "忽略";
        skipBtn.addEventListener("click", async (e) => {
          e.preventDefault();
          e.stopPropagation();
          await chrome.runtime.sendMessage({ type: "INBOX_DISMISS", payload: { id: it.id } });
          await refreshInboxPanel();
        });

        actions.appendChild(openBtn);
        actions.appendChild(doneBtn);
        actions.appendChild(skipBtn);
        row.appendChild(meta);
        row.appendChild(prev);
        row.appendChild(actions);
        host.appendChild(row);
      }
      if (inbox && !inbox.hidden) {
        // badge on button
        const btn = root.querySelector('[data-xrh="inbox"]');
        if (btn) btn.textContent = items.length ? `待回(${items.length})` : "待回";
      }
    } catch (err) {
      status.className = "xrh-status error";
      status.textContent = "读取待回失败：" + (err?.message || err);
    }
  }


  function loadSettings() {
    chrome.storage.sync.get(
      {
        autoGenerate: false,
        cacheEnabled: true,
        autoFillFirst: false,
        commentLimit: 15,
        likeAfterReply: false,
        fastMode: true,
        qualityFirst: false,
        memorySaver: true,
      },
      (data) => {
        autoGenerateEnabled = !!data.autoGenerate;
        cacheEnabled = data.cacheEnabled !== false;
        autoFillFirst = !!data.autoFillFirst;
        commentLimit = Math.max(8, Math.min(30, Number(data.commentLimit) || 15));
        likeAfterReply = !!data.likeAfterReply;
        fastMode = data.fastMode !== false;
        qualityFirst = !!data.qualityFirst;
        memorySaver = data.memorySaver !== false;
        const root = document.getElementById(ROOT_ID);
        if (root) syncPanelToggles(root);
        scheduleAutoGenerate();
      }
    );
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    if (changes.autoGenerate) {
      autoGenerateEnabled = !!changes.autoGenerate.newValue;
      if (autoGenerateEnabled) scheduleAutoGenerate();
      else clearNextAutoGuide();
    }
    if (changes.cacheEnabled) {
      cacheEnabled = changes.cacheEnabled.newValue !== false;
    }
    if (changes.autoFillFirst) {
      autoFillFirst = !!changes.autoFillFirst.newValue;
    }
    if (changes.commentLimit) {
      commentLimit = Math.max(8, Math.min(30, Number(changes.commentLimit.newValue) || 15));
    }
    if (changes.likeAfterReply) {
      likeAfterReply = !!changes.likeAfterReply.newValue;
    }
    if (changes.fastMode) {
      fastMode = changes.fastMode.newValue !== false;
    }
    if (changes.qualityFirst) {
      qualityFirst = !!changes.qualityFirst.newValue;
    }
    if (changes.memorySaver) {
      memorySaver = changes.memorySaver.newValue !== false;
      // re-apply reply-this caps by pruning extras
      try {
        const btns = document.querySelectorAll("." + REPLY_THIS_CLASS);
        const max = replyThisMax();
        if (btns.length > max) {
          Array.from(btns).slice(max).forEach((b) => b.remove());
        }
      } catch { /* ignore */ }
    }
    if (changes.likeAfterReply || changes.fastMode || changes.qualityFirst) {
      const root = document.getElementById(ROOT_ID);
      if (root) syncPanelToggles(root);
    }
    if (changes.personaId) {
      activePersonaId = changes.personaId.newValue || "default";
      const root = document.getElementById(ROOT_ID);
      if (root) refreshPersonaChips(root);
    }
  });

  function onUrlChange() {
    lastUrl = location.href;
    lastRenderedKey = "";
    clearSourceHighlight();
    clearCommentHighlight();
    clearNextAutoGuide();
    clearActiveReplyToComment();
    if (replyThisIO) {
      try { replyThisIO.disconnect(); } catch { /* ignore */ }
      replyThisIO = null;
    }
    qsa("." + REPLY_THIS_CLASS).forEach((el) => el.remove());
    const old = document.getElementById(ROOT_ID);
    if (old) old.remove();
    qsa(`#${TB_BTN_ID}, .${TB_CLASS}`).forEach((el) => el.remove());
    if (autoTimer) {
      clearTimeout(autoTimer);
      autoTimer = null;
    }
    capAutoDoneKeys();
    scheduleMount();
  }

  function mutationLooksRelevant(mutations) {
    // Shallow: only care about added nodes that might be tweets / composer / notifications
    for (const m of mutations) {
      if (m.type !== "childList" || !m.addedNodes || !m.addedNodes.length) continue;
      for (const node of m.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.id === ROOT_ID || node.classList?.contains("xrh-root")) continue;
        if (node.classList?.contains(REPLY_THIS_CLASS) || node.classList?.contains(TB_CLASS)) continue;
        if (node.closest?.("#" + ROOT_ID)) continue;
        const tag = node.tagName;
        if (tag === "ARTICLE") return true;
        if (node.getAttribute?.("data-testid") === "cellInnerDiv") return true;
        if (node.getAttribute?.("data-testid") === "toolBar") return true;
        if (node.getAttribute?.("data-testid") === "tweetTextarea_0") return true;
        // shallow child peek only (depth 1)
        if (node.querySelector?.(':scope > article[data-testid="tweet"], :scope > [data-testid="cellInnerDiv"], :scope > [data-testid="toolBar"]')) {
          return true;
        }
        if (tag === "DIV" && node.childElementCount > 0 && node.childElementCount < 12) {
          for (const child of node.children) {
            if (child.tagName === "ARTICLE") return true;
            if (child.getAttribute?.("data-testid") === "toolBar") return true;
          }
        }
      }
    }
    return false;
  }

  if (observer) {
    try { observer.disconnect(); } catch { /* ignore */ }
  }
  let moPending = false;
  let moTimer = null;
  let observerAttached = false;

  function attachMutationObserver() {
    if (!observer || observerAttached || document.hidden) return;
    try {
      observer.observe(document.documentElement, { childList: true, subtree: true });
      observerAttached = true;
    } catch { /* ignore */ }
  }
  function detachMutationObserver() {
    if (!observer) return;
    try { observer.disconnect(); } catch { /* ignore */ }
    observerAttached = false;
    if (moTimer) {
      clearTimeout(moTimer);
      moTimer = null;
    }
    moPending = false;
  }

  observer = new MutationObserver((mutations) => {
    if (observerPaused || document.hidden) return;
    // Do not retain MutationRecord nodes beyond this tick
    let relevant = false;
    try {
      relevant = mutationLooksRelevant(mutations);
    } finally {
      // drop references ASAP
      mutations = null;
    }
    if (location.href !== lastUrl) {
      onUrlChange();
      return;
    }
    if (moPending) return;
    if (!relevant) return;
    moPending = true;
    moTimer = setTimeout(() => {
      moTimer = null;
      moPending = false;
      if (observerPaused || document.hidden) return;
      if (location.href !== lastUrl) {
        onUrlChange();
        return;
      }
      if (isNotificationsOrMentionsPage()) {
        if (!document.getElementById(ROOT_ID)) scheduleMount();
        // memorySaver: still only scrape notif/mentions (never other pages)
        scheduleInboxScrape();
        return;
      }
      if (!isReplyContext()) return;
      const tb = qs('[data-testid="toolBar"]');
      const btn = document.getElementById(TB_BTN_ID);
      const root = document.getElementById(ROOT_ID);
      if (!root || !btn || (tb && btn && !tb.contains(btn))) {
        scheduleMount();
      } else {
        scheduleInjectReplyThis();
      }
    }, MOUNT_DEBOUNCE_MS);
  });
  attachMutationObserver();

  function teardownObserversAndTimers() {
    detachMutationObserver();
    if (replyThisIO) {
      try { replyThisIO.disconnect(); } catch { /* ignore */ }
      replyThisIO = null;
    }
    if (mountTimer) {
      clearTimeout(mountTimer);
      mountTimer = null;
    }
    cancelMountIdle();
    if (autoTimer) {
      clearTimeout(autoTimer);
      autoTimer = null;
    }
    if (inboxTimer) {
      clearTimeout(inboxTimer);
      inboxTimer = null;
    }
    if (replyThisInjectTimer) {
      clearTimeout(replyThisInjectTimer);
      replyThisInjectTimer = null;
    }
    if (scrollGuideTimer) {
      clearTimeout(scrollGuideTimer);
      scrollGuideTimer = null;
    }
    if (guideRaf) {
      try { cancelAnimationFrame(guideRaf); } catch { /* ignore */ }
      guideRaf = 0;
    }
    highlightedArticle = null;
    nextAutoGuideArticle = null;
    highlightedCommentArticle = null;
    activeReplyToComment = null;
    currentDrafts = [];
    lastGenContext = { postSnippet: "", modes: [], multiAngle: false };
    capAutoDoneKeys();
  }

  function onVisibilityChange() {
    if (document.hidden) {
      detachMutationObserver();
      if (replyThisIO) {
        try { replyThisIO.disconnect(); } catch { /* ignore */ }
        // keep instance null so next inject rebuilds with current memorySaver margin
        replyThisIO = null;
      }
      if (moTimer) {
        clearTimeout(moTimer);
        moTimer = null;
      }
      moPending = false;
    } else {
      attachMutationObserver();
      if (isReplyContext() || isStatusPage()) scheduleInjectReplyThis();
      scheduleMount();
    }
  }
  document.addEventListener("visibilitychange", onVisibilityChange);

  window.addEventListener("pagehide", () => {
    teardownObserversAndTimers();
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("scroll", onScrollOrResizeGuide, true);
    window.removeEventListener("resize", onScrollOrResizeGuide);
  }, { once: true });

  function handleHotkeyCommand(command) {
    if (!isReplyContext()) return;
    ensureRoot();
    const root = document.getElementById(ROOT_ID);
    root?.classList.remove("xrh-collapsed");
    if (command === "generate-replies") {
      onGenerate({ source: "manual" });
    } else if (command === "fill-first-draft") {
      fillFirstDraft();
    } else if (command === "cycle-next-draft") {
      cycleNextDraft();
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "HOTKEY" && message.command) {
      handleHotkeyCommand(message.command);
    }
  });

  // Fallback when chrome.commands doesn't fire (focus inside page)
  document.addEventListener(
    "keydown",
    (e) => {
      if (!(e.altKey && e.shiftKey) || e.ctrlKey || e.metaKey) return;
      const key = (e.key || "").toLowerCase();
      let command = "";
      if (key === "g") command = "generate-replies";
      else if (key === "f") command = "fill-first-draft";
      else if (key === "n") command = "cycle-next-draft";
      if (!command) return;
      if (!isReplyContext()) return;
      e.preventDefault();
      e.stopPropagation();
      handleHotkeyCommand(command);
    },
    true
  );

  function onScrollOrResizeGuide() {
    if (!autoGenerateEnabled) return;
    const now = Date.now();
    // memorySaver: during fast scroll, coalesce to one rAF and skip badge thrash
    if (memorySaver) {
      scrollFastUntil = now + 180;
      if (guideRaf) return;
      guideRaf = requestAnimationFrame(() => {
        guideRaf = 0;
        if (Date.now() < scrollFastUntil) {
          // still scrolling — schedule trailing update
          if (scrollGuideTimer) clearTimeout(scrollGuideTimer);
          scrollGuideTimer = setTimeout(() => {
            scrollGuideTimer = null;
            lastGuideUpdateAt = Date.now();
            try { updateNextAutoGuide(); } catch { /* ignore */ }
          }, SCROLL_THROTTLE_MS);
          return;
        }
        if (Date.now() - lastGuideUpdateAt < SCROLL_THROTTLE_MS - 50) return;
        lastGuideUpdateAt = Date.now();
        try { updateNextAutoGuide(); } catch { /* ignore */ }
      });
      return;
    }
    if (scrollGuideTimer) clearTimeout(scrollGuideTimer);
    scrollGuideTimer = setTimeout(() => {
      scrollGuideTimer = null;
      if (Date.now() - lastGuideUpdateAt < SCROLL_THROTTLE_MS - 50) return;
      lastGuideUpdateAt = Date.now();
      try { updateNextAutoGuide(); } catch { /* ignore */ }
    }, SCROLL_THROTTLE_MS);
  }
  window.addEventListener("scroll", onScrollOrResizeGuide, { passive: true, capture: true });
  window.addEventListener("resize", onScrollOrResizeGuide, { passive: true });

  // 聚焦回复框时：若在某条评论下，自动切到楼中楼目标
  document.addEventListener(
    "focusin",
    (e) => {
      const t = e.target;
      if (!t) return;
      const isCompose =
        t.getAttribute?.("data-testid") === "tweetTextarea_0" ||
        t.closest?.('[data-testid="tweetTextarea_0"]');
      if (!isCompose) return;
      try {
        const art = detectReplyTargetFromComposer();
        if (art) {
          setActiveReplyToComment(art);
        } else {
          // focused on root reply
          clearActiveReplyToComment();
          const scraped = scrapePostAndComments();
          updateSourceTargetLabel({
            authorHandle: scraped.authorHandle,
            postText: scraped.postText,
          });
        }
      } catch {
        // ignore
      }
    },
    true
  );

  loadSettings();
  loadPersonaState();
  installReplySendHook();

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => scheduleMount());
  } else {
    scheduleMount();
  }
})();
