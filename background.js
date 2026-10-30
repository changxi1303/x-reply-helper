/**
 * X 回复助手 - service worker
 * 读取 options 里的 API 配置，调用 OpenAI 兼容接口生成中文回复草稿（默认 3 条，或多角度最多 5 条）。
 * 不会代发帖子或评论。
 */

const DEFAULT_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL = "gpt-4o-mini";
const EXT_UA = "x-reply-helper/1.5.2";

const DEFAULT_PERSONA = `我是中文评论区随手回一句的普通人。说话像朋友刷到顺手打字：具体、短、有判断，不端着。

我说话的样子：
- 先接住原帖里一个具体的点，再讲自己的看法；没有具体点就只回一句短的。
- 句子短，允许半截句、口头语、省略主语。偶尔用「挺」「有点」「其实」「我这边」。
- 可以认同（夸到具体点上），也可以不同意（温和给理由）；原帖在提问时优先直接给能用的答案。
- 少问问题；三条里最多一条真好奇的问句，能不问就不问。
- 不总结、不升华、不教学、不列一二三。
- emoji 最多一个，能不用就不用。
- 不装熟、不抬杠、不阴阳，不编原帖没有的事。

不说：首先/其次/总之、值得注意的是、作为 AI、希望对你有帮助、赋能/落地/闭环、互关求赞。`;



const PERSONA_PRESETS = {
  default: {
    id: "default",
    label: "默认友善",
    text: null, // use DEFAULT_PERSONA
  },
  serena: {
    id: "serena",
    label: "Serena",
    text: `我是 Serena，在中文评论区随手回一句。语气偏温柔、体贴，但不矫情。

我平时聊生活、情绪、AI 小工具，也关心「怎么把事做得轻松一点」。

我说话的样子：
- 先接住对方的感受或处境，再补一句具体的小建议或共鸣。
- 句子软一点，但有内容；不空夸，也不鸡汤。
- 可以轻轻鼓励，但别喊口号；偶尔问一句关心式的问题（三条里最多一条）。
- 不总结升华、不列一二三、不装人生导师。
- emoji 最多一个，能不用就不用。

不说：首先/其次/总之、值得注意的是、作为 AI、希望对你有帮助、赋能/落地/闭环、互关求赞。`,
  },
  awe0: {
    id: "awe0",
    label: "awe0",
    text: `我是 awe0，在中文评论区随手回一句。语气偏产品/技术向：直接、有判断、少客套。

我平时聊 AI 产品、工作流、增长和工程取舍。

我说话的样子：
- 先抓一个可验证的点（成本、延迟、转化、可维护性），再给自己的判断。
- 句子短，允许半截句；更像同事在 PR 下随口评一句。
- 可以认同也可以否，但要有理由；别和稀泥。
- 偶尔追问一个真正影响决策的问题（三条里最多一条）。
- 不吹捧、不教做人、不写小作文。
- emoji 基本不用。

不说：首先/其次/总之、值得注意的是、作为 AI、希望对你有帮助、赋能/落地/闭环、互关求赞。`,
  },
  stanley: {
    id: "stanley",
    label: "Stanley",
    text: `我是 Stanley，在中文评论区随手回一句。语气偏机智、短促，偶尔带一点轻轻的吐槽，但不阴阳。

我平时聊互联网观察、AI 热闹和职场荒诞。

我说话的样子：
- 先点破原帖里一个好笑或扎眼的细节，再补一句自己的看法。
- 句子要短、有节奏；可以接梗，但别硬抖机灵。
- 认同就干脆夸到点上；不同意就一针见血，不绕。
- 三条里最多一条真问句。
- 不总结、不升华、不装深沉。
- emoji 最多一个。

不说：首先/其次/总之、值得注意的是、作为 AI、希望对你有帮助、赋能/落地/闭环、互关求赞。`,
  },
  custom: {
    id: "custom",
    label: "自定义",
    text: null, // use customPersonaText
  },
};

function listPersonaPresets() {
  return [
    { id: "default", label: PERSONA_PRESETS.default.label },
    { id: "serena", label: PERSONA_PRESETS.serena.label },
    { id: "awe0", label: PERSONA_PRESETS.awe0.label },
    { id: "stanley", label: PERSONA_PRESETS.stanley.label },
    { id: "custom", label: PERSONA_PRESETS.custom.label },
  ];
}

function resolvePersonaText(personaId, customPersonaText, personaTextFallback) {
  const id = PERSONA_PRESETS[personaId] ? personaId : "default";
  if (id === "custom") {
    return (customPersonaText || personaTextFallback || DEFAULT_PERSONA).trim() || DEFAULT_PERSONA;
  }
  if (id === "default") return DEFAULT_PERSONA;
  return (PERSONA_PRESETS[id].text || DEFAULT_PERSONA).trim() || DEFAULT_PERSONA;
}

const STYLE_EXAMPLES = [
  "这个我也踩过，最后是靠把提示词拆成三步才顺的。",
  "看到「本地跑」就放心了，数据不出门比速度快重要。",
  "40 秒能讲完的事拉成 10 分钟，算法爽了，人是真累。",
  "有个反例：同样的话我丢给三个模型，最便宜那个反而最像人。",
  "这一步是不是能直接跳过？我试下来没影响结果。",
  "存了，周末照着试一遍。",
  "贵不是问题，贵还没效果才是。",
].join("\n");

const REPLY_MODES = [
  { id: "hook", label: "共鸣", desc: "接住原帖的情绪或经历，说一句自己类似的感受，别抢戏" },
  { id: "add", label: "补充", desc: "补一个原帖没提到的信息、数据或反例，短一点" },
  { id: "exp", label: "经验", desc: "给一个自己踩过的坑或具体做法" },
  { id: "praise", label: "具体认同", desc: "只夸原帖一个具体细节，夸到点上" },
  { id: "dissent", label: "温和异议", desc: "只在真有分歧时用，给一句自己的判断，不抬杠" },
  { id: "joke", label: "接梗", desc: "顺着原帖的梗或语气开个小玩笑，别硬抖机灵" },
  { id: "ask", label: "追问", desc: "问一个你真好奇的具体问题，只问一个" },
  { id: "terse", label: "短反应", desc: "5 到 12 个字，像刷到顺手打的一句" },
];

/** 多角度固定 5 条（praise / 补充 / 温和异议 / 轻玩笑 / 答问或判断） */
const MULTI_ANGLE_MODES = [
  { id: "praise", label: "认同夸点", desc: "友善具体认同：只夸原帖一个真实细节，别空捧" },
  { id: "add", label: "补充信息", desc: "补一条原帖没写清的信息、做法或反例，短而具体" },
  { id: "dissent", label: "温和异议", desc: "软一点不同意：给一句自己的判断，不抬杠不阴阳" },
  { id: "joke", label: "轻玩笑", desc: "顺着语气开个小玩笑或接梗，别硬抖机灵，别冒犯" },
  { id: "answer", label: "答问判断", desc: "若原帖在提问就直接给能用的答案；否则给一句明确判断。不要反问对方" },
];

function pickMultiAngleModes() {
  return MULTI_ANGLE_MODES.slice();
}

const POST_TYPE_LABEL = {
  question: "提问帖",
  announcement: "发布/公告帖",
  joke: "段子帖",
  story: "个人经历帖",
  opinion: "观点帖",
};

const POST_TYPE_HINT = {
  question: "原帖在提问：至少一条要给出能直接用的答案或做法，别绕。",
  announcement: "原帖是发布/公告：别复读官方话术，补一个用户视角的判断或提醒。",
  joke: "原帖在玩梗：可以接梗，但别解释笑话。",
  story: "原帖是个人经历：先共情，再补一句自己的类似经历。",
  opinion: "原帖是观点：可以认同也可以反驳，但别和稀泥。",
};

