/**
 * FogWalker v2.1 - コアスクリプト
 * 「歩いた場所だけが、光る。」
 * 黒基調・コマンドプロンプト風 極限ミニマル位置情報PWA
 */

(() => {
  'use strict';

  // ==========================================
  // 1. 定数 & 設定パラメータ
  // ==========================================
  const LAT_GRID = 0.000135; // 1マスの緯度幅（約15m相当）
  const TILE_SQM = 225; // 1マスの面積（15m×15m = 225㎡）
  const CLEAR_RADIUS_TILES = 3; // 霧晴らし半径（マス数、約45m、円内約29マス）
  const TOTAL_EARTH_TILES = 2266958222222; // 地球全表面積（約5.1億km²）/ 225㎡
  const DB_NAME = 'FogWalkerDB_v2';
  const DB_VERSION = 1;

  // カラーテーマ定義
  const THEMES = [
    { id: 'green', name: 'GRN', primary: '#22c55e', glow: 'rgba(34, 197, 94, 0.4)', textClass: 'text-emerald-400' },
    { id: 'amber', name: 'AMB', primary: '#f59e0b', glow: 'rgba(245, 158, 11, 0.4)', textClass: 'text-amber-400' },
    { id: 'cyan', name: 'CYN', primary: '#06b6d4', glow: 'rgba(6, 182, 212, 0.4)', textClass: 'text-cyan-400' },
    { id: 'white', name: 'WHT', primary: '#ffffff', glow: 'rgba(255, 255, 255, 0.4)', textClass: 'text-neutral-200' }
  ];

  // ==========================================
  // 2. 状態管理 (State)
  // ==========================================
  const state = {
    // プレイヤー位置（初期値：大阪周辺）
    lat: 34.6654,
    lng: 135.6268,
    isFirstFix: true,

    // 開拓マス管理 (Map: key -> { id, latIdx, lngIdx, exploredAt })
    tiles: new Map(),
    totalDistance: 0,
    lastLat: null,
    lastLng: null,

    // レベル & ストリーク
    level: 1,
    streak: 1,
    lastActiveDate: '',

    // 動作モード
    mode: 'gps', // 'gps' | 'dpad'
    gpsWatchId: null,
    gpsActive: false,

    // テーマ
    themeIndex: 0,

    // サウンド設定
    soundEnabled: true,
    audioCtx: null,

    // 描画関連
    canvas: null,
    ctx: null,
    width: 0,
    height: 0,
    scale: 28, // 1マスの画面上ピクセルサイズ
    minScale: 12,
    maxScale: 64,
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
  // 4. Web Audio シンセサイザー（クリック音 & ファンファーレ）
  // ==========================================
  function ensureAudioCtx() {
    if (!state.audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) state.audioCtx = new AudioContextClass();
    }
    if (state.audioCtx && state.audioCtx.state === 'suspended') {
      state.audioCtx.resume();
    }
  }

  function playBlip(freq = 980, duration = 0.035) {
    if (!state.soundEnabled) return;
    try {
      ensureAudioCtx();
      if (!state.audioCtx) return;
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

  function playFanfare() {
    if (!state.soundEnabled) return;
    try {
      ensureAudioCtx();
      if (!state.audioCtx) return;
      const notes = [523.25, 659.25, 783.99, 1046.5]; // C5, E5, G5, C6
      notes.forEach((freq, i) => {
        const startTime = state.audioCtx.currentTime + i * 0.09;
        const osc = state.audioCtx.createOscillator();
        const gain = state.audioCtx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, startTime);
        gain.gain.setValueAtTime(0.08, startTime);
        gain.gain.exponentialRampToValueAtTime(0.001, startTime + 0.18);
        osc.connect(gain);
        gain.connect(state.audioCtx.destination);
        osc.start(startTime);
        osc.stop(startTime + 0.18);
      });
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
          applyTheme(state.themeIndex);
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
  // 6. カラーテーマ制御
  // ==========================================
  function applyTheme(index) {
    state.themeIndex = (index + THEMES.length) % THEMES.length;
    const theme = THEMES[state.themeIndex];
    document.documentElement.style.setProperty('--theme-primary', theme.primary);

    // テキスト要素の色変更
    document.querySelectorAll('.theme-accent').forEach((el) => {
      el.style.color = theme.primary;
    });

    const headerBlinker = document.getElementById('headerBlinker');
    if (headerBlinker) headerBlinker.style.backgroundColor = theme.primary;

    const btnTheme = document.getElementById('btnToggleTheme');
    if (btnTheme) btnTheme.textContent = `COLOR: ${theme.name}`;

    try {
      localStorage.setItem('fogwalker_theme', String(state.themeIndex));
    } catch (_) {}
    saveMetaToDB('themeIndex', state.themeIndex);
  }

  // ==========================================
  // 7. 霧晴らし & ストリーク & レベル更新
  // ==========================================
  function revealTilesAt(lat, lng) {
    const center = getTileIndices(lat, lng);
    const now = Date.now();
    const oldTileCount = state.tiles.size;
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
      const newTotal = state.tiles.size;
      const oldLevel = Math.floor(Math.sqrt(oldTileCount / 10)) + 1;
      const newLevel = Math.floor(Math.sqrt(newTotal / 10)) + 1;

      if (newLevel > oldLevel) {
        state.level = newLevel;
        showLevelUpToast(newLevel);
        playFanfare();
      } else {
        playBlip(1200, 0.04);
      }

      updateStreak();
      updateUI();
    }
  }

  function showLevelUpToast(level) {
    const toast = document.getElementById('toastNotification');
    const msg = document.getElementById('toastMessage');
    if (toast && msg) {
      msg.textContent = `LEVEL UP! [LV: ${String(level).padStart(2, '0')}] NEW HORIZON UNLOCKED`;
      toast.classList.remove('hidden');
      toast.classList.add('toast-active');
      setTimeout(() => {
        toast.classList.remove('toast-active');
        toast.classList.add('hidden');
      }, 3300);
    }
  }

  function updateStreak() {
    const today = getTodayString();
    const yesterday = getYesterdayString();

    if (state.lastActiveDate === today) {
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
  // 8. UI表示更新
  // ==========================================
  function updateUI() {
    const tileCount = state.tiles.size;
    const streakDays = state.streak;
    const areaSqm = tileCount * TILE_SQM;

    // ヘッダー
    const elStreak = document.getElementById('statStreak');
    if (elStreak) elStreak.textContent = streakDays;

    const elTiles = document.getElementById('statTiles');
    if (elTiles) elTiles.textContent = tileCount.toLocaleString();

    const level = Math.floor(Math.sqrt(tileCount / 10)) + 1;
    state.level = level;
    const elLevel = document.getElementById('statLevel');
    if (elLevel) elLevel.textContent = `(LV: ${String(level).padStart(2, '0')})`;

    // 全人類地球開拓カウンター
    const pct = (tileCount / TOTAL_EARTH_TILES) * 100;
    const elPct = document.getElementById('statGlobalPct');
    if (elPct) {
      elPct.textContent = `${pct.toFixed(8)}%`;
    }

    const elArea = document.getElementById('statGlobalArea');
    if (elArea) {
      const areaText = areaSqm >= 1000000 ? `${(areaSqm / 1000000).toFixed(2)} km²` : `${areaSqm.toLocaleString()} ㎡`;
      elArea.textContent = `[${areaText} / 2.26T TILES]`;
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
    const modalArea = document.getElementById('modalArea');
    if (modalArea) modalArea.textContent = areaSqm.toLocaleString();
    const modalDist = document.getElementById('modalDistance');
    if (modalDist) modalDist.textContent = Math.round(state.totalDistance).toLocaleString();
    const modalGlobal = document.getElementById('modalGlobal');
    if (modalGlobal) modalGlobal.textContent = `${pct.toFixed(8)}%`;
  }

  // ==========================================
  // 9. Canvas レンダリングエンジン
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
      const currentTheme = THEMES[state.themeIndex];
      ctx.fillStyle = currentTheme.primary;
      const cursorW = Math.max(8, state.scale * 0.4);
      const cursorH = Math.max(14, state.scale * 0.65);
      ctx.fillRect(centerX - cursorW / 2, centerY - cursorH / 2, cursorW, cursorH);

      // 外枠グロー効果
      ctx.strokeStyle = currentTheme.glow;
      ctx.lineWidth = 2;
      ctx.strokeRect(centerX - cursorW / 2 - 2, centerY - cursorH / 2 - 2, cursorW + 4, cursorH + 4);
    }

    requestAnimationFrame(render);
  }

  // ==========================================
  // 10. 軌跡ポスター書き出しエンジン (PNG)
  // ==========================================
  function exportTrajectoryPoster() {
    playBlip(1400, 0.05);

    if (state.tiles.size === 0) {
      alert('開拓したマスがまだありません。少し歩いてから書き出してください。');
      return;
    }

    // 高解像度ポスター用オフスクリーンCanvas（1200x1600、縦長3:4比率）
    const posterCanvas = document.createElement('canvas');
    posterCanvas.width = 1200;
    posterCanvas.height = 1600;
    const pCtx = posterCanvas.getContext('2d');

    // 1. 純黒背景
    pCtx.fillStyle = '#050505';
    pCtx.fillRect(0, 0, 1200, 1600);

    // 2. ミニマルな外枠ライン
    pCtx.strokeStyle = '#262626';
    pCtx.lineWidth = 2;
    pCtx.strokeRect(40, 40, 1120, 1520);

    // 3. 全開拓マスのバウンディングボックスを算出
    let minLatIdx = Infinity,
      maxLatIdx = -Infinity;
    let minLngIdx = Infinity,
      maxLngIdx = -Infinity;

    state.tiles.forEach((t) => {
      if (t.latIdx < minLatIdx) minLatIdx = t.latIdx;
      if (t.latIdx > maxLatIdx) maxLatIdx = t.latIdx;
      if (t.lngIdx < minLngIdx) minLngIdx = t.lngIdx;
      if (t.lngIdx > maxLngIdx) maxLngIdx = t.lngIdx;
    });

    const spanLat = Math.max(5, maxLatIdx - minLatIdx + 1);
    const spanLng = Math.max(5, maxLngIdx - minLngIdx + 1);

    // 描画エリア（中央、幅1000px、高さ1100px）
    const mapAreaW = 1000;
    const mapAreaH = 1100;
    const mapOriginX = 100;
    const mapOriginY = 120;

    const scaleX = mapAreaW / (spanLng + 4);
    const scaleY = mapAreaH / (spanLat + 4);
    const pScale = Math.min(scaleX, scaleY, 40);

    const midLatIdx = (minLatIdx + maxLatIdx) / 2;
    const midLngIdx = (minLngIdx + maxLngIdx) / 2;

    const mapCenterX = mapOriginX + mapAreaW / 2;
    const mapCenterY = mapOriginY + mapAreaH / 2;

    // 4. マス描画（光の軌跡）
    state.tiles.forEach((t) => {
      const px = mapCenterX + (t.lngIdx - midLngIdx) * pScale;
      const py = mapCenterY - (t.latIdx - midLatIdx) * pScale;

      pCtx.fillStyle = '#ffffff';
      pCtx.shadowColor = 'rgba(255, 255, 255, 0.8)';
      pCtx.shadowBlur = 6;
      pCtx.fillRect(px - (pScale - 2) / 2, py - (pScale - 2) / 2, pScale - 2, pScale - 2);
    });

    // シャドウリセット
    pCtx.shadowColor = 'transparent';
    pCtx.shadowBlur = 0;

    // 5. タイポグラフィ & 情報レイアウト（下部）
    const theme = THEMES[state.themeIndex];
    pCtx.font = 'bold 36px "JetBrains Mono", monospace';
    pCtx.fillStyle = '#ffffff';
    pCtx.fillText('FOG WALKER', 80, 1330);

    pCtx.font = '20px "JetBrains Mono", monospace';
    pCtx.fillStyle = theme.primary;
    pCtx.fillText('// TRAJECTORY POSTER', 340, 1330);

    // スローガン
    pCtx.font = 'italic 18px "JetBrains Mono", monospace';
    pCtx.fillStyle = '#a3a3a3';
    pCtx.fillText('"WHERE YOU WALK, LIGHT FOLLOWS."', 80, 1370);

    // 区切り線
    pCtx.strokeStyle = '#262626';
    pCtx.lineWidth = 1;
    pCtx.beginPath();
    pCtx.moveTo(80, 1395);
    pCtx.lineTo(1120, 1395);
    pCtx.stroke();

    // 統計データグリッド
    pCtx.font = '16px "JetBrains Mono", monospace';
    pCtx.fillStyle = '#737373';
    pCtx.fillText('> TILES EXPLORED:', 80, 1435);
    pCtx.fillStyle = '#ffffff';
    pCtx.fillText(`${state.tiles.size.toLocaleString()} TILES (${(state.tiles.size * TILE_SQM).toLocaleString()} ㎡)`, 280, 1435);

    pCtx.fillStyle = '#737373';
    pCtx.fillText('> STREAK & LEVEL:', 80, 1468);
    pCtx.fillStyle = '#ffffff';
    pCtx.fillText(`${state.streak} DAYS (LV.${String(state.level).padStart(2, '0')})`, 280, 1468);

    pCtx.fillStyle = '#737373';
    pCtx.fillText('> COORDINATES:', 80, 1500);
    pCtx.fillStyle = '#ffffff';
    pCtx.fillText(`${state.lat.toFixed(4)}°N, ${state.lng.toFixed(4)}°E`, 280, 1500);

    pCtx.fillStyle = '#737373';
    pCtx.fillText('> DATE ARCHIVED:', 700, 1435);
    pCtx.fillStyle = '#ffffff';
    pCtx.fillText(getTodayString(), 880, 1435);

    pCtx.fillStyle = '#525252';
    pCtx.font = '14px "JetBrains Mono", monospace';
    pCtx.fillText('Created with for お絵描き楽しも委員会（しょうだい）', 700, 1500);

    // 6. 画像ダウンロード実行
    posterCanvas.toBlob((blob) => {
      if (!blob) return;
      downloadBlob(blob, `fogwalker_poster_${getTodayString().replace(/-/g, '')}.png`);
    }, 'image/png');
  }

  // Blob をファイルとしてダウンロードさせる共通処理
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // 即時に revoke するとダウンロードが中断される端末があるため少し待つ
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  }

  // ==========================================
  // 11. 位置情報制御（GPS & 仮想D-Pad）
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
    const currentLngGrid = getLngGrid(state.lat);
    const nextLat = state.lat + dLat * LAT_GRID;
    const nextLng = state.lng + dLng * currentLngGrid;
    handleLocationUpdate(nextLat, nextLng);
    playBlip(750, 0.02);
  }

  // ==========================================
  // 12. イベントリスナー & 初期化
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

    // カラーテーマ切替
    document.getElementById('btnToggleTheme')?.addEventListener('click', () => {
      playBlip(1050, 0.03);
      applyTheme(state.themeIndex + 1);
    });

    // サウンド切替
    const btnToggleSound = document.getElementById('btnToggleSound');
    btnToggleSound?.addEventListener('click', () => {
      state.soundEnabled = !state.soundEnabled;
      btnToggleSound.textContent = state.soundEnabled ? 'SE: ON' : 'SE: OFF';
      if (state.soundEnabled) playBlip(1100, 0.03);
    });

    // ズーム操作
    document.getElementById('btnZoomIn')?.addEventListener('click', () => {
      playBlip(950, 0.02);
      state.scale = Math.min(state.maxScale, state.scale + 4);
    });
    document.getElementById('btnZoomOut')?.addEventListener('click', () => {
      playBlip(850, 0.02);
      state.scale = Math.max(state.minScale, state.scale - 4);
    });

    // リセンターボタン
    document.getElementById('btnRecenter')?.addEventListener('click', () => {
      playBlip(600, 0.03);
      revealTilesAt(state.lat, state.lng);
    });

    // ポスター画像書き出し
    document.getElementById('btnExportPoster')?.addEventListener('click', exportTrajectoryPoster);
    document.getElementById('btnModalExportPoster')?.addEventListener('click', () => {
      exportTrajectoryPoster();
      document.getElementById('menuModal')?.classList.add('hidden');
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
      downloadBlob(blob, `fogwalker_export_${getTodayString().replace(/-/g, '')}.json`);
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
  // 13. アプリ起動エントリポイント
  // ==========================================
  async function init() {
    state.canvas = document.getElementById('gameCanvas');
    state.ctx = state.canvas.getContext('2d');

    resizeCanvas();
    setupEvents();

    // 保存済みテーマを即時適用（IndexedDBより先に読める軽量な localStorage を優先）
    let savedTheme = NaN;
    try {
      savedTheme = parseInt(localStorage.getItem('fogwalker_theme') || '', 10);
    } catch (_) {}
    if (!Number.isNaN(savedTheme)) state.themeIndex = savedTheme;
    applyTheme(state.themeIndex);

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

  window.addEventListener('DOMContentLoaded', init);

  // Service Worker 登録
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch((err) => {
        console.warn('ServiceWorker registration failed: ', err);
      });
    });
  }
})();
