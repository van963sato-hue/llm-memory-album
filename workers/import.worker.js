/* Import Worker: reads ChatGPT Export ZIP (conversations.json inside) OR JSON directly.
   - No external deps: includes a minimal ZIP reader for a single file + deflate via DecompressionStream.
   - Writes normalized sessions into IndexedDB in batches.
   - Generates basic auto History events: first_contact and model_started.
*/
const DB_NAME = "llm_memory_album_v2";
const DB_VER = 3;

const STORES = {
  conv: "conversations",
  moment: "moments",
  prompt: "prompt_profiles",
  asset: "assets",
  label: "model_labels",
  history: "history_events",
  meta: "meta",
  iconcfg: "icon_config"
};

let cancelled = false;

function postStatus(msg) { postMessage({ type: "status", msg }); }
function postProg(done, total, phase = "import") { postMessage({ type: "progress", phase, done, total }); }

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const st of Object.values(STORES)) {
        if (!db.objectStoreNames.contains(st)) db.createObjectStore(st, { keyPath: "id" });
      }
      try {
        const conv = req.transaction.objectStore(STORES.conv);
        if (conv && !conv.indexNames.contains("byUpdatedAt")) conv.createIndex("byUpdatedAt", "updatedAt", { unique: false });
      } catch (e) {}
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function putBatch(db, store, items) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    const st = tx.objectStore(store);
    for (const it of items) st.put(it);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function uid(prefix="id") {
  return `${prefix}_${crypto.getRandomValues(new Uint32Array(2)).join("")}_${Date.now()}`;
}

function u8view(ab) { return new Uint8Array(ab); }

function findEOCD(u8) {
  // EOCD signature 0x06054b50. Search backwards.
  for (let i = u8.length - 22; i >= 0 && i >= u8.length - 70000; i--) {
    if (u8[i] === 0x50 && u8[i+1] === 0x4b && u8[i+2] === 0x05 && u8[i+3] === 0x06) return i;
  }
  return -1;
}

function readU16(u8, off) { return u8[off] | (u8[off+1] << 8); }
function readU32(u8, off) { return (u8[off]) | (u8[off+1] << 8) | (u8[off+2] << 16) | (u8[off+3] << 24) >>> 0; }

async function readBlobSlice(file, start, end) {
  const blob = file.slice(start, end);
  return await blob.arrayBuffer();
}