const MODE_POOL = {
  question: ["exp", "add", "terse", "hook", "praise", "ask"],
  announcement: ["add", "praise", "terse", "joke", "ask"],
  joke: ["joke", "terse", "hook"],
  story: ["hook", "exp", "praise", "ask", "add"],
  opinion: ["dissent", "add", "exp", "hook", "praise", "ask", "terse", "joke"],
};

function detectPostType(text) {
  const t = String(text || "").trim();
  if (!t) return "opinion";
  if (/[?？]\s*$/.test(t) || /(请问|求推荐|怎么|如何|为什么|有没有|哪个|谁能|求教|大佬|recommend|how do|why does|anyone)/i.test(t)) {
    return "question";
  }
  if (/(发布|上线|推出|更新|内测|公测|开售|预售|价格|免费|订阅|优惠|领取|announce|launch|release|update|pricing)/i.test(t)) {
    return "announcement";
  }
  if (/(哈哈|笑死|离谱|绷不住|乐了|梗|笑不活|lol|lmao)/i.test(t)) {
    return "joke";
  }
  if (/(我|昨天|今天|刚|去年|当年|之前).{0,30}(试了|做了|遇到|发现|踩坑|经历|用完)/.test(t)) {
    return "story";
  }
  return "opinion";
}

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function pickModes(postType) {
  const pool = (MODE_POOL[postType] || MODE_POOL.opinion).slice();
  const picked = [];

  if (postType === "question") {
    const answers = ["exp", "add", "terse"];
    const answerId = answers[Math.floor(Math.random() * answers.length)];
    picked.push(answerId);
    const at = pool.indexOf(answerId);
    if (at >= 0) pool.splice(at, 1);
  }

  shuffle(pool);
  for (const id of pool) {
    if (picked.length >= 3) break;
    if (!picked.includes(id)) picked.push(id);
  }

  return picked.map((id) => REPLY_MODES.find((m) => m.id === id)).filter(Boolean);
}

function normalizeForSim(text) {
  return String(text || "")
    .replace(/[\s，。！？、；：""''（）【】…—·,.!?;:'"()\[\]]/g, "")
    .toLowerCase();
}

function bigrams(text) {
  const set = new Set();
  for (let i = 0; i < text.length - 1; i++) set.add(text.slice(i, i + 2));
  return set;
}

function textSimilarity(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  const union = A.size + B.size - inter;
  return union ? inter / union : 0;
}

function draftsTooSimilar(list) {
  if (list.length < 2) return false;
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = normalizeForSim(list[i]);
      const b = normalizeForSim(list[j]);
      if (textSimilarity(a, b) > 0.45) return true;
      if (a.length >= 4 && b.length >= 4 && a.slice(0, 4) === b.slice(0, 4)) return true;
    }
  }
  return false;
}

/** 快速模式才用：只有极像才触发二次重写。 */
function draftsTooSimilarSevere(list) {
  if (list.length < 2) return false;
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = normalizeForSim(list[i]);
      const b = normalizeForSim(list[j]);
      if (textSimilarity(a, b) > 0.65) return true;
      if (a.length >= 6 && b.length >= 6 && a.slice(0, 6) === b.slice(0, 6)) return true;
    }
  }
  return false;
}

