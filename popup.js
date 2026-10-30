document.getElementById("openOptions").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

(async () => {
  const status = document.getElementById("status");
  try {
    const { apiKey, endpoint, model } = await chrome.storage.sync.get({
      apiKey: "",
      endpoint: "",
      model: "",
    });
    if (!apiKey) {
      status.className = "status err";
      status.textContent = "尚未配置 API Key，请先打开设置。";
    } else {
      status.className = "status ok";
      status.textContent = `已配置 · 模型 ${model || "（默认）"}`;
      if (endpoint) status.title = endpoint;
    }
  } catch (e) {
    status.className = "status err";
    status.textContent = "读取配置失败";
  }
})();

async function loadInbox() {
  const list = document.getElementById("inboxList");
  const empty = document.getElementById("inboxEmpty");
  list.innerHTML = "";
  try {
    const result = await chrome.runtime.sendMessage({ type: "INBOX_LIST" });
    if (!result?.ok) {
      empty.textContent = result?.error || "读取失败";
      return;
    }
    const items = result.items || [];
    if (!items.length) {
      empty.textContent = "暂无。打开 x.com/notifications 或提及页刷一下再回来。";
      return;
    }
    empty.textContent = "";
    for (const it of items) {
      const row = document.createElement("div");
      row.className = "item";
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = `${it.from ? "@" + it.from + " · " : ""}${it.kind || ""}`;
      const preview = document.createElement("div");
      preview.className = "preview";
      preview.textContent = it.preview || it.statusId || "";
      const open = document.createElement("a");
      open.href = it.url || `https://x.com/i/status/${it.statusId}`;
      open.target = "_blank";
      open.rel = "noopener noreferrer";
      open.textContent = "打开";
      const done = document.createElement("button");
      done.type = "button";
      done.className = "linkish";
      done.textContent = "已回";
      done.addEventListener("click", async () => {
        await chrome.runtime.sendMessage({
          type: "INBOX_MARK_REPLIED",
          payload: { id: it.id, statusId: it.statusId },
        });
        loadInbox();
      });
      const skip = document.createElement("button");
      skip.type = "button";
      skip.className = "linkish";
      skip.textContent = "忽略";
      skip.addEventListener("click", async () => {
        await chrome.runtime.sendMessage({ type: "INBOX_DISMISS", payload: { id: it.id } });
        loadInbox();
      });
      row.appendChild(meta);
      row.appendChild(preview);
      row.appendChild(open);
      row.appendChild(done);
      row.appendChild(skip);
      list.appendChild(row);
    }
  } catch (e) {
    empty.textContent = "读取待回失败";
  }
}

loadInbox();