async function unzipFindFile(file, targetNames) {
  // Read tail to find EOCD
  const tailSize = Math.min(70000, file.size);
  const tailAb = await readBlobSlice(file, file.size - tailSize, file.size);
  const tail = u8view(tailAb);
  const eocdRel = findEOCD(tail);
  if (eocdRel < 0) throw new Error("ZIPのEOCDが見つからない");

  const eocd = (file.size - tailSize) + eocdRel;

  // EOCD structure
  // offset 12: cd size, 16: cd offset
  // But we are reading from tail buffer; compute absolute offsets
  const cdSize = readU32(tail, eocdRel + 12);
  const cdOffset = readU32(tail, eocdRel + 16);

  // Read central directory
  const cdAb = await readBlobSlice(file, cdOffset, cdOffset + cdSize);
  const cd = u8view(cdAb);

  const dec = new TextDecoder("utf-8");
  let p = 0;
  while (p + 46 <= cd.length) {
    // central file header signature 0x02014b50
    if (!(cd[p] === 0x50 && cd[p+1] === 0x4b && cd[p+2] === 0x01 && cd[p+3] === 0x02)) break;

    const compMethod = readU16(cd, p + 10);
    const crc32 = readU32(cd, p + 16);
    const compSize = readU32(cd, p + 20);
    const uncompSize = readU32(cd, p + 24);
    const nameLen = readU16(cd, p + 28);
    const extraLen = readU16(cd, p + 30);
    const commentLen = readU16(cd, p + 32);
    const localOff = readU32(cd, p + 42);

    const name = dec.decode(cd.slice(p + 46, p + 46 + nameLen));
    const next = p + 46 + nameLen + extraLen + commentLen;

    if (targetNames.includes(name)) {
      // Read local header to find data start
      const lhAb = await readBlobSlice(file, localOff, localOff + 30);
      const lh = u8view(lhAb);
      if (!(lh[0] === 0x50 && lh[1] === 0x4b && lh[2] === 0x03 && lh[3] === 0x04)) throw new Error("ZIP local headerが不正");
      const lNameLen = readU16(lh, 26);
      const lExtraLen = readU16(lh, 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;

      const compAb = await readBlobSlice(file, dataStart, dataStart + compSize);
      const compU8 = u8view(compAb);

      if (compMethod === 0) {
        return { name, u8: compU8, crc32, uncompSize };
      }
      if (compMethod === 8) {
        if (typeof DecompressionStream === "undefined") throw new Error("このブラウザはdeflate-raw解凍に非対応です（ZIPを解凍してjsonを入れてね）");
        const ds = new DecompressionStream("deflate-raw");
        const stream = new Blob([compU8]).stream().pipeThrough(ds);
        const out = await new Response(stream).arrayBuffer();
        return { name, u8: u8view(out), crc32, uncompSize };
      }
      throw new Error("未対応の圧縮方式: " + compMethod);
    }
    p = next;
  }

  throw new Error("ZIP内に対象ファイルが見つからない（conversations.json など）");
}

function safeStr(x) { return (typeof x === "string") ? x : ""; }

function normalizeChatGPTConversations(data) {
  const arr = Array.isArray(data) ? data : (data?.conversations || []);
  const out = [];

  for (const c of arr) {
    const mapping = c.mapping || {};
    let nodeId = c.current_node;
    const msgs = [];

    while (nodeId) {
      const node = mapping[nodeId];
      if (!node) break;
      const msg = node.message;
      if (msg?.author?.role && msg?.content?.parts) {
        const parts = msg.content.parts;
        const text = parts.filter(p => typeof p === "string").join("\n");
        if (text && text.trim()) {
          msgs.push({
            role: msg.author.role,
            text,
            ts: msg.create_time || null,
            model: msg?.metadata?.model_slug || msg?.metadata?.model || null
          });
        }
      }
      nodeId = node.parent;
    }
    msgs.reverse();

    if (!c.id || !msgs.length) continue;

    const provider = "openai";
    const id = `${provider}:${c.id}`;

    const models = Array.from(new Set(msgs.map(m => m.model).filter(Boolean)));
    out.push({
      id,
      provider,
      rawId: c.id,
      title: c.title || "(no title)",
      createdAt: c.create_time ? (c.create_time * 1000) : Date.now(),
      updatedAt: c.update_time ? (c.update_time * 1000) : Date.now(),
      models,
      messages: msgs
    });
  }
  return out;
}

function normalizeGenericSessions(data) {
  // Accept:
  // { sessions: [...] } or [...]
  // session: { id?, provider?, title?, createdAt?, updatedAt?, messages:[{role,text,ts?,model?}] }
  const sessions = Array.isArray(data) ? data : (data?.sessions || data?.conversations || []);
  const out = [];

  for (const s of sessions) {
    const provider = safeStr(s.provider) || "other";
    const rawId = safeStr(s.sessionId || s.id) || uid("sess");
    const id = `${provider}:${rawId}`;
    const msgs = Array.isArray(s.messages) ? s.messages.map(m => ({
      role: safeStr(m.role) || "user",
      text: safeStr(m.text),
      ts: m.ts || m.create_time || null,
      model: safeStr(m.model) || null
    })).filter(m => m.text.trim()) : [];
    if (!msgs.length) continue;

    const createdAt = s.createdAt ? Number(s.createdAt) : Date.now();
    const updatedAt = s.updatedAt ? Number(s.updatedAt) : createdAt;
    const models = Array.from(new Set(msgs.map(m => m.model).filter(Boolean)));
    out.push({
      id, provider, rawId,
      title: safeStr(s.title) || "(no title)",
      createdAt, updatedAt, models,
      messages: msgs
    });
  }
  return out;
}

function buildAutoHistory(convs) {
  const events = [];
  let earliest = null;

  // first_contact: earliest user message + earliest assistant message (same session)
  for (const c of convs) {
    const msgs = c.messages || [];
    const firstUser = msgs.find(m => m.role === "user");
    const firstAsst = msgs.find(m => m.role === "assistant");
    const ts = (firstUser?.ts ? firstUser.ts*1000 : c.createdAt) || Date.now();

    if (!earliest || ts < earliest.ts) {
      earliest = { conv: c, firstUser, firstAsst, ts };
    }
  }
  if (earliest) {
    events.push({
      id: uid("hist"),
      ts: earliest.ts,
      title: "初めての一言",
      detail: [
        earliest.firstUser ? `あなた: ${earliest.firstUser.text.slice(0, 180)}` : "",
        earliest.firstAsst ? `相手: ${earliest.firstAsst.text.slice(0, 180)}` : ""
      ].filter(Boolean).join("\n"),
      memory: "",
      provider: earliest.conv.provider || "",
      model: (earliest.conv.models && earliest.conv.models[0]) ? earliest.conv.models[0] : "",
      links: { convId: earliest.conv.id },
      auto: true
    });
  }

  // model_started: for each provider+model, first seen timestamp
  const seen = new Map(); // key -> {ts, convId}
  for (const c of convs) {
    for (const m of (c.messages || [])) {
      if (!m.model) continue;
      const key = `${c.provider}:${m.model}`;
      const ts = m.ts ? m.ts*1000 : c.createdAt;
      const prev = seen.get(key);
      if (!prev || ts < prev.ts) seen.set(key, { ts, convId: c.id });
    }
  }
  for (const [key, v] of seen.entries()) {
    const [provider, model] = key.split(":");
    events.push({
      id: uid("hist"),
      ts: v.ts,
      title: `モデル開始: ${model}`,
      detail: `このモデルが最初に登場したタイミング。`,
      memory: "",
      provider,
      model,
      links: { convId: v.convId },
      auto: true
    });
  }

  return events.sort((a,b)=>a.ts-b.ts);
}

async function handleFile(file) {
  cancelled = false;
  const name = (file.name || "").toLowerCase();

  let sessions = [];
  postStatus("読み込み中…");

  if (name.endsWith(".zip")) {
    postStatus("ZIP解析中…");
    const found = await unzipFindFile(file, ["conversations.json", "conversations.json.txt"]);
    if (cancelled) return;
    const text = new TextDecoder("utf-8").decode(found.u8);
    postStatus("JSONパース中…");
    const data = JSON.parse(text);
    sessions = normalizeChatGPTConversations(data);
  } else {
    postStatus("JSON読み込み中…");
    const text = await file.text();
    const data = JSON.parse(text);
    // Heuristic: ChatGPT export conversations look like array with mapping/current_node
    const isChatGPT = Array.isArray(data) && data[0] && (data[0].mapping || data[0].current_node);
    sessions = isChatGPT ? normalizeChatGPTConversations(data) : normalizeGenericSessions(data);
  }

  if (cancelled) return;

  postStatus(`保存中…（${sessions.length}件）`);
  const db = await openDB();

  // Batch write conversations
  const B = 10;
  for (let i = 0; i < sessions.length; i += B) {
    if (cancelled) return;
    const batch = sessions.slice(i, i + B);
    await putBatch(db, STORES.conv, batch);
    postProg(Math.min(i + B, sessions.length), sessions.length, "save");
    await new Promise(r => setTimeout(r, 0));
  }

  // Auto history (small)
  const hist = buildAutoHistory(sessions);
  if (hist.length) await putBatch(db, STORES.history, hist);

  postMessage({ type: "done", sessions: sessions.length, history: hist.length });
}

onmessage = async (e) => {
  const { type, file } = e.data || {};
  if (type === "cancel") { cancelled = true; postStatus("キャンセルしました"); return; }
  if (type === "import" && file) {
    try {
      await handleFile(file);
    } catch (err) {
      postMessage({ type: "error", msg: String(err?.message || err) });
    }
  }
};