function looksTemplate(text) {
  return /^(确实|挺有道理|说得对|说得很好|太对了|深有同感|完全同意|说得在理)/.test(
    String(text || "").trim()
  ) || /(首先|其次|总之|综上所述|值得注意的是|作为\s*AI|希望.{0,6}帮助)/i.test(text);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GENERATE_REPLIES") {
    generateReplies(message.payload)
      .then((result) => sendResponse(result))
      .catch((err) =>
        sendResponse({
          ok: false,
          error: err?.message || String(err),
          errorCode: "unknown",
          retryable: true,
        })
      );
    return true; // async
  }
  if (message?.type === "LIST_MODELS") {
    listModels(message.payload)
      .then((result) => sendResponse(result))
      .catch((err) =>
        sendResponse({ ok: false, error: err?.message || String(err), retryable: true })
      );
    return true;
  }
  if (message?.type === "GET_SETTINGS") {
    getSettings()
      .then((settings) => sendResponse({ ok: true, settings }))
      .catch((err) =>
        sendResponse({ ok: false, error: err?.message || String(err) })
      );
    return true;
  }
  if (message?.type === "GET_PERSONA_STATE") {
    getPersonaState()
      .then((state) => sendResponse({ ok: true, ...state }))
      .catch((err) =>
        sendResponse({ ok: false, error: err?.message || String(err) })
      );
    return true;
  }
  if (message?.type === "SET_ACTIVE_PERSONA") {
    setActivePersona(message.payload?.personaId, message.payload?.customText)
      .then((state) => sendResponse({ ok: true, ...state }))
      .catch((err) =>
        sendResponse({ ok: false, error: err?.message || String(err) })
      );
    return true;
  }
  if (message?.type === "OPEN_OPTIONS") {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === "INBOX_UPSERT") {
    upsertInboxItems(message.payload?.items || [])
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
  if (message?.type === "INBOX_LIST") {
    listTodayUnreplied()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
  if (message?.type === "INBOX_DISMISS") {
    dismissInboxItem(message.payload?.id)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
  if (message?.type === "INBOX_MARK_REPLIED") {
    markInboxReplied(message.payload?.id, message.payload?.statusId)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
  if (message?.type === "INBOX_CLEAR_TODAY") {
    clearTodayDismissedOnly()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  if (message?.type === "SAVE_REPLY_FEEDBACK") {
    saveReplyFeedback(message.payload || {})
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
  if (message?.type === "CLEAR_REPLY_FEEDBACK") {
    clearReplyFeedback()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
  if (message?.type === "GET_REPLY_FEEDBACK_META") {
    loadReplyFeedback()
      .then((list) => {
        const ups = list.filter((f) => f.rating === "up").length;
        const downs = list.filter((f) => f.rating === "down").length;
        sendResponse({ ok: true, count: list.length, ups, downs });
      })
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
});

/** Forward chrome.commands to the active X tab's content script. */
chrome.commands.onCommand.addListener(async (command) => {
  try {
    const tabs = await chrome.tabs.query({
      active: true,
      currentWindow: true,
      url: ["https://x.com/*", "https://twitter.com/*"],
    });
    const tab = tabs?.[0];
    if (!tab?.id) return;
    await chrome.tabs.sendMessage(tab.id, { type: "HOTKEY", command });
  } catch {
    // tab may not have content script yet
  }
});


const FEEDBACK_KEY = "replyFeedback";
const FEEDBACK_CAP = 80;
const FEEDBACK_PROMPT_WINDOW = 20;
/** Recent downs used for hard near-dupe filter after parse. */
const FEEDBACK_DOWN_FILTER_WINDOW = 40;

async function loadReplyFeedback() {
  const stored = await chrome.storage.local.get({ [FEEDBACK_KEY]: [] });
  const list = stored[FEEDBACK_KEY];
  return Array.isArray(list) ? list : [];
}

async function saveReplyFeedback(entry) {
  const list = await loadReplyFeedback();
  const item = {
    ts: Date.now(),
    personaId: String(entry?.personaId || "default").slice(0, 40),
    postSnippet: String(entry?.postSnippet || "").slice(0, 200),
    draft: String(entry?.draft || "").slice(0, 500),
    rating: entry?.rating === "down" ? "down" : "up",
    reason: String(entry?.reason || "").slice(0, 200),
  };
  if (entry?.modes != null) {
    item.modes = Array.isArray(entry.modes)
      ? entry.modes.map((m) => String(m).slice(0, 40)).slice(0, 8)
      : String(entry.modes).slice(0, 80);
  }
  list.push(item);
  while (list.length > FEEDBACK_CAP) list.shift();
  await chrome.storage.local.set({ [FEEDBACK_KEY]: list });
  return { count: list.length };
}

async function clearReplyFeedback() {
  await chrome.storage.local.set({ [FEEDBACK_KEY]: [] });
  return { count: 0 };
}

/** Collect downvote reasons that appear ≥ minCount times (exact trim, case-insensitive key). */
function collectCommonDownReasons(downs, minCount = 2) {
  const map = new Map();
  for (const f of downs || []) {
    const r = String(f?.reason || "").trim();
    if (!r) continue;
    const key = r.toLowerCase();
    const prev = map.get(key);
    map.set(key, { count: (prev?.count || 0) + 1, display: r });
  }
  return [...map.values()]
    .filter((x) => x.count >= minCount)
    .sort((a, b) => b.count - a.count)
    .map((x) => x.display);
}

/** Build 「用户偏好」block from recent feedback.
 *  @param {any[]} feedbackList
 *  @param {{ compact?: boolean }} [opts] compact → 2 up / 2 down（快速模式）
 */
function buildPreferenceBlock(feedbackList, opts = {}) {
  const compact = !!opts.compact;
  const recent = (Array.isArray(feedbackList) ? feedbackList : []).slice(-FEEDBACK_PROMPT_WINDOW);
  if (!recent.length) return "";
  const ups = recent.filter((f) => f && f.rating === "up");
  const downs = recent.filter((f) => f && f.rating === "down");
  const take = compact ? 2 : 5;
  const draftCap = compact ? 80 : 120;
  const reasonCap = compact ? 40 : 80;
  const upShow = ups.slice(-take);
  const downShow = downs.slice(-take);
  const commonReasons = collectCommonDownReasons(downs, 2);
  if (!upShow.length && !downShow.length && !commonReasons.length) return "";

  const lines = [
    "【用户偏好】",
    compact
      ? "学「满意」写法；禁止生成与「不行」样例同句式/同开头/同意思的回复；只学语气，勿照抄。"
      : "下面是用户对历史草稿的评价（仅草稿文本与简短理由，无账号隐私）。请模仿「满意」的风格、节奏与具体度。禁止生成与「不行」样例同句式、同开头、同意思的回复。只学写法，不要照抄旧草稿原文，也不要根据旧帖编造事实。",
  ];
  if (commonReasons.length) {
    lines.push("", "【用户踩雷规则】（多次出现的不行理由，请当硬约束）");
    commonReasons.slice(0, compact ? 4 : 8).forEach((r) => {
      lines.push(`- ${String(r).slice(0, reasonCap)}`);
    });
  }
  if (upShow.length) {
    lines.push("", "满意：");
    upShow.forEach((f, i) => {
      const d = String(f.draft || "").slice(0, draftCap);
      const r = f.reason ? `｜${String(f.reason).slice(0, reasonCap)}` : "";
      lines.push(`${i + 1}. ${d}${r}`);
    });
  }
  if (downShow.length) {
    lines.push("", "不行：");
    downShow.forEach((f, i) => {
      const d = String(f.draft || "").slice(0, draftCap);
      const r = f.reason ? `｜${String(f.reason).slice(0, reasonCap)}` : "";
      lines.push(`${i + 1}. ${d}${r}`);
    });
  }
  return lines.join("\n");
}

/** Recent downvoted drafts for hard filter (newest last, take last N). */
function recentDownvotedEntries(feedbackList, limit = FEEDBACK_DOWN_FILTER_WINDOW) {
  const downs = (Array.isArray(feedbackList) ? feedbackList : []).filter(
    (f) => f && f.rating === "down" && String(f.draft || "").trim()
  );
  return downs.slice(-Math.max(1, limit || FEEDBACK_DOWN_FILTER_WINDOW));
}

/**
 * Near-dupe vs a downvoted draft (normalized):
 * - equality
 * - shared prefix ≥ 8 chars
 * - inclusion either way when shorter len ≥ 10
 */
function isNearDuplicateOfDownvoted(candidate, downDraft) {
  const a = normalizeForCompare(candidate);
  const b = normalizeForCompare(downDraft);
  if (!a || !b) return false;
  if (a === b) return true;
  let i = 0;
  const lim = Math.min(a.length, b.length);
  while (i < lim && a[i] === b[i]) i++;
  if (i >= 8) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (shorter.length >= 10 && longer.includes(shorter)) return true;
  return false;
}

/**
 * Drop replies that near-dupe any recent downvote.
 * @returns {{ replies: string[], modes: string[], dropped: number }}
 */
function filterDownvotedNearDupes(replies, modeLabels, downEntries) {
  const list = Array.isArray(replies) ? replies : [];
  const modesArr = Array.isArray(modeLabels) ? modeLabels : [];
  const downs = Array.isArray(downEntries) ? downEntries : [];
  if (!downs.length) {
    return { replies: list.slice(), modes: modesArr.slice(0, list.length), dropped: 0 };
  }
  const kept = [];
  const keptModes = [];
  let dropped = 0;
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    const hit = downs.some((d) => isNearDuplicateOfDownvoted(r, d.draft));
    if (hit) {
      dropped++;
      continue;
    }
    kept.push(r);
    if (modesArr[i] != null) keptModes.push(modesArr[i]);
  }
  return { replies: kept, modes: keptModes, dropped };
}

function formatBlockedDownList(downEntries, limit = 8) {
  const list = (Array.isArray(downEntries) ? downEntries : []).slice(-limit);
  return list
    .map((f, i) => {
      const d = String(f.draft || "").slice(0, 100);
      const r = f.reason ? `｜理由：${String(f.reason).slice(0, 60)}` : "";
      return `${i + 1}. ${d}${r}`;
    })
    .join("\n");
}

function needsPersonaMigration(text) {
  const t = String(text || "");
  if (/AI省时间|省时间做法/.test(t)) return true;
  return /严禁疑问句/.test(t) && /友善吹捧/.test(t) && /温和反驳/.test(t);
}

async function getSettings() {
  const settings = await chrome.storage.sync.get({
    apiKey: "",
    endpoint: DEFAULT_ENDPOINT,
    model: DEFAULT_MODEL,
    autoGenerate: false,
    cacheEnabled: true,
    autoFillFirst: false,
    likeAfterReply: false,
    fastMode: true,
    qualityFirst: false,
    memorySaver: true,
    personaId: "default",
    personaText: DEFAULT_PERSONA,
    customPersonaText: "",
  });
  if (needsPersonaMigration(settings.personaText)) {
    settings.personaText = DEFAULT_PERSONA;
    const patch = { personaText: DEFAULT_PERSONA };
    if (!PERSONA_PRESETS[settings.personaId] || settings.personaId === "default") {
      settings.personaId = "default";
      patch.personaId = "default";
    }
    chrome.storage.sync.set(patch).catch(() => {});
  }
  if (needsPersonaMigration(settings.customPersonaText)) {
    settings.customPersonaText = DEFAULT_PERSONA;
    chrome.storage.sync.set({ customPersonaText: DEFAULT_PERSONA }).catch(() => {});
  }
  if (!PERSONA_PRESETS[settings.personaId]) settings.personaId = "default";
  // Keep personaText aligned with active preset (custom uses customPersonaText).
  settings.personaText = resolvePersonaText(
    settings.personaId,
    settings.customPersonaText,
    settings.personaText
  );
  return settings;
}

async function getPersonaState() {
  const settings = await getSettings();
  const stored = await chrome.storage.sync.get({ customPersonaText: "" });
  return {
    personaId: settings.personaId || "default",
    personaText: settings.personaText,
    customPersonaText: stored.customPersonaText || "",
    presets: listPersonaPresets(),
  };
}

async function setActivePersona(personaId, customText) {
  let id = String(personaId || "default");
  if (!PERSONA_PRESETS[id]) id = "default";
  const stored = await chrome.storage.sync.get({
    customPersonaText: "",
    personaText: DEFAULT_PERSONA,
  });
  let customPersonaText = stored.customPersonaText || "";
  if (id === "custom" && typeof customText === "string") {
    customPersonaText = customText.trim() || customPersonaText || DEFAULT_PERSONA;
  }
  const personaText = resolvePersonaText(id, customPersonaText, stored.personaText);
  await chrome.storage.sync.set({
    personaId: id,
    personaText,
    customPersonaText,
  });
  return {
    personaId: id,
    personaText,
    customPersonaText,
    presets: listPersonaPresets(),
  };
}

function classifyHttpError(status, msg, rawText) {
  const blob = `${msg || ""} ${rawText || ""}`.toLowerCase();
  if (status === 429 || /rate.?limit|too many requests|quota|限流|频率/.test(blob)) {
    return {
      errorCode: "rate_limit",
      retryable: true,
      error:
        "触发限流（HTTP 429）。请稍等几十秒再点「重试」，或关掉自动生成 / 换更便宜的模型。",
    };
  }
  if (status === 401 || status === 403 || /invalid api key|unauthorized|authentication|forbidden/.test(blob)) {
    return {
      errorCode: "auth",
      retryable: false,
      error: "鉴权失败：请检查 API Key 是否有效、Endpoint 是否匹配该 Key。",
    };
  }
  if (status === 402 || /payment|insufficient|余额|欠费/.test(blob)) {
    return {
      errorCode: "billing",
      retryable: false,
      error: "额度或账单不足：请到服务商控制台确认余额 / 套餐。",
    };
  }
  if (status >= 500) {
    return {
      errorCode: "server",
      retryable: true,
      error: `服务端暂时不可用（HTTP ${status}）。可稍后点「重试」。`,
    };
  }
  const short = (msg || rawText || `HTTP ${status}`).toString().slice(0, 280);
  return {
    errorCode: "api",
    retryable: status === 0 || status >= 408,
    error: `API 错误：${short}`,
  };
}

function endpointHostHint(endpoint) {
  try {
    const u = new URL((endpoint || "").trim());
    return u.host ? `主机 ${u.host}` : "";
  } catch {
    return "";
  }
}

function classifyFetchError(err, endpoint) {
  const name = err?.name || "";
  const msg = String(err?.message || err || "");
  const host = endpointHostHint(endpoint);
  const hostBit = host ? `（${host}）` : "";
  const ep = (endpoint || "").trim();
  const pathHint =
    ep && !/\/chat\/completions\/?$/i.test(ep)
      ? " Endpoint 一般需以 /v1/chat/completions（或服务商等价路径）结尾；"
      : "";
  const openCodeHint =
    " OpenCode 请用 https://opencode.ai/inference/.../chat/completions；";
  const reloadHint =
    "扩展已有 https://*/* 主机权限；请重载扩展后关掉并重新打开 x.com 标签再试。";
  if (name === "AbortError" || /aborted|timeout|timed out|超时/i.test(msg)) {
    return {
      errorCode: "timeout",
      retryable: true,
      error:
        `请求超时${hostBit}。网络或模型响应过慢，请点「重试」。` +
        pathHint +
        openCodeHint,
    };
  }
  if (/failed to fetch|networkerror|load failed|网络/i.test(msg)) {
    return {
      errorCode: "network",
      retryable: true,
      error:
        `网络请求失败：${msg}${hostBit}。请检查 Endpoint URL 与网络。` +
        pathHint +
        openCodeHint +
        reloadHint,
    };
  }
  return {
    errorCode: "network",
    retryable: true,
    error: `请求失败：${msg}${hostBit}。请检查 Endpoint 是否可访问。` + pathHint + reloadHint,
  };
}


async function fetchWithTimeout(url, options, timeoutMs = 60000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 同帖缓存约 5 分钟

async function readReplyCache() {
  const stored = await chrome.storage.local.get({ replyCache: {} });
  return stored.replyCache && typeof stored.replyCache === "object" ? stored.replyCache : {};
}

async function writeReplyCache(cache) {
  // prune expired + cap size; truncate reply strings to limit retained heap
  const now = Date.now();
  const next = {};
  const entries = Object.entries(cache || {})
    .filter(([, v]) => v && Array.isArray(v.replies) && now - (v.ts || 0) < CACHE_TTL_MS)
    .sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0))
    .slice(0, 24);
  for (const [k, v] of entries) {
    next[k] = {
      replies: (v.replies || []).slice(0, 5).map((r) => String(r).slice(0, 400)),
      modes: Array.isArray(v.modes) ? v.modes.slice(0, 5).map((m) => String(m).slice(0, 40)) : [],
      ts: v.ts || now,
      sig: String(v.sig || "").slice(0, 120),
      multiAngle: !!v.multiAngle,
    };
  }
  await chrome.storage.local.set({ replyCache: next });
}

function startOfTodayMs() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

async function readInboxStore() {
  const stored = await chrome.storage.local.get({
    unrepliedInbox: { items: [], dismissed: {}, replied: {} },
  });
  const box = stored.unrepliedInbox && typeof stored.unrepliedInbox === "object"
    ? stored.unrepliedInbox
    : { items: [], dismissed: {}, replied: {} };
  if (!Array.isArray(box.items)) box.items = [];
  if (!box.dismissed || typeof box.dismissed !== "object") box.dismissed = {};
  if (!box.replied || typeof box.replied !== "object") box.replied = {};
  return box;
}

async function writeInboxStore(box) {
  const start = startOfTodayMs();
  // prune items older than 3 days; keep dismissed/replied maps lean
  const items = (box.items || [])
    .filter((it) => it && it.id && (it.ts || 0) >= start - 3 * 24 * 60 * 60 * 1000)
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .slice(0, 80);
  const keepIds = new Set(items.map((i) => i.id));
  const dismissed = {};
  const replied = {};
  for (const [k, v] of Object.entries(box.dismissed || {})) {
    if (keepIds.has(k) || (typeof v === "number" && v >= start - 7 * 24 * 60 * 60 * 1000)) dismissed[k] = v;
  }
  for (const [k, v] of Object.entries(box.replied || {})) {
    if (keepIds.has(k) || (typeof v === "number" && v >= start - 7 * 24 * 60 * 60 * 1000)) replied[k] = v;
  }
  const next = { items, dismissed, replied };
  await chrome.storage.local.set({ unrepliedInbox: next });
  return next;
}

async function upsertInboxItems(rawItems) {
  const box = await readInboxStore();
  const byId = new Map(box.items.map((it) => [it.id, it]));
  let added = 0;
  for (const raw of rawItems || []) {
    if (!raw || !raw.id) continue;
    const id = String(raw.id);
    const prev = byId.get(id);
    const item = {
      id,
      statusId: String(raw.statusId || prev?.statusId || "").trim(),
      url: String(raw.url || prev?.url || "").trim(),
      from: String(raw.from || prev?.from || "").trim(),
      preview: String(raw.preview || prev?.preview || "").trim().slice(0, 180),
      kind: String(raw.kind || prev?.kind || "mention").trim(),
      ts: Number(raw.ts || prev?.ts || Date.now()),
      source: String(raw.source || prev?.source || "notifications"),
    };
    if (!prev) added += 1;
    byId.set(id, item);
  }
  box.items = [...byId.values()];
  const saved = await writeInboxStore(box);
  const listed = await listTodayUnrepliedFrom(saved);
  return { added, count: listed.items.length, items: listed.items };
}

function listTodayUnrepliedFrom(box) {
  const start = startOfTodayMs();
  const items = (box.items || [])
    .filter((it) => (it.ts || 0) >= start)
    .filter((it) => !box.dismissed?.[it.id] && !box.replied?.[it.id])
    .sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return {
    items,
    count: items.length,
    bestEffort: true,
    note: "今日待回依赖通知/提及页可见卡片抓取，可能漏检或误判；已回复需你点「已回」或填入草稿后自动标记。",
  };
}

async function listTodayUnreplied() {
  const box = await readInboxStore();
  return listTodayUnrepliedFrom(box);
}

async function dismissInboxItem(id) {
  const key = String(id || "").trim();
  if (!key) return listTodayUnreplied();
  const box = await readInboxStore();
  box.dismissed[key] = Date.now();
  const saved = await writeInboxStore(box);
  return listTodayUnrepliedFrom(saved);
}

async function markInboxReplied(id, statusId) {
  const box = await readInboxStore();
  const now = Date.now();
  const key = String(id || "").trim();
  const sid = String(statusId || "").trim();
  if (key) box.replied[key] = now;
  if (sid) {
    for (const it of box.items || []) {
      if (it.statusId === sid || it.id === sid || (it.url && it.url.includes(`/status/${sid}`))) {
        box.replied[it.id] = now;
      }
    }
    box.replied[sid] = now;
  }
  const saved = await writeInboxStore(box);
  return listTodayUnrepliedFrom(saved);
}

async function clearTodayDismissedOnly() {
  // no-op helper kept for popup; just return current list
  return listTodayUnreplied();
}

function isOpenCodeEndpoint(endpoint) {
  return /opencode\.ai/i.test(endpoint || "");
}

/** OpenCode known models URLs (chat path ≠ models path). */
function openCodeModelsCandidates(endpoint) {
  const out = [];
  const push = (u) => {
    if (u && !out.includes(u)) out.push(u);
  };
  push(deriveModelsUrl(endpoint));
  push("https://opencode.ai/inference/go/v1/models");
  push("https://opencode.ai/zen/go/v1/models");
  // common wrong derivation: keep openai segment → 404; also try stripping /openai
  try {
    const ep = (endpoint || "").trim().replace(/\/+$/, "");
    if (/\/openai\/v1\/chat\/completions$/i.test(ep)) {
      push(ep.replace(/\/openai\/v1\/chat\/completions$/i, "/openai/v1/models"));
      push(ep.replace(/\/openai\/v1\/chat\/completions$/i, "/v1/models"));
    }
  } catch (_) {}
  return out.filter(Boolean);
}

const OPENCODE_FALLBACK_MODELS = [
  "deepseek-v4.1-flash",
  "deepseek-v4-pro",
  "glm-5.2",
  "glm-5.3",
  "grok-4.7",
  "kimi-k3",
  "minimax-m2.5",
];

/** Persist a stable UUID for OpenCode Go routing. */
async function getOpenCodeSession() {
  const stored = await chrome.storage.local.get({ opencodeSession: "" });
  let sessionId = stored.opencodeSession;
  if (!sessionId) {
    sessionId = crypto.randomUUID();
    await chrome.storage.local.set({ opencodeSession: sessionId });
  }
  return sessionId;
}

async function buildAuthHeaders(endpoint, apiKey) {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
  if (isOpenCodeEndpoint(endpoint)) {
    headers["User-Agent"] = EXT_UA;
    headers["x-opencode-session"] = await getOpenCodeSession();
  }
  return headers;
}

/**
 * Derive OpenAI-compatible models URL from a chat completions endpoint.
 * .../openai/v1/chat/completions → .../v1/models
 * else strip trailing path segment(s) and append /v1/models
 */
function deriveModelsUrl(endpoint) {
  const ep = (endpoint || "").trim().replace(/\/+$/, "");
  if (!ep) return "";
  if (/\/openai\/v1\/chat\/completions$/i.test(ep)) {
    return ep.replace(/\/openai\/v1\/chat\/completions$/i, "/v1/models");
  }
  if (/\/v1\/chat\/completions$/i.test(ep)) {
    return ep.replace(/\/v1\/chat\/completions$/i, "/v1/models");
  }
  // Fallback: base origin + path up to last useful segment + /v1/models
  try {
    const u = new URL(ep);
    // if path already ends with /v1/models, keep it
    if (/\/v1\/models$/i.test(u.pathname)) return ep;
    // strip last path segment if it looks like a method name
    const parts = u.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
    // rebuild: keep everything before chat/completions style, else origin + /v1/models
    const idx = parts.findIndex((p) => p.toLowerCase() === "v1");
    if (idx >= 0) {
      u.pathname = "/" + parts.slice(0, idx + 1).join("/") + "/models";
      return u.toString().replace(/\/$/, "");
    }
    u.pathname = "/v1/models";
    return u.toString().replace(/\/$/, "");
  } catch {
    return ep.replace(/\/[^/]*$/, "") + "/v1/models";
  }
}

async function listModels(payload) {
  const settings = await getSettings();
  const apiKey = (payload?.apiKey || settings.apiKey || "").trim();
  const endpoint = (payload?.endpoint || settings.endpoint || DEFAULT_ENDPOINT).trim();

  if (!apiKey) {
    return { ok: false, error: "请先填写 API Key。" };
  }
  if (!/^https?:\/\//i.test(endpoint)) {
    return { ok: false, error: "Endpoint 需要以 http:// 或 https:// 开头。" };
  }

  const candidates = isOpenCodeEndpoint(endpoint)
    ? openCodeModelsCandidates(endpoint)
    : [deriveModelsUrl(endpoint)].filter(Boolean);

  const headers = await buildAuthHeaders(endpoint, apiKey);
  delete headers["Content-Type"];

  let lastError = "";
  let modelsUrl = candidates[0] || "";
  let rawText = "";
  let data = null;

  for (const url of candidates) {
    modelsUrl = url;
    let response;
    try {
      response = await fetchWithTimeout(url, { method: "GET", headers }, 30000);
    } catch (err) {
      const c = classifyFetchError(err, endpoint);
      lastError = `读取模型失败：${c.error}（请求 ${url}）`;
      continue;
    }
    rawText = await response.text();
    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch {
      lastError = `模型列表非 JSON（HTTP ${response.status}）：${rawText.slice(0, 200)}`;
      data = null;
      continue;
    }
    if (!response.ok) {
      const msg =
        data?.error?.message ||
        data?.message ||
        rawText.slice(0, 300) ||
        `HTTP ${response.status}`;
      const c = classifyHttpError(response.status, msg, rawText);
      lastError = `读取模型：${c.error}（请求 ${url}）`;
      data = null;
      continue;
    }
    break;
  }

  if (!data) {
    if (isOpenCodeEndpoint(endpoint)) {
      return {
        ok: true,
        models: OPENCODE_FALLBACK_MODELS.slice(),
        modelsUrl: "(OpenCode 列表接口失败，已用内置常用模型；也可手动填 id)",
        fallback: true,
        errorHint: lastError || undefined,
      };
    }
    return { ok: false, error: lastError || "读取模型失败" };
  }

  const models = [];
  const list = Array.isArray(data?.data)
    ? data.data
    : Array.isArray(data?.models)
      ? data.models
      : Array.isArray(data)
        ? data
        : [];

  for (const m of list) {
    const id = typeof m === "string" ? m : m?.id || m?.name || m?.model;
    if (id) models.push(String(id));
  }

  const uniq = [...new Set(models)].sort((a, b) => a.localeCompare(b));
  if (!uniq.length) {
    if (isOpenCodeEndpoint(endpoint)) {
      return {
        ok: true,
        models: OPENCODE_FALLBACK_MODELS.slice(),
        modelsUrl,
        fallback: true,
        errorHint: `未解析到模型 ID。原始片段：${rawText.slice(0, 200)}`,
      };
    }
    return {
      ok: false,
      error: `未解析到模型 ID。原始片段：${rawText.slice(0, 300)}`,
    };
  }

  return { ok: true, models: uniq, modelsUrl };
}

async function generateReplies(payload) {
  const t0 = Date.now();
  const settings = await getSettings();
  const apiKey = (settings.apiKey || "").trim();
  if (!apiKey) {
    return {
      ok: false,
      needSetup: true,
      error:
        "尚未配置 API Key。请点击扩展图标 →「打开设置」，填写 OpenAI 兼容接口的 Key、Endpoint 和模型。",
    };
  }

  const endpoint = (settings.endpoint || DEFAULT_ENDPOINT).trim();
  const model = (settings.model || DEFAULT_MODEL).trim();
  const postText = String(payload?.postText || "").trim().slice(0, 2500);
  const quotedText = (payload?.quotedText || "").trim();
  const comments = Array.isArray(payload?.comments) ? payload.comments : [];
  const commentSig = commentSignature(comments);
  const threadTexts = Array.isArray(payload?.threadTexts) ? payload.threadTexts : [];
  const authorRecent = Array.isArray(payload?.authorRecent) ? payload.authorRecent : [];
  const authorHandle = String(payload?.authorHandle || "").trim();
  const author = String(payload?.author || "").trim();
  const postId = String(payload?.postId || "").trim();
  const forceRefresh = !!payload?.forceRefresh;
  const multiAngle = !!payload?.multiAngle;
  const replyToComment = payload?.replyToComment && typeof payload.replyToComment === "object"
    ? {
        text: String(payload.replyToComment.text || "").trim(),
        author: String(payload.replyToComment.author || "").trim(),
        handle: String(payload.replyToComment.handle || "").replace(/^@/, "").trim(),
        statusId: String(payload.replyToComment.statusId || "").trim(),
      }
    : null;
  const hasReplyToComment = !!(replyToComment && replyToComment.text);
  const siblingReplies = Array.isArray(payload?.siblingReplies) ? payload.siblingReplies : [];
  const replyCount = multiAngle ? 5 : 3;
  const cacheEnabled = settings.cacheEnabled !== false;
  const cacheKey = postId
    ? (multiAngle ? `${postId}:multi` : postId) + (hasReplyToComment ? ":rtc" : "")
    : "";

  // 质量优先关掉快速捷径；否则默认走快速模式（fastMode 默认 true）
  const qualityFirst = !!settings.qualityFirst;
  const fastMode = !qualityFirst && settings.fastMode !== false;

  if (!postText) {
    return { ok: false, error: "没读到帖子正文，请确认已打开单条帖子页并稍等页面加载完。" };
  }

  // Same-post cache (~5 min); multi-angle 与默认分 key
  if (cacheEnabled && cacheKey && !forceRefresh) {
    const cache = await readReplyCache();
    const hit = cache[cacheKey];
    const hitOk =
      hit &&
      Array.isArray(hit.replies) &&
      hit.replies.length &&
      hit.sig === commentSig &&
      Date.now() - (hit.ts || 0) < CACHE_TTL_MS &&
      !(multiAngle && hit.replies.length < 5);
    if (hitOk) {
      const ageSec = Math.max(1, Math.round((Date.now() - hit.ts) / 1000));
      return {
        ok: true,
        replies: hit.replies.slice(0, replyCount),
        modes: Array.isArray(hit.modes) ? hit.modes.slice(0, replyCount) : [],
        cached: true,
        cacheAgeSec: ageSec,
        multiAngle,
        fastMode,
        elapsedMs: Date.now() - t0,
        filteredDropped: 0,
        autoFillFirst: multiAngle ? false : !!settings.autoFillFirst,
      };
    }
  }

  const memorySaver = settings.memorySaver !== false;
  const commentCap = fastMode ? (memorySaver ? 4 : 6) : (memorySaver ? 10 : 15);
  const threadCap = fastMode ? (memorySaver ? 2 : 3) : (memorySaver ? 5 : 8);
  const authorCap = fastMode ? 0 : (memorySaver ? 3 : 5);

  const commentsBlock =
    comments.length > 0
      ? comments
          .slice(0, commentCap)
          .map((c, i) => `${i + 1}. ${String(c).slice(0, fastMode ? (memorySaver ? 120 : 160) : (memorySaver ? 200 : 280))}`)
          .join("\n")
      : "（暂无可见评论）";

  const threadBlock =
    threadTexts.length > 0 && threadCap > 0
      ? threadTexts
          .slice(0, threadCap)
          .map((t, i) => `${i + 1}. ${String(t).slice(0, fastMode ? (memorySaver ? 160 : 220) : (memorySaver ? 280 : 400))}`)
          .join("\n")
      : "（无可见线程上文）";

  const authorBlock =
    authorCap > 0 && authorRecent.length > 0
      ? authorRecent
          .slice(0, authorCap)
          .map((t, i) => `${i + 1}. ${String(t).slice(0, 320)}`)
          .join("\n")
      : "（跳过作者近帖）";

  const persona = (settings.personaText || DEFAULT_PERSONA).trim() || DEFAULT_PERSONA;
  const postType = detectPostType(postText);
  const modes = multiAngle ? pickMultiAngleModes() : pickModes(postType);
  let preferenceBlock = "";
  let feedbackList = [];
  try {
    feedbackList = await loadReplyFeedback();
    preferenceBlock = buildPreferenceBlock(feedbackList, { compact: fastMode });
  } catch {
    preferenceBlock = "";
    feedbackList = [];
  }
  const downEntries = recentDownvotedEntries(feedbackList, FEEDBACK_DOWN_FILTER_WINDOW);

  const quotedBlock = quotedText
    ? ["【引用帖】", quotedText.slice(0, fastMode ? 320 : 600), ""]
    : [];

  const countLabel = multiAngle ? "五条" : "三条";
  const jsonExample = multiAngle
    ? '{"replies":["回复1","回复2","回复3","回复4","回复5"]}'
    : '{"replies":["回复1","回复2","回复3"]}';

  const styleFast = STYLE_EXAMPLES.split("\n").slice(0, 3).join("\n");

  const rtcSystemFast = hasReplyToComment
    ? [
        "这次是楼中楼回复：必须针对【目标评论】回应其观点或问题，可参考原帖作语境。",
        "不要无视目标评论、只对原帖发表情。",
        "提到对方时可用 @" + (replyToComment.handle || "") + "，但不要生硬堆砌；不自然就别带 @。",
      ].join("\n")
    : "对着原帖写；评论区只防复读，勿总结/照抄评论。";

  const rtcSystemFull = hasReplyToComment
    ? [
        "这次用户要回复的是某条【评论】（楼中楼），不是只回原帖。",
        "草稿必须直接回应该评论的内容/观点/问题；原帖和线程只作背景。",
        "可以自然带 @" + (replyToComment.handle || "对方") + "，不自然就不要硬加。",
        "禁止假装没看见评论、只聊原帖；禁止复读该评论原句。",
      ].join("\n")
    : [
        "可参考线程、引用帖和作者近期帖理解语境，但回复必须对着原帖写，别跑题。",
        "评论区只用来判断话题走向和避免重复：不要总结评论区，不要照抄评论，不要回复评论者。",
      ].join("\n");

  const systemPrompt = fastMode
    ? [
        "写 X 中文评论草稿，只输出 JSON，不代发。说人话、短、具体；去 AI 味。",
        rtcSystemFast,
        "",
        "【人设】",
        persona.length > 700 ? persona.slice(0, 700) + "…" : persona,
        "",
        "【语气】",
        styleFast,
        "",
        ...(preferenceBlock ? [preferenceBlock, ""] : []),
        multiAngle ? "【五条多角度】" : "【三条】",
        `帖型：${POST_TYPE_LABEL[postType] || "观点帖"}。${POST_TYPE_HINT[postType] || ""}`,
        ...modes.map((m, i) => `${i + 1}. ${m.label}：${m.desc}`),
        multiAngle
          ? "长短错落；最多一条问句；答问给答案勿反问。"
          : "一条短、一条中、一条稍长；最多一条问句。",
        "",
        `硬性：JSON ${jsonExample}；正好 ${replyCount} 条中文；不编造事实；不求赞求关。`,
      ].join("\n")
    : [
        "你在帮用户写 X（Twitter）中文评论草稿，只输出草稿，不会代发。",
        "严格按「人设」和「语气样例」说话。样例只学语气，不抄内容，也别把样例里的事当成原帖事实。",
        rtcSystemFull,
        hasReplyToComment
          ? "同层其它回复只用来避免复读，不要总结它们。"
          : "如果评论区已经有人说过某个观点，换一个没人说的角度；复读高赞评论会像机器人。",
        "默认友善、说人话、去 AI 味；不要反问对方（答问角度除外，且答问也不要用反问糊弄）。",
        "",
        "【人设】",
        persona,
        "",
        "【语气样例（只学说话方式）】",
        STYLE_EXAMPLES,
        "",
        ...(preferenceBlock ? [preferenceBlock, ""] : []),
        multiAngle ? "【这次的五条多角度】" : "【这次的三条】",
        `帖型判断：${POST_TYPE_LABEL[postType] || "观点帖"}。${POST_TYPE_HINT[postType] || ""}`,
        `${countLabel}分别用这几种写法，顺序按下面来：`,
        ...modes.map((m, i) => `${i + 1}. ${m.label}：${m.desc}`),
        multiAngle
          ? "长度拉开：至少一条很短（5~15 字），其余在 15~55 字之间错落，别五条一个节奏。"
          : "长度拉开：一条 5~15 字，一条 15~35 字，一条 35~60 字，别三条一个长度。",
        multiAngle
          ? "五条里最多一条可以用问句；「答问判断」优先给答案或判断，不要反问用户。"
          : "最多一条可以用问句，问就问你真好奇的具体问题；其余用陈述句。",
        "每条最多一个具体钩子（数字、工具名、场景、原话），别每条都硬塞。",
        "",
        "【硬性】",
        `输出严格 JSON ${jsonExample}，不要 markdown，不要解释。`,
        `正好 ${replyCount} 条中文，和上面写法一一对应。`,
        "不编造原帖/线程没有的事实；不人身攻击、不阴阳、不求赞求关、不推销。",
        "不总结升华；不用「首先/其次/总之/值得注意/作为AI/希望对你有帮助」。",
        `别把${countLabel}写成同一个句式，别都用「先说一个细节，再下判断」。`,
      ].join("\n");

  const userPromptParts = [
    authorHandle || author ? `【原帖作者】${authorHandle ? "@" + authorHandle : ""} ${author}`.trim() : "【原帖作者】（未知）",
    "",
    "【原帖】",
    postText.slice(0, fastMode ? 1200 : 2000),
    "",
    ...quotedBlock,
  ];
  if (hasReplyToComment) {
    userPromptParts.push(
      "【目标评论（请回复这一条）】",
      (replyToComment.handle ? "@" + replyToComment.handle + ": " : "") + replyToComment.text.slice(0, fastMode ? 600 : 1200),
      "",
    );
    if (siblingReplies.length) {
      userPromptParts.push(
        "【同层可见其它回复（防复读）】",
        siblingReplies.slice(0, fastMode ? 3 : 4).map((t, i) => `${i + 1}. ${String(t).slice(0, fastMode ? 160 : 280)}`).join("\n"),
        "",
      );
    }
  }
  if (threadCap > 0) {
    userPromptParts.push("【线程上文】", threadBlock, "");
  }
  if (authorCap > 0) {
    userPromptParts.push("【作者近期帖】", authorBlock, "");
  }
  userPromptParts.push(
    "【可见评论（防复读）】",
    commentsBlock,
    "",
    hasReplyToComment
      ? (multiAngle
          ? "按人设写 5 条多角度中文回复，全部针对【目标评论】：说人话，长短拉开。"
          : "按人设写 3 条中文回复，全部针对【目标评论】：说人话，长短拉开，最多一条问句。")
      : (multiAngle
          ? "按人设写 5 条多角度中文回复：说人话，长短拉开。"
          : "按人设写 3 条中文回复：说人话，长短拉开，最多一条问句。")
  );
  const userPrompt = userPromptParts.join("\n");

  const headers = await buildAuthHeaders(endpoint, apiKey);
  const maxTokens = multiAngle ? (fastMode ? 600 : 900) : fastMode ? 400 : 700;
  const baseBody = {
    model,
    temperature: fastMode ? 0.7 : 0.85,
    top_p: fastMode ? 0.9 : 0.9,
    presence_penalty: fastMode ? 0.15 : 0.2,
    max_tokens: maxTokens,
  };
  const useJsonObject = !isOpenCodeEndpoint(endpoint);

  async function postChat(messages) {
    const body = { ...baseBody, messages };
    if (useJsonObject) body.response_format = { type: "json_object" };
    let response;
    try {
      response = await fetchWithTimeout(
        endpoint,
        { method: "POST", headers, body: JSON.stringify(body) },
        fastMode ? 45000 : 60000
      );
    } catch (err) {
      const c = classifyFetchError(err, endpoint);
      return { ok: false, error: c.error, errorCode: c.errorCode, retryable: c.retryable };
    }
    const rawText = await response.text();
    let data;
    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch {
      return {
        ok: false,
        error: `接口返回非 JSON（HTTP ${response.status}）：${rawText.slice(0, 200)}`,
        errorCode: "parse",
        retryable: true,
      };
    }
    if (!response.ok) {
      const msg =
        data?.error?.message ||
        data?.message ||
        rawText.slice(0, 300) ||
        `HTTP ${response.status}`;
      const c = classifyHttpError(response.status, msg, rawText);
      return { ok: false, error: c.error, errorCode: c.errorCode, retryable: c.retryable };
    }
    const content =
      data?.choices?.[0]?.message?.content ||
      data?.choices?.[0]?.text ||
      data?.output_text ||
      "";
    return { ok: true, content };
  }

  let content = "";
  let replies = [];
  const maxAttempts = fastMode ? 2 : 2;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const retryNote =
      attempt === 0
        ? ""
        : (multiAngle
            ? "\n\n【重写要求】上一版五条太像、太套路，或复读了评论区。换开头、换句式，长短拉开；五种角度要能分清；不要重复评论区已有的说法。"
            : "\n\n【重写要求】上一版三条太像、太套路，或复读了评论区。换开头、换句式，长短拉开；不要重复评论区已有的说法。");

    const res = await postChat([
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt + retryNote },
    ]);
    if (!res.ok) return { ...res, elapsedMs: Date.now() - t0, fastMode };
    content = res.content;
    replies = parseReplies(content);
    if (!replies.length) continue;

    const templateHit = replies.some(looksTemplate);
    const commentHit = repeatsComments(replies, comments);
    // 快速模式：仅严重相似 / 套路 / 复读评论才二次重写；质量优先保持原阈值
    const similarHit = fastMode
      ? draftsTooSimilarSevere(replies)
      : draftsTooSimilar(replies);
    if (!similarHit && !templateHit && !commentHit) break;
    // 快速模式：若只是轻度相似且不套路，直接收（attempt0 时 similarHit 已是 severe）
    if (fastMode && attempt === 0 && !similarHit && !templateHit && !commentHit) break;
  }

  // 多角度：不足 5 条时再补一轮（快速/质量都只在 <5 时补）
  if (multiAngle && replies.length && replies.length < 5) {
    const need = 5 - replies.length;
    const missingModes = modes.slice(replies.length);
    const fillSystem = [
      "补写 X 中文评论草稿，只输出 JSON。说人话、短、具体。",
      "",
      "【人设】",
      persona.slice(0, fastMode ? 500 : 2000),
      ...(preferenceBlock ? ["", preferenceBlock] : []),
    ].join("\n");
    const fillSlots = Array.from({ length: need }, () => '"…"').join(",");
    const fillUser = [
      `还差 ${need} 条，分别对应：`,
      ...missingModes.map((m, i) => `${i + 1}. ${m.label}：${m.desc}`),
      "",
      "【原帖】",
      postText.slice(0, fastMode ? 1200 : 2000),
      "",
      "【已有草稿（禁止重复）】",
      ...replies.map((r, i) => `${i + 1}. ${r}`),
      "",
      `输出 JSON {"replies":[${fillSlots}]}，正好 ${need} 条。`,
    ].join("\n");
    const fillRes = await postChat([
      { role: "system", content: fillSystem },
      { role: "user", content: fillUser },
    ]);
    if (fillRes.ok) {
      const extra = parseReplies(fillRes.content);
      const seen = new Set(replies.map((r) => normalizeForCompare(r)));
      for (const r of extra) {
        if (replies.length >= 5) break;
        const n = normalizeForCompare(r);
        if (!n || seen.has(n)) continue;
        seen.add(n);
        replies.push(r);
      }
      if (extra.length) content = String(content) + "\n" + String(fillRes.content);
    }
  }

  // —— 硬过滤：丢掉与近期 👎 近重复的草稿；不足则再要一轮回避重写 ——
  let filteredDropped = 0;
  let modeLabels = modes.map((m) => m.label);
  {
    const filtered = filterDownvotedNearDupes(replies, modeLabels, downEntries);
    filteredDropped += filtered.dropped;
    replies = filtered.replies;
    modeLabels = filtered.modes;
  }

  if (replies.length && replies.length < replyCount && downEntries.length) {
    const need = replyCount - replies.length;
    const blocked = formatBlockedDownList(downEntries, 8);
    const avoidSystem = [
      "重写 X 中文评论草稿，只输出 JSON。说人话、短、具体。",
      "禁止生成与下列「不行」样例同句式、同开头、同意思的回复。",
      "",
      "【人设】",
      persona.slice(0, fastMode ? 500 : 2000),
      ...(preferenceBlock ? ["", preferenceBlock] : []),
    ].join("\n");
    const avoidUser = [
      `还差 ${need} 条（目标共 ${replyCount} 条）。请全部重写一版，避开踩雷列表。`,
      "",
      "【踩雷回避】上一版有草稿与用户点过「不行」的内容太像，已被滤掉。禁止与下列文本同句式/同开头/同意思：",
      blocked || "（无具体样例）",
      "",
      "【原帖】",
      postText.slice(0, fastMode ? 1200 : 2000),
      "",
      "【已保留可用草稿（不要重复）】",
      ...(replies.length ? replies.map((r, i) => `${i + 1}. ${r}`) : ["（无）"]),
      "",
      `输出 JSON ${jsonExample}，正好 ${replyCount} 条中文；前 ${replies.length} 条可保留已有意思但必须换开头句式，或整组全新。优先保证条数够且不踩雷。`,
    ].join("\n");
    const avoidRes = await postChat([
      { role: "system", content: avoidSystem },
      { role: "user", content: avoidUser },
    ]);
    if (avoidRes.ok) {
      const rewritten = parseReplies(avoidRes.content);
      if (rewritten.length) {
        content = String(content) + "\n" + String(avoidRes.content);
        const filtered2 = filterDownvotedNearDupes(rewritten, modes.map((m) => m.label), downEntries);
        filteredDropped += filtered2.dropped;
        // Prefer rewrite set if it yields enough; else merge unique survivors
        if (filtered2.replies.length >= replyCount) {
          replies = filtered2.replies;
          modeLabels = filtered2.modes;
        } else {
          const seen = new Set(replies.map((r) => normalizeForCompare(r)));
          for (let i = 0; i < filtered2.replies.length; i++) {
            const r = filtered2.replies[i];
            const n = normalizeForCompare(r);
            if (!n || seen.has(n)) continue;
            seen.add(n);
            replies.push(r);
            if (filtered2.modes[i] != null) modeLabels.push(filtered2.modes[i]);
            if (replies.length >= replyCount) break;
          }
        }
      }
    }
  }

  if (!replies.length) {
    return {
      ok: false,
      error: `模型返回无法解析成 ${replyCount} 条回复（含踩雷过滤后）。原始内容：${String(content).slice(0, 400)}`,
      elapsedMs: Date.now() - t0,
      fastMode,
      filteredDropped,
    };
  }

  if (multiAngle && replies.length < 5) {
    return {
      ok: false,
      error: `多角度需要 5 条，本次踩雷过滤后剩 ${replies.length} 条。请点「重试」。原始片段：${String(content).slice(0, 300)}`,
      errorCode: "parse",
      retryable: true,
      elapsedMs: Date.now() - t0,
      fastMode,
      filteredDropped,
    };
  }

  const out = replies.slice(0, replyCount);
  modeLabels = modeLabels.slice(0, out.length);
  while (modeLabels.length < out.length) modeLabels.push("");
  const elapsedMs = Date.now() - t0;

  if (cacheEnabled && cacheKey && out.length) {
    try {
      const cache = await readReplyCache();
      cache[cacheKey] = { replies: out, modes: modeLabels, ts: Date.now(), sig: commentSig, multiAngle };
      await writeReplyCache(cache);
    } catch {
      // ignore cache write errors
    }
  }

  return {
    ok: true,
    replies: out,
    modes: modeLabels,
    cached: false,
    multiAngle,
    fastMode,
    elapsedMs,
    filteredDropped,
    autoFillFirst: multiAngle ? false : !!settings.autoFillFirst,
  };
}


function normalizeForCompare(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/@[a-z0-9_]{1,15}/gi, "")
    .replace(/[\s\p{P}\p{S}]/gu, "");
}

function commentSignature(comments) {
  const list = Array.isArray(comments) ? comments : [];
  const s = list.join("\n").slice(0, 6000);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36) + ":" + list.length;
}

