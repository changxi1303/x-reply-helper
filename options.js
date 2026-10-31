const DEFAULT_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL = "gpt-4o-mini";

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

const BUILTIN_PERSONAS = {
  default: DEFAULT_PERSONA,
  serena: `我是 Serena，在中文评论区随手回一句。语气偏温柔、体贴，但不矫情。

我平时聊生活、情绪、AI 小工具，也关心「怎么把事做得轻松一点」。

我说话的样子：
- 先接住对方的感受或处境，再补一句具体的小建议或共鸣。
- 句子软一点，但有内容；不空夸，也不鸡汤。
- 可以轻轻鼓励，但别喊口号；偶尔问一句关心式的问题（三条里最多一条）。
- 不总结升华、不列一二三、不装人生导师。
- emoji 最多一个，能不用就不用。

不说：首先/其次/总之、值得注意的是、作为 AI、希望对你有帮助、赋能/落地/闭环、互关求赞。`,
  awe0: `我是 awe0，在中文评论区随手回一句。语气偏产品/技术向：直接、有判断、少客套。

我平时聊 AI 产品、工作流、增长和工程取舍。

我说话的样子：
- 先抓一个可验证的点（成本、延迟、转化、可维护性），再给自己的判断。
- 句子短，允许半截句；更像同事在 PR 下随口评一句。
- 可以认同也可以否，但要有理由；别和稀泥。
- 偶尔追问一个真正影响决策的问题（三条里最多一条）。
- 不吹捧、不教做人、不写小作文。
- emoji 基本不用。

不说：首先/其次/总之、值得注意的是、作为 AI、希望对你有帮助、赋能/落地/闭环、互关求赞。`,
  stanley: `我是 Stanley，在中文评论区随手回一句。语气偏机智、短促，偶尔带一点轻轻的吐槽，但不阴阳。

我平时聊互联网观察、AI 热闹和职场荒诞。

我说话的样子：
- 先点破原帖里一个好笑或扎眼的细节，再补一句自己的看法。
- 句子要短、有节奏；可以接梗，但别硬抖机灵。
- 认同就干脆夸到点上；不同意就一针见血，不绕。
- 三条里最多一条真问句。
- 不总结、不升华、不装深沉。
- emoji 最多一个。

不说：首先/其次/总之、值得注意的是、作为 AI、希望对你有帮助、赋能/落地/闭环、互关求赞。`,
};

function needsPersonaMigration(text) {
  const t = String(text || "");
  if (/AI省时间|省时间做法/.test(t)) return true;
  return /严禁疑问句/.test(t) && /友善吹捧/.test(t) && /温和反驳/.test(t);
}

function resolvePresetText(id, customText) {
  if (id === "custom") return (customText || DEFAULT_PERSONA).trim() || DEFAULT_PERSONA;
  return BUILTIN_PERSONAS[id] || DEFAULT_PERSONA;
}

const apiKeyEl = document.getElementById("apiKey");
const endpointEl = document.getElementById("endpoint");
const modelEl = document.getElementById("model");
const modelSelectEl = document.getElementById("modelSelect");
const autoGenerateEl = document.getElementById("autoGenerate");
const cacheEnabledEl = document.getElementById("cacheEnabled");
const commentLimitEl = document.getElementById("commentLimit");
const autoFillFirstEl = document.getElementById("autoFillFirst");
const likeAfterReplyEl = document.getElementById("likeAfterReply");
const fastModeEl = document.getElementById("fastMode");
const qualityFirstEl = document.getElementById("qualityFirst");
const memorySaverEl = document.getElementById("memorySaver");
const personaPresetEl = document.getElementById("personaPreset");
const personaTextEl = document.getElementById("personaText");
const msgEl = document.getElementById("msg");
const fetchBtn = document.getElementById("fetchModels");

/** Keep custom text separately so switching presets never wipes it. */
let customPersonaText = "";
let applyingPreset = false;

function showMsg(text, ok) {
  msgEl.textContent = text;
  msgEl.className = ok ? "ok" : "err";
}

function fillModelSelect(models, selected) {
  modelSelectEl.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = models.length ? "— 选择模型 —" : "— 先点「读取模型」—";
  modelSelectEl.appendChild(placeholder);
  for (const id of models) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = id;
    if (selected && id === selected) opt.selected = true;
    modelSelectEl.appendChild(opt);
  }
  if (selected && models.includes(selected)) {
    modelSelectEl.value = selected;
  }
}

function applyPresetToTextarea(id) {
  applyingPreset = true;
  personaPresetEl.value = id;
  personaTextEl.value = resolvePresetText(id, customPersonaText);
  applyingPreset = false;
}

