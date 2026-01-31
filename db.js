const DB_NAME = "llm_memory_album_v2";
const DB_VER = 4;

export const STORES = {
  conv: "conversations",
  moment: "moments",
  prompt: "prompt_profiles",
  asset: "assets",
  label: "model_labels",
  history: "history_events",
  meta: "meta",
  iconcfg: "icon_config",
  // v4: チェックポイント機能
  importState: "import_state",  // key=fileSignature, value={offsetBytes, processedCount, savedCount, skippedCount, updatedAt}
  convIndex: "conv_index"       // key=id, value={updateTime} - 重複検出用軽量インデックス
};

export const DB = { DB_NAME, DB_VER };

// ============================================================
// マイグレーション定義
// 今後のアップデート時はここに追加
// ============================================================
const MIGRATIONS = {
  // v4: conv_indexストア追加 + 既存データからインデックス構築
  4: (db, tx, oldVersion) => {
    if (oldVersion > 0) {
      try {
        const convStore = tx.objectStore(STORES.conv);
        const idxStore = tx.objectStore(STORES.convIndex);
        const cursor = convStore.openCursor();
        cursor.onsuccess = function () {
          const c = cursor.result;
          if (c) {
            const conv = c.value;
            idxStore.put({ id: conv.id, updateTime: conv.updatedAt || 0 });
            c.continue();
          }
        };
        console.log("[Migration v4] conv_index構築完了");
      } catch (e) {
        console.warn("[Migration v4] conv_index構築エラー:", e);
      }
    }
  },

  // ============================================================
  // 今後のアップデート用テンプレート
  // ============================================================
  //
  // 【新バージョン追加手順】
  // 1. DB_VER を新しいバージョン番号に更新
  // 2. 必要なら STORES に新しいストア名を追加
  // 3. 以下のテンプレートをコピーしてマイグレーション処理を追加
  //
  // 例: v5 でアイコンプリセット機能を追加する場合
  // -----------------------------------------------------
  // 5: (db, tx, oldVersion) => {
  //   // 新ストアは ensureStores() で自動作成されるため、
  //   // ここではデータ変換のみ行う
  //
  //   if (oldVersion > 0) {
  //     try {
  //       // 例: 既存アイコン設定からプリセットを生成
  //       const cfgStore = tx.objectStore(STORES.iconcfg);
  //       const presetStore = tx.objectStore(STORES.iconPreset);
  //       const cursor = cfgStore.openCursor();
  //       cursor.onsuccess = function () {
  //         const c = cursor.result;
  //         if (c) {
  //           // データ変換処理...
  //           c.continue();
  //         }
  //       };
  //       console.log("[Migration v5] アイコンプリセット移行完了");
  //     } catch (e) {
  //       console.warn("[Migration v5] エラー:", e);
  //     }
  //   }
  // },
  // -----------------------------------------------------
};

// ストア作成を保証（既存は保持）
function ensureStores(db) {
  for (const s of Object.values(STORES)) {
    if (!db.objectStoreNames.contains(s)) {
      db.createObjectStore(s, { keyPath: "id" });
    }
  }
}

// インデックス作成（UI用ソート/フィルタ）
function ensureIndexes(tx) {
  try {
    const conv = tx.objectStore(STORES.conv);
    if (!conv.indexNames.contains("byUpdatedAt")) conv.createIndex("byUpdatedAt", "updatedAt", { unique: false });
  } catch {}
  try {
    const moment = tx.objectStore(STORES.moment);
    if (!moment.indexNames.contains("byCreatedAt")) moment.createIndex("byCreatedAt", "createdAt", { unique: false });
  } catch {}
  try {
    const hist = tx.objectStore(STORES.history);
    if (!hist.indexNames.contains("byTs")) hist.createIndex("byTs", "ts", { unique: false });
  } catch {}
}

// バージョン別マイグレーション実行
function runMigrations(db, tx, oldVersion) {
  // oldVersion+1 から DB_VER まで順番に実行
  for (let v = oldVersion + 1; v <= DB_VER; v++) {
    if (MIGRATIONS[v]) {
      console.log(`[DB] マイグレーション v${v} 実行中...`);
      MIGRATIONS[v](db, tx, oldVersion);
    }
  }
}

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const tx = req.transaction;
      const oldVersion = event.oldVersion;

      console.log(`[DB] アップグレード: v${oldVersion} → v${DB_VER}`);

      // 1. ストア作成（既存データは保持）
      ensureStores(db);

      // 2. インデックス作成
      ensureIndexes(tx);

      // 3. バージョン別マイグレーション
      runMigrations(db, tx, oldVersion);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function putMany(store, items) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    const st = tx.objectStore(store);
    for (const it of items) st.put(it);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function putOne(store, item) {
  return putMany(store, [item]);
}

export async function getAll(store) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const st = tx.objectStore(store);
    const req = st.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export async function getOne(store, id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const st = tx.objectStore(store);
    const req = st.get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function clearAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(Object.values(STORES), "readwrite");
    for (const s of Object.values(STORES)) tx.objectStore(s).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export function uid(prefix = "id") {
  return `${prefix}_${crypto.getRandomValues(new Uint32Array(2)).join("")}_${Date.now()}`;
}
