/**
 * FogWalker v2.0 - コアスクリプト
 * 「歩いた場所だけが、光る。」
 * 黒基調・コマンドプロンプト風 極限ミニマル位置情報PWA
 */

(() => {
  'use strict';

  // ==========================================
  // 1. 定数 & 設定パラメータ
  // ==========================================
  const LAT_GRID = 0.000135; // 1マスの緯度幅（約15m相当）
  const CLEAR_RADIUS_TILES = 3; // 霧晴らし半径（マス数、約45m、円内約29マス）
  const TOTAL_EARTH_TILES = 2266958222222; // 地球全表面積（約5.1億km²）/ 225㎡
  const DB_NAME = 'FogWalkerDB_v2';
  const DB_VERSION = 1;

  // ==========================================
  // 2. 状態管理 (State)
  // ==========================================
  const state = {
    // プレイヤー位置（初期値：大阪周辺）
    lat: 34.6654,
    lng: 135.6268,
    targetLat: 34.6654,
    targetLng: 135.6268,
    isFirstFix: true,

    // 開拓マス管理 (Map: key -> { id, latIdx, lngIdx, exploredAt })
    tiles: new Map(),
    totalDistance: 0,
    lastLat: null,
    lastLng: null,

    // ストリーク
    streak: 1,
    lastActiveDate: '',

    // 動作モード
    mode: 'gps', // 'gps' | 'dpad'
    gpsWatchId: null,
    gpsActive: false,

    // サウンド設定
    soundEnabled: true,
    audioCtx: null,

    // 描画関連
    canvas: null,
    ctx: null,
    width: 0,
    height: 0,
    scale: 28, // 1マスの画面上ピクセルサイズ
    pixelRatio: window.devicePixelRatio || 1,
    cursorBlinkState: true,
    lastBlinkTime: 0
  };

  // ==========================================
  // 3. 数学 & グリッド計算
  // ==========================================
  function getLngGrid(lat) {
    const rad = (lat * Math.PI) / 180;
    const cosVal = Math.max(0.1, Math.cos(rad));
    return LAT_GRID / cosVal;
  }

  function getTileIndices(lat, lng) {
    const latIdx = Math.floor(lat / LAT_GRID);
    const lngGrid = getLngGrid(lat);
    const lngIdx = Math.floor(lng / lngGrid);
    return { latIdx, lngIdx, id: `${latIdx}_${lngIdx}` };
  }

  function getTileCenter(latIdx, lngIdx) {
    const lat = (latIdx + 0.5) * LAT_GRID;
    const lngGrid = getLngGrid(lat);
    const lng = (lngIdx + 0.5) * lngGrid;
    return { lat, lng };
  }

  function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  function getTodayString() {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('ja-JP', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    const parts = formatter.formatToParts(now);
    const y = parts.find((p) => p.type === 'year').value;
    const m = parts.find((p) => p.type === 'month').value;
    const d = parts.find((p) => p.type === 'day').value;
    return `${y}-${m}-${d}`;
  }

  function getYesterdayString() {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    const formatter = new Intl.DateTimeFormat('ja-JP', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    const parts = formatter.formatToParts(d);
    const y = parts.find((p) => p.type === 'year').value;
    const m = parts.find((p) => p.type === 'month').value;
    const day = parts.find((p) => p.type === 'day').value;
    return `${y}-${m}-${day}`;
  }

  // ==========================================
  // 4. Web Audio シンセサイザー（CUIクリック音）
  // ==========================================
  function playBlip(freq = 980, duration = 0.035) {
    if (!state.soundEnabled) return;
    try {
      if (!state.audioCtx) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (AudioContextClass) state.audioCtx = new AudioContextClass();
      }
      if (!state.audioCtx) return;
      if (state.audioCtx.state === 'suspended') {
        state.audioCtx.resume();
      }
      const osc = state.audioCtx.createOscillator();
      const gain = state.audioCtx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(freq, state.audioCtx.currentTime);
      gain.gain.setValueAtTime(0.04, state.audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, state.audioCtx.currentTime + duration);
      osc.connect(gain);
      gain.connect(state.audioCtx.destination);
      osc.start();
      osc.stop(state.audioCtx.currentTime + duration);
    } catch (_) {}
  }

  // ==========================================
  // 5. IndexedDB 永続化ストレージ
  // ==========================================
  let db = null;

  function initDB() {
    return new Promise((resolve) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = (e) => {
        const database = e.target.result;
        if (!database.objectStoreNames.contains('tiles')) {
          database.createObjectStore('tiles', { keyPath: 'id' });
        }
        if (!database.objectStoreNames.contains('meta')) {
          database.createObjectStore('meta', { keyPath: 'key' });
        }
      };
      request.onsuccess = (e) => {
        db = e.target.result;
        resolve(db);
      };
      request.onerror = () => {
        console.warn('IndexedDB unavailable, using memory.');
        resolve(null);
      };
    });
  }

  async function loadAllFromDB() {
    if (!db) return;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(['tiles', 'meta'], 'readonly');
        const tilesStore = tx.objectStore('tiles');
        const metaStore = tx.objectStore('meta');

        const tileReq = tilesStore.getAll();
        tileReq.onsuccess = () => {
          if (tileReq.result) {
            tileReq.result.forEach((t) => state.tiles.set(t.id, t));
          }
        };

        const metaReq = metaStore.getAll();
        metaReq.onsuccess = () => {
          if (metaReq.result) {
            metaReq.result.forEach((m) => {
              if (m.key === 'streak') state.streak = m.value;
              if (m.key === 'lastActiveDate') state.lastActiveDate = m.value;
              if (m.key === 'totalDistance') state.totalDistance = m.value;
            });
          }
        };

        tx.oncomplete = () => {
          updateUI();
          resolve();
        };
        tx.onerror = () => resolve();
      } catch (err) {
        resolve();
      }
    });
  }

  function saveTileToDB(tile) {
    if (!db) return;
    try {
      const tx = db.transaction('tiles', 'readwrite');
      tx.objectStore('tiles').put(tile);
    } catch (_) {}
  }

  function saveMetaToDB(key, value) {
    if (!db) return;
    try {
      const tx = db.transaction('meta', 'readwrite');
      tx.objectStore('meta').put({ key, value });
    } catch (_) {}
  }

  // ==========================================
  // 6. 霧晴らし & ストリーク更新ロジック
  // ==========================================
  function revealTilesAt(lat, lng) {
    const center = getTileIndices(lat, lng);
    const now = Date.now();
    let newTileCount = 0;

    for (let dy = -CLEAR_RADIUS_TILES; dy <= CLEAR_RADIUS_TILES; dy++) {
      for (let dx = -CLEAR_RADIUS_TILES; dx <= CLEAR_RADIUS_TILES; dx++) {
        if (dx * dx + dy * dy <= CLEAR_RADIUS_TILES * CLEAR_RADIUS_TILES) {
          const latIdx = center.latIdx + dy;
          const lngIdx = center.lngIdx + dx;
          const id = `${latIdx}_${lngIdx}`;

          if (!state.tiles.has(id)) {
            const tile = { id, latIdx, lngIdx, exploredAt: now };
            state.tiles.set(id, tile);
            saveTileToDB(tile);
            newTileCount++;
          }
        }
      }
    }

    if (newTileCount > 0) {
      playBlip(1200, 0.04);
      updateStreak();
      updateUI();
    }
  }

  function updateStreak() {
    const today = getTodayString();
    const yesterday = getYesterdayString();

    if (state.lastActiveDate === today) {
      // 本日すでに開拓済み
      return;
    }

    if (state.lastActiveDate === yesterday) {
      state.streak += 1;
    } else {
      state.streak = 1;
    }

    state.lastActiveDate = today;
    saveMetaToDB('streak', state.streak);
    saveMetaToDB('lastActiveDate', state.lastActiveDate);
  }

  // ==========================================
  // 7. UI表示更新
  // ==========================================
  function updateUI() {
    const tileCount = state.tiles.size;
    const streakDays = state.streak;

    // ヘッダー
    const elStreak = document.getElementById('statStreak');
    if (elStreak) elStreak.textContent = streakDays;

    const elTiles = document.getElementById('statTiles');
    if (elTiles) elTiles.textContent = tileCount.toLocaleString();

    const elLevel = document.getElementById('statLevel');
    if (elLevel) {
      const level = Math.floor(Math.sqrt(tileCount / 10)) + 1;
      elLevel.textContent = `(LV: ${String(level).padStart(2, '0')})`;
    }

    // 全人類地球開拓カウンター
    const pct = (tileCount / TOTAL_EARTH_TILES) * 100;
    const elPct = document.getElementById('statGlobalPct');
    if (elPct) elPct.textContent = `${pct.toFixed(7)}%`;

    const elCount = document.getElementById('statGlobalCount');
    if (elCount) {
      elCount.textContent = `[${tileCount.toLocaleString()} / 2,266,958,222,222]`;
    }

    // 座標
    const elCoords = document.getElementById('playerCoords');
    if (elCoords) {
      elCoords.textContent = `LOC: ${state.lat.toFixed(4)}, ${state.lng.toFixed(4)}`;
    }

    // モーダル側
    const modalStreak = document.getElementById('modalStreak');
    if (modalStreak) modalStreak.textContent = streakDays;
    const modalTiles = document.getElementById('modalTiles');
    if (modalTiles) modalTiles.textContent = tileCount.toLocaleString();
    const modalDist = document.getElementById('modalDistance');
    if (modalDist) modalDist.textContent = Math.round(state.totalDistance).toLocaleString();
    const modalGlobal = document.getElementById('modalGlobal');
    if (modalGlobal) modalGlobal.textContent = `${pct.toFixed(7)}%`;
  }

  // ==========================================
  // 8. Canvas レンダリングエンジン
  // ==========================================
  function resizeCanvas() {
    state.width = state.canvas.parentElement.clientWidth;
    state.height = state.canvas.parentElement.clientHeight;
    state.canvas.width = state.width * state.pixelRatio;
    state.canvas.height = state.height * state.pixelRatio;
    state.ctx.scale(state.pixelRatio, state.pixelRatio);
  }

  function render(timestamp) {
    const ctx = state.ctx;
    const w = state.width;
    const h = state.height;

    // 1. 背景：完全な黒
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, w, h);

    const centerX = w / 2;
    const centerY = h / 2;

    const currentLngGrid = getLngGrid(state.lat);
    const now = Date.now();

    // 画面内に描画すべきマスを計算
    const visibleHalfTilesX = Math.ceil(w / (2 * state.scale)) + 2;
    const visibleHalfTilesY = Math.ceil(h / (2 * state.scale)) + 2;

    const centerIndices = getTileIndices(state.lat, state.lng);

    // 2. 開拓済みマスの描画（白い四角）
    for (let dy = -visibleHalfTilesY; dy <= visibleHalfTilesY; dy++) {
      for (let dx = -visibleHalfTilesX; dx <= visibleHalfTilesX; dx++) {
        const latIdx = centerIndices.latIdx + dy;
        const lngIdx = centerIndices.lngIdx + dx;
        const id = `${latIdx}_${lngIdx}`;

        const tile = state.tiles.get(id);
        if (tile) {
          const tileCenter = getTileCenter(latIdx, lngIdx);
          const screenX = centerX + ((tileCenter.lng - state.lng) / currentLngGrid) * state.scale;
          const screenY = centerY - ((tileCenter.lat - state.lat) / LAT_GRID) * state.scale;

          // 直近歩行マスは高輝度白、過去のマスは淡い白
          const ageHours = (now - tile.exploredAt) / (1000 * 60 * 60);
          let alpha = 0.45;
          if (ageHours < 1) alpha = 1.0;
          else if (ageHours < 24) alpha = 0.75;

          ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
          const halfSize = (state.scale - 2) / 2;
          ctx.fillRect(screenX - halfSize, screenY - halfSize, state.scale - 2, state.scale - 2);

          // マス枠線
          ctx.strokeStyle = `rgba(255, 255, 255, ${alpha * 0.3})`;
          ctx.lineWidth = 1;
          ctx.strokeRect(screenX - halfSize, screenY - halfSize, state.scale - 2, state.scale - 2);
        }
      }
    }

    // 3. 点滅カーソル自機（█ / Blinking Cursor）の描画
    if (timestamp - state.lastBlinkTime > 400) {
      state.cursorBlinkState = !state.cursorBlinkState;
      state.lastBlinkTime = timestamp;
    }

    if (state.cursorBlinkState) {
      ctx.fillStyle = '#22c55e'; // エメラルドグリーンの点滅ターミナルカーソル
      const cursorW = 10;
      const cursorH = 16;
      ctx.fillRect(centerX - cursorW / 2, centerY - cursorH / 2, cursorW, cursorH);

      // 外枠の小さなグロー効果
      ctx.strokeStyle = 'rgba(34, 197, 94, 0.4)';
      ctx.lineWidth = 2;
      ctx.strokeRect(centerX - cursorW / 2 - 2, centerY - cursorH / 2 - 2, cursorW + 4, cursorH + 4);
    }

    requestAnimationFrame(render);
  }

  // ==========================================
  // 9. 位置情報制御（GPS & 仮想D-Pad）
  // ==========================================
  function handleLocationUpdate(lat, lng) {
    if (state.lastLat !== null && state.lastLng !== null) {
      const d = calculateDistance(state.lastLat, state.lastLng, lat, lng);
      if (d > 0.5) {
        state.totalDistance += d;
        saveMetaToDB('totalDistance', state.totalDistance);
      }
    }
    state.lastLat = lat;
    state.lastLng = lng;
    state.lat = lat;
    state.lng = lng;

    revealTilesAt(lat, lng);
  }

  function startGPS() {
    if (!navigator.geolocation) {
      setGpsStatus('GPS: NOT SUPPORTED', '#ef4444');
      return;
    }

    setGpsStatus('GPS: ACQUIRING...', '#f59e0b');
    state.gpsActive = true;

    state.gpsWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude, accuracy } = pos.coords;
        setGpsStatus(`GPS: ACTIVE (±${Math.round(accuracy)}m)`, '#22c55e');
        handleLocationUpdate(latitude, longitude);
      },
      (err) => {
        setGpsStatus(`GPS: ERROR (${err.code})`, '#ef4444');
      },
      {
        enableHighAccuracy: true,
        maximumAge: 1000,
        timeout: 15000
      }
    );
  }

  function stopGPS() {
    if (state.gpsWatchId !== null) {
      navigator.geolocation.clearWatch(state.gpsWatchId);
      state.gpsWatchId = null;
    }
    state.gpsActive = false;
    setGpsStatus('GPS: OFF', '#737373');
  }

  function setGpsStatus(text, color) {
    const elText = document.getElementById('gpsStatusText');
    const elInd = document.getElementById('gpsIndicator');
    if (elText) elText.textContent = text;
    if (elInd) elInd.style.backgroundColor = color;
  }

  function moveVirtual(dLat, dLng) {
    const step = 0.00015; // 約15m
    const currentLngGrid = getLngGrid(state.lat);
    const nextLat = state.lat + dLat * LAT_GRID;
    const nextLng = state.lng + dLng * currentLngGrid;
    handleLocationUpdate(nextLat, nextLng);
    playBlip(750, 0.02);
  }

  // ==========================================
  // 10. イベントリスナー & 初期化
  // ==========================================
  function setupEvents() {
    window.addEventListener('resize', resizeCanvas);

    // D-Pad ボタン操作
    document.getElementById('btnPadUp')?.addEventListener('click', () => moveVirtual(1, 0));
    document.getElementById('btnPadDown')?.addEventListener('click', () => moveVirtual(-1, 0));
    document.getElementById('btnPadLeft')?.addEventListener('click', () => moveVirtual(0, -1));
    document.getElementById('btnPadRight')?.addEventListener('click', () => moveVirtual(0, 1));
    document.getElementById('btnPadCenter')?.addEventListener('click', () => {
      revealTilesAt(state.lat, state.lng);
      playBlip(1400, 0.04);
    });

    // キーボード操作 (Arrow Keys & WASD)
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W') moveVirtual(1, 0);
      else if (e.key === 'ArrowDown' || e.key === 's' || e.key === 'S') moveVirtual(-1, 0);
      else if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') moveVirtual(0, -1);
      else if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') moveVirtual(0, 1);
      else if (e.key === ' ' || e.key === 'Enter') {
        revealTilesAt(state.lat, state.lng);
      }
    });

    // モード切替ボタン
    const btnToggleMode = document.getElementById('btnToggleMode');
    const modeHintText = document.getElementById('modeHintText');
    btnToggleMode?.addEventListener('click', () => {
      playBlip(880, 0.03);
      if (state.mode === 'gps') {
        state.mode = 'dpad';
        stopGPS();
        btnToggleMode.textContent = 'MODE: D-PAD';
        btnToggleMode.classList.remove('cui-btn-accent');
        if (modeHintText) modeHintText.textContent = '矢印・D-Padで探索テスト中';
      } else {
        state.mode = 'gps';
        startGPS();
        btnToggleMode.textContent = 'MODE: GPS';
        btnToggleMode.classList.add('cui-btn-accent');
        if (modeHintText) modeHintText.textContent = '外を歩くと光が広がります';
      }
    });

    // サウンド切替
    const btnToggleSound = document.getElementById('btnToggleSound');
    btnToggleSound?.addEventListener('click', () => {
      state.soundEnabled = !state.soundEnabled;
      btnToggleSound.textContent = state.soundEnabled ? 'SE: ON' : 'SE: OFF';
      if (state.soundEnabled) playBlip(1100, 0.03);
    });

    // リセンターボタン
    document.getElementById('btnRecenter')?.addEventListener('click', () => {
      playBlip(600, 0.03);
      revealTilesAt(state.lat, state.lng);
    });

    // メニューモーダル
    const menuModal = document.getElementById('menuModal');
    document.getElementById('btnOpenMenu')?.addEventListener('click', () => {
      playBlip(800, 0.03);
      menuModal?.classList.remove('hidden');
      updateUI();
    });
    document.getElementById('btnCloseMenu')?.addEventListener('click', () => {
      menuModal?.classList.add('hidden');
    });
    document.getElementById('btnConfirmClose')?.addEventListener('click', () => {
      menuModal?.classList.add('hidden');
    });

    // データ書き出し (JSON)
    document.getElementById('btnExportData')?.addEventListener('click', () => {
      playBlip(1000, 0.04);
      const data = {
        exportedAt: new Date().toISOString(),
        streak: state.streak,
        totalDistance: state.totalDistance,
        tilesCount: state.tiles.size,
        tiles: Array.from(state.tiles.values())
      };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `fogwalker_export_${getTodayString()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });

    // データ初期化
    document.getElementById('btnResetData')?.addEventListener('click', () => {
      if (confirm('【警告】開拓したすべてのマスデータを初期化しますか？')) {
        if (db) {
          const tx = db.transaction(['tiles', 'meta'], 'readwrite');
          tx.objectStore('tiles').clear();
          tx.objectStore('meta').clear();
          tx.oncomplete = () => {
            state.tiles.clear();
            state.streak = 1;
            state.totalDistance = 0;
            state.lastActiveDate = '';
            revealTilesAt(state.lat, state.lng);
            updateUI();
            alert('データを初期化しました。');
            menuModal?.classList.add('hidden');
          };
        }
      }
    });
  }

  // ==========================================
  // 11. アプリ起動エントリポイント
  // ==========================================
  async function init() {
    state.canvas = document.getElementById('gameCanvas');
    state.ctx = state.canvas.getContext('2d');

    resizeCanvas();
    setupEvents();

    await initDB();
    await loadAllFromDB();

    // 初期マスの展開
    revealTilesAt(state.lat, state.lng);
    updateUI();

    // デフォルトでGPS起動
    startGPS();

    // 描画ループ開始
    requestAnimationFrame(render);
  }

  // ==========================================
  // 12. Service Worker 登録（PWA・オフライン対応）
  // ==========================================
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(err => {
        console.warn('Service Worker registration failed:', err);
      });
    });
  }

  window.addEventListener('DOMContentLoaded', init);
})();