async function load() {
  const data = await chrome.storage.sync.get({
    apiKey: "",
    endpoint: DEFAULT_ENDPOINT,
    model: DEFAULT_MODEL,
    modelList: [],
    autoGenerate: false,
    cacheEnabled: true,
    autoFillFirst: false,
    likeAfterReply: false,
    fastMode: true,
    qualityFirst: false,
    memorySaver: true,
    commentLimit: 15,
    personaId: "default",
    personaText: DEFAULT_PERSONA,
    customPersonaText: "",
  });
  apiKeyEl.value = data.apiKey || "";
  endpointEl.value = data.endpoint || DEFAULT_ENDPOINT;
  modelEl.value = data.model || DEFAULT_MODEL;
  autoGenerateEl.checked = !!data.autoGenerate;
  cacheEnabledEl.checked = data.cacheEnabled !== false;
  autoFillFirstEl.checked = !!data.autoFillFirst;
  likeAfterReplyEl.checked = !!data.likeAfterReply;
  fastModeEl.checked = data.fastMode !== false;
  qualityFirstEl.checked = !!data.qualityFirst;
  memorySaverEl.checked = data.memorySaver !== false;
  commentLimitEl.value = String([10, 15, 20, 30].includes(Number(data.commentLimit)) ? Number(data.commentLimit) : 15);

  customPersonaText = (data.customPersonaText || "").trim();
  let personaId = data.personaId || "default";
  if (!["default", "serena", "awe0", "stanley", "custom"].includes(personaId)) {
    personaId = "default";
  }

  let savedPersona = (data.personaText || DEFAULT_PERSONA).trim() || DEFAULT_PERSONA;
  if (needsPersonaMigration(savedPersona)) {
    savedPersona = DEFAULT_PERSONA;
  }
  if (!customPersonaText && personaId === "custom") {
    customPersonaText = savedPersona;
  }
  if (!customPersonaText) {
    customPersonaText = DEFAULT_PERSONA;
  }

  applyPresetToTextarea(personaId);
  // If stored active text differs from builtin (user edited builtin previously), show stored text for custom
  if (personaId === "custom") {
    personaTextEl.value = customPersonaText;
  }

  fillModelSelect(Array.isArray(data.modelList) ? data.modelList : [], data.model || "");
}

modelSelectEl.addEventListener("change", () => {
  if (modelSelectEl.value) {
    modelEl.value = modelSelectEl.value;
  }
});

personaPresetEl.addEventListener("change", () => {
  const id = personaPresetEl.value || "default";
  // Persist current custom textarea if leaving custom
  if (personaTextEl.dataset.prevId === "custom" || (!personaTextEl.dataset.prevId && id !== "custom")) {
    // no-op; handled below
  }
  if ((personaPresetEl.dataset.current || "default") === "custom") {
    customPersonaText = personaTextEl.value.trim() || customPersonaText || DEFAULT_PERSONA;
  }
  applyPresetToTextarea(id);
  personaPresetEl.dataset.current = id;
  showMsg("已切换预设预览（记得点「保存」）。自定义文案仍保留。", true);
});

personaTextEl.addEventListener("input", () => {
  if (applyingPreset) return;
  const id = personaPresetEl.value || "default";
  if (id === "custom") {
    customPersonaText = personaTextEl.value;
    return;
  }
  // Editing a builtin → move into custom so we never overwrite built-in constants
  customPersonaText = personaTextEl.value;
  applyingPreset = true;
  personaPresetEl.value = "custom";
  personaPresetEl.dataset.current = "custom";
  applyingPreset = false;
});

fetchBtn.addEventListener("click", async () => {
  const apiKey = apiKeyEl.value.trim();
  const endpoint = endpointEl.value.trim() || DEFAULT_ENDPOINT;
  if (!apiKey) {
    showMsg("请先填写 API Key，再读取模型。", false);
    return;
  }
  fetchBtn.disabled = true;
  fetchBtn.textContent = "读取中…";
  showMsg("正在请求模型列表…", true);
  try {
    const result = await chrome.runtime.sendMessage({
      type: "LIST_MODELS",
      payload: { apiKey, endpoint },
    });
    if (!result?.ok) {
      showMsg(result?.error || "读取失败", false);
      return;
    }
    const models = result.models || [];
    await chrome.storage.sync.set({ modelList: models });
    const current = modelEl.value.trim();
    fillModelSelect(models, current);
    if (current && models.includes(current)) {
      modelSelectEl.value = current;
    } else if (models.length === 1) {
      modelSelectEl.value = models[0];
      modelEl.value = models[0];
    }
    const where = result.modelsUrl ? `\n来源：${result.modelsUrl}` : "";
    const hint = result.fallback && result.errorHint ? `\n（列表接口异常已用兜底：${result.errorHint}）` : (result.fallback ? "\n（列表接口异常，已用内置常用模型）" : "");
    showMsg(`已读取 ${models.length} 个模型，请选择后点「保存」。${where}${hint}`, true);
  } catch (err) {
    showMsg(`读取失败：${err?.message || err}`, false);
  } finally {
    fetchBtn.disabled = false;
    fetchBtn.textContent = "读取模型";
  }
});