/** 回复复读评论区 → 触发重写。 */
function repeatsComments(replies, comments) {
  const cs = (comments || [])
    .map((c) => normalizeForCompare(c))
    .filter((c) => c.length >= 8);
  if (!cs.length) return false;
  return (replies || []).some((r) => {
    const n = normalizeForCompare(r);
    if (n.length < 8) return false;
    return cs.some((c) => c.includes(n) || (n.length >= 20 && n.includes(c)));
  });
}

function parseReplies(content) {
  const text = String(content || "").trim();
  if (!text) return [];

  // Try JSON object / array
  const jsonCandidates = [];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) jsonCandidates.push(fence[1].trim());
  jsonCandidates.push(text);
  const brace = text.match(/\{[\s\S]*\}/);
  if (brace) jsonCandidates.push(brace[0]);
  const arr = text.match(/\[[\s\S]*\]/);
  if (arr) jsonCandidates.push(arr[0]);

  for (const cand of jsonCandidates) {
    try {
      const parsed = JSON.parse(cand);
      if (Array.isArray(parsed)) {
        const list = parsed.map(String).map((s) => s.trim()).filter(Boolean);
        if (list.length) return list;
      }
      if (parsed && Array.isArray(parsed.replies)) {
        const list = parsed.replies.map(String).map((s) => s.trim()).filter(Boolean);
        if (list.length) return list;
      }
    } catch {
      // continue
    }
  }

  // Fallback: numbered lines
  const lines = text
    .split(/\n+/)
    .map((l) => l.replace(/^\s*(?:[-*]|\d+[.)、])\s*/, "").trim())
    .filter((l) => l && !l.startsWith("{") && !l.startsWith("```"));
  return lines.slice(0, 5);
}