document.getElementById("resetPersona").addEventListener("click", () => {
  customPersonaText = DEFAULT_PERSONA;
  applyPresetToTextarea("default");
  personaPresetEl.dataset.current = "default";
  showMsg("已恢复默认人设（记得点「保存」）。自定义文案也重置为默认模板。", true);
});

document.getElementById("save").addEventListener("click", async () => {
  const apiKey = apiKeyEl.value.trim();
  const endpoint = endpointEl.value.trim() || DEFAULT_ENDPOINT;
  const model = (modelSelectEl.value || modelEl.value).trim() || DEFAULT_MODEL;
  const autoGenerate = !!autoGenerateEl.checked;
  const cacheEnabled = !!cacheEnabledEl.checked;
  const autoFillFirst = !!autoFillFirstEl.checked;
  const likeAfterReply = !!likeAfterReplyEl.checked;
  const fastMode = !!fastModeEl.checked;
  const qualityFirst = !!qualityFirstEl.checked;
  const memorySaver = !!memorySaverEl.checked;
  const commentLimit = Number(commentLimitEl.value) || 15;
  let personaId = personaPresetEl.value || "default";
  if (!["default", "serena", "awe0", "stanley", "custom"].includes(personaId)) {
    personaId = "default";
  }

  if (personaId === "custom") {
    customPersonaText = personaTextEl.value.trim() || DEFAULT_PERSONA;
  }

  const personaText = resolvePresetText(personaId, customPersonaText);

  if (!apiKey) {
    showMsg("请填写 API Key。", false);
    return;
  }
  if (!/^https?:\/\//i.test(endpoint)) {
    showMsg("Endpoint 需要以 http:// 或 https:// 开头。", false);
    return;
  }
  modelEl.value = model;
  personaTextEl.value = personaText;
  personaPresetEl.dataset.current = personaId;

  const stored = await chrome.storage.sync.get({ modelList: [] });
  await chrome.storage.sync.set({
    apiKey,
    endpoint,
    model,
    autoGenerate,
    cacheEnabled,
    autoFillFirst,
    likeAfterReply,
    fastMode,
    qualityFirst,
    memorySaver,
    commentLimit,
    personaId,
    personaText,
    customPersonaText: customPersonaText || DEFAULT_PERSONA,
    modelList: stored.modelList || [],
  });
  const bits = [];
  bits.push(`人设：${personaPresetEl.options[personaPresetEl.selectedIndex]?.text || personaId}`);
  bits.push(autoGenerate ? "自动生成：开" : "自动生成：关");
  bits.push(cacheEnabled ? "同帖缓存：开" : "同帖缓存：关");
  bits.push(autoFillFirst ? "自动填入第1条：开" : "自动填入第1条：关");
  bits.push(likeAfterReply ? "回复后点赞：开" : "回复后点赞：关");
  bits.push(fastMode ? "快速模式：开" : "快速模式：关");
  bits.push(qualityFirst ? "质量优先：开" : "质量优先：关");
  bits.push(memorySaver ? "省内存：开" : "省内存：关");
  bits.push(`评论抽样：${commentLimit} 条`);
  showMsg("已保存。" + bits.join("；") + "。返回帖子页可用闪电或 Alt+Shift+G 生成。", true);
});

document.getElementById("clearKey").addEventListener("click", async () => {
  apiKeyEl.value = "";
  await chrome.storage.sync.set({ apiKey: "" });
  showMsg("已清除 API Key。", true);
});

load();


async function refreshFeedbackMeta() {
  const el = document.getElementById("feedbackMeta");
  if (!el) return;
  try {
    const res = await chrome.runtime.sendMessage({ type: "GET_REPLY_FEEDBACK_META" });
    if (!res?.ok) {
      el.textContent = "评价记录：无法读取";
      return;
    }
    el.textContent = `评价记录：共 ${res.count || 0} 条（满意 ${res.ups || 0} / 不行 ${res.downs || 0}，最多保留约 80 条）`;
  } catch {
    el.textContent = "评价记录：无法读取";
  }
}

document.getElementById("clearFeedback")?.addEventListener("click", async () => {
  if (!confirm("清空全部草稿评价记录？下次生成将不再参考这些偏好。")) return;
  try {
    const res = await chrome.runtime.sendMessage({ type: "CLEAR_REPLY_FEEDBACK" });
    if (res?.ok) {
      showMsg("已清空评价记录。", true);
      refreshFeedbackMeta();
    } else {
      showMsg(res?.error || "清空失败", false);
    }
  } catch (err) {
    showMsg(String(err?.message || err), false);
  }
});

refreshFeedbackMeta();

const nfCapEl = document.getElementById("nfCap");
const nfMetaEl = document.getElementById("nfMeta");
const nfListEl = document.getElementById("nfList");
const NF_CAP_KEY = "xrhNonFollowCap";
const NF_KEY = "xrhNonFollow";
let nfDisplay = 40;

function nfWhen(ts) {
  if (!ts) return "";
  const date = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
}

function renderNonFollow(stored) {
  if (!nfListEl || !nfMetaEl || !window.XrhNonFollow) return;
  nfListEl.textContent = "";
  if (!window.XrhNonFollow.isStoredResult(stored)) {
    nfMetaEl.textContent = "尚未扫描。打开 x.com 后点「在 x.com 打开未回关」。";
    return;
  }
  const when = nfWhen(stored.scannedAt);
  const who = stored.self?.handle ? " @" + stored.self.handle : "";
  nfMetaEl.textContent =
    `上次 ${when}${who} · 未回关 ${stored.items.length} 个 · 已扫关注 ${stored.followingScanned || 0}` +
    (stored.note ? "。" + stored.note : "");
  const slice = stored.items.slice(0, nfDisplay);
  for (const item of slice) {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;justify-content:space-between;gap:8px;align-items:center;padding:8px 0;border-top:1px solid var(--border);";
    const text = document.createElement("div");
    const name = document.createElement("div");
    name.textContent = item.name || item.handle || item.id;
    const meta = document.createElement("div");
    meta.style.cssText = "font-size:12px;color:var(--muted);";
    const fans = item.followersCount == null ? "" : " · 粉丝 " + window.XrhNonFollow.formatCount(item.followersCount);
    meta.textContent = (item.handle ? "@" + item.handle : "ID " + item.id) + fans;
    text.appendChild(name);
    text.appendChild(meta);
    const link = document.createElement("a");
    link.href = window.XrhNonFollow.profileUrl(item);
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "打开";
    link.style.color = "var(--accent)";
    row.appendChild(text);
    row.appendChild(link);
    nfListEl.appendChild(row);
  }
  if (stored.items.length > slice.length) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "secondary";
    more.style.marginTop = "8px";
    more.textContent = `再显示一批（${slice.length}/${stored.items.length}）`;
    more.addEventListener("click", () => {
      nfDisplay += 40;
      renderNonFollow(stored);
    });
    nfListEl.appendChild(more);
  }
}

async function loadNonFollow() {
  const stored = await chrome.storage.local.get({
    [NF_CAP_KEY]: 2000,
    [NF_KEY]: null,
  });
  if (nfCapEl) nfCapEl.value = String(window.XrhNonFollow.clampCap(stored[NF_CAP_KEY]));
  renderNonFollow(stored[NF_KEY]);
}

nfCapEl?.addEventListener("change", async () => {
  const cap = window.XrhNonFollow.clampCap(nfCapEl.value);
  nfCapEl.value = String(cap);
  await chrome.storage.local.set({ [NF_CAP_KEY]: cap });
  showMsg("未回关扫描上限已设为 " + cap + "。", true);
});

document.getElementById("nfOpen")?.addEventListener("click", async () => {
  try {
    const result = await chrome.runtime.sendMessage({ type: "OPEN_NONFOLLOW" });
    showMsg(result?.ok ? "已打开 x.com 上的未回关面板。" : (result?.error || "打不开"), !!result?.ok);
  } catch (err) {
    showMsg(String(err?.message || err), false);
  }
});

document.getElementById("nfExport")?.addEventListener("click", async () => {
  const stored = await chrome.storage.local.get({ [NF_KEY]: null });
  const data = stored[NF_KEY];
  if (!window.XrhNonFollow.isStoredResult(data) || !data.items.length) {
    showMsg("没有可导出的未回关结果。", false);
    return;
  }
  const blob = new Blob([window.XrhNonFollow.toCsv(data.items)], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "xrh-nonfollow.csv";
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1500);
});

document.getElementById("nfClear")?.addEventListener("click", async () => {
  if (!confirm("清空本机保存的未回关结果？")) return;
  await chrome.storage.local.remove(NF_KEY);
  nfDisplay = 40;
  renderNonFollow(null);
  showMsg("已清空未回关结果。", true);
});

loadNonFollow();
