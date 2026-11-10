/**
 * FogWalker (フォグウォーカー) - コアスクリプト
 * レトロRPG風 リアル街歩きマッピング PWA
 */

(() => {
  'use strict';

  // ==========================================
  // 1. 定数 & 設定パラメータ
  // ==========================================
  const GRID_SIZE_DEG = 0.000135; // 1マスのサイズ: 緯度・経度で約15m相当
  const CLEAR_RADIUS = 3;         // プレイヤー周辺の霧晴らし半径（マス数: 直径約90m）
  const TILE_PX = 24;             // 1マスの描画ピクセルサイズ（基準）
  
  // 地形タイプ
  const TILE_TYPE = {
    FOG: 'FOG',
    PLAINS: 'PLAINS',
    ROAD: 'ROAD',
    WATER: 'WATER',
    BRIDGE: 'BRIDGE',
    SPOT: 'SPOT'
  };

  // スポット種別
  const SPOT_ICONS = {
    station: { emoji: '🏠', name: '旅人の宿（駅）', type: '駅' },
    park: { emoji: '🌳', name: '憩いの森（公園）', type: '公園' },
    shrine: { emoji: '⛩️', name: '古代の祠（寺社）', type: '寺社' },
    castle: { emoji: '🏰', name: '王都の砦（公共機関）', type: '役所・学校' },
    cafe: { emoji: '☕', name: 'やすらぎの酒場（カフェ）', type: 'カフェ・飲食' }
  };

  // 称号リスト
  const TITLES = [
    { minTiles: 0, title: '見習い冒険者', rank: 'ビギナー' },
    { minTiles: 30, title: '駆け出しの旅人', rank: 'ブロンズ' },
    { minTiles: 100, title: '路地裏の探索者', rank: 'シルバー' },
    { minTiles: 250, title: '街の測量士', rank: 'ゴールド' },
    { minTiles: 600, title: '百戦錬磨の地図職人', rank: 'マスター' },
    { minTiles: 1500, title: '伝説のワンダラー', rank: 'レジェンド' }
  ];

  // ==========================================
  // 2. 状態管理 (State)
  // ==========================================
  const state = {
    // プレイヤー位置情報
    lat: 34.6654, // 初期値（東大阪・近鉄奈良線周辺）
    lng: 135.6268,
    gridX: 0,
    gridY: 0,
    heading: 'down', // 'up', 'down', 'left', 'right'
    walkFrame: 0,
    isMoving: false,

    // 探索記録
    exploredTiles: new Map(), // key: "x,y" => { timestamp, count }
    discoveredSpots: new Map(), // key: "spotId" => spotData
    featureCache: new Map(), // key: "x,y" => tileType
    
    // 統計
    totalDistance: 0,
    lastLat: null,
    lastLng: null,

    // 動作モード
    mode: 'gps', // 'gps' または 'virtual'
    gpsActive: false,
    watchId: null,

    // 描画関連
    canvas: null,
    ctx: null,
    width: 0,
    height: 0,
    viewTilesX: 19,
    viewTilesY: 25,
    pixelRatio: window.devicePixelRatio || 1
  };

  // ==========================================
  // 3. IndexedDB 永続化ストレージ
  // ==========================================
  const DB_NAME = 'FogWalkerDB';
  const DB_VERSION = 1;
  let dbInstance = null;

  function initIndexedDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onerror = () => {
        console.warn('IndexedDB opened failed, using memory storage.');
        resolve(null);
      };
      request.onsuccess = (e) => {
        dbInstance = e.target.result;
        resolve(dbInstance);
      };
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('explored_tiles')) {
          db.createObjectStore('explored_tiles', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('discovered_landmarks')) {
          db.createObjectStore('discovered_landmarks', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('user_stats')) {
          db.createObjectStore('user_stats', { keyPath: 'id' });
        }
      };
    });
  }

  async function loadPersistedData() {
    if (!dbInstance) return;
    try {
      const tx = dbInstance.transaction(['explored_tiles', 'discovered_landmarks', 'user_stats'], 'readonly');
      
      // 開拓タイル読込
      const tilesStore = tx.objectStore('explored_tiles');
      const tilesReq = tilesStore.getAll();
      tilesReq.onsuccess = () => {
        (tilesReq.result || []).forEach(item => {
          state.exploredTiles.set(item.key, item);
        });
        updateStatsUI();
        requestRender();
      };

      // 発見スポット読込
      const spotsStore = tx.objectStore('discovered_landmarks');
      const spotsReq = spotsStore.getAll();
      spotsReq.onsuccess = () => {
        (spotsReq.result || []).forEach(spot => {
          state.discoveredSpots.set(spot.id, spot);
        });
        renderSpotsList();
      };

      // ユーザー統計読込
      const statsStore = tx.objectStore('user_stats');
      const statsReq = statsStore.get('profile');
      statsReq.onsuccess = () => {
        if (statsReq.result) {
          state.totalDistance = statsReq.result.totalDistance || 0;
          updateStatsUI();
        }
      };
    } catch (err) {
      console.warn('Failed to load persisted data:', err);
    }
  }

  function saveTileToDB(key, data) {
    if (!dbInstance) return;
    try {
      const tx = dbInstance.transaction('explored_tiles', 'readwrite');
      tx.objectStore('explored_tiles').put({ key, ...data });
    } catch (e) {}
  }

  function saveSpotToDB(spot) {
    if (!dbInstance) return;
    try {
      const tx = dbInstance.transaction('discovered_landmarks', 'readwrite');
      tx.objectStore('discovered_landmarks').put(spot);
    } catch (e) {}
  }

  function saveStatsToDB() {
    if (!dbInstance) return;
    try {
      const tx = dbInstance.transaction('user_stats', 'readwrite');
      tx.objectStore('user_stats').put({
        id: 'profile',
        totalDistance: state.totalDistance,
        totalTiles: state.exploredTiles.size,
        updatedAt: Date.now()
      });
    } catch (e) {}
  }

  // ==========================================
  // 4. 座標計算 & 測位ロジック
  // ==========================================
  function latLngToGrid(lat, lng) {
    const rad = (lat * Math.PI) / 180;
    const gridY = Math.floor(lat / GRID_SIZE_DEG);
    const gridX = Math.floor((lng * Math.cos(rad)) / GRID_SIZE_DEG);
    return { x: gridX, y: gridY };
  }

  function gridToLatLng(gx, gy) {
    const lat = (gy + 0.5) * GRID_SIZE_DEG;
    const rad = (lat * Math.PI) / 180;
    const lng = ((gx + 0.5) * GRID_SIZE_DEG) / Math.cos(rad);
    return { lat, lng };
  }

  function getGridKey(x, y) {
    return `${x},${y}`;
  }

  // 2点間の距離 (メートル)
  function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // 地球半径(m)
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const Δφ = ((lat2 - lat1) * Math.PI) / 180;
    const Δλ = ((lon2 - lon1) * Math.PI) / 180;

    const a =
      Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
      Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  // ==========================================
  // 5. 地形・地物生成 (Overpass API + プロシージャル)
  // ==========================================
  // 決定論的疑似ランダム（座標から同一の地形を再現）
  function pseudoRandom(x, y) {
    const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
    return n - Math.floor(n);
  }

  // グリッド座標における地形タイプを取得（キャッシュまたは疑似生成）
  function getTileFeature(gx, gy) {
    const key = getGridKey(gx, gy);
    if (state.featureCache.has(key)) {
      return state.featureCache.get(key);
    }

    // 決定論的な地形生成（川、道路、橋、草原、スポット）
    // 1. 川（約40マスおきにゆるやかな蛇行ライン）
    const riverX = Math.floor(Math.sin(gy * 0.1) * 3) + Math.floor(gy / 20) * 15 + 8;
    const isWater = (gx % 45 === (riverX % 45));

    // 2. 道路（10マスおき・6マスおきの格子状路地）
    const isMainRoad = (gy % 10 === 0) || (gx % 12 === 0);
    const isSubRoad = (gy % 4 === 0) && (pseudoRandom(gx, gy) > 0.4);
    const isRoad = isMainRoad || isSubRoad;

    let type = TILE_TYPE.PLAINS;

    if (isWater && isRoad) {
      type = TILE_TYPE.BRIDGE; // 道と川が交差するマスは自動的に「橋」
    } else if (isWater) {
      type = TILE_TYPE.WATER;
    } else if (isRoad) {
      type = TILE_TYPE.ROAD;
    } else {
      // 稀にスポットを配置
      const spotChance = pseudoRandom(gx, gy);
      if (spotChance > 0.985) {
        type = TILE_TYPE.SPOT;
      } else {
        type = TILE_TYPE.PLAINS;
      }
    }

    state.featureCache.set(key, type);
    return type;
  }

  // スポット情報を取得
  function getSpotInfo(gx, gy) {
    const rand = pseudoRandom(gx + 100, gy + 200);
    const coords = gridToLatLng(gx, gy);
    if (rand < 0.25) {
      return { id: `spot_${gx}_${gy}`, category: 'park', ...SPOT_ICONS.park, lat: coords.lat, lng: coords.lng };
    } else if (rand < 0.5) {
      return { id: `spot_${gx}_${gy}`, category: 'cafe', ...SPOT_ICONS.cafe, lat: coords.lat, lng: coords.lng };
    } else if (rand < 0.75) {
      return { id: `spot_${gx}_${gy}`, category: 'shrine', ...SPOT_ICONS.shrine, lat: coords.lat, lng: coords.lng };
    } else if (rand < 0.9) {
      return { id: `spot_${gx}_${gy}`, category: 'station', ...SPOT_ICONS.station, lat: coords.lat, lng: coords.lng };
    } else {
      return { id: `spot_${gx}_${gy}`, category: 'castle', ...SPOT_ICONS.castle, lat: coords.lat, lng: coords.lng };
    }
  }

  // ==========================================
  // 6. 霧晴らし & プレイヤー移動
  // ==========================================
  function clearFogAround(curX, curY) {
    let newlyCleared = 0;
    const now = Date.now();

    for (let dy = -CLEAR_RADIUS; dy <= CLEAR_RADIUS; dy++) {
      for (let dx = -CLEAR_RADIUS; dx <= CLEAR_RADIUS; dx++) {
        // 円形に晴らす
        if (dx * dx + dy * dy <= CLEAR_RADIUS * CLEAR_RADIUS) {
          const gx = curX + dx;
          const gy = curY + dy;
          const key = getGridKey(gx, gy);

          if (!state.exploredTiles.has(key)) {
            const tileData = { timestamp: now, count: 1 };
            state.exploredTiles.set(key, tileData);
            saveTileToDB(key, tileData);
            newlyCleared++;

            // 新規マスがSPOTなら図鑑登録 & トースト通知
            const feature = getTileFeature(gx, gy);
            if (feature === TILE_TYPE.SPOT) {
              const spot = getSpotInfo(gx, gy);
              if (!state.discoveredSpots.has(spot.id)) {
                state.discoveredSpots.set(spot.id, spot);
                saveSpotToDB(spot);
                showDiscoveryToast(spot);
                renderSpotsList();
              }
            }
          } else {
            // 踏破回数加算
            const item = state.exploredTiles.get(key);
            item.count = (item.count || 1) + 1;
          }
        }
      }
    }

    if (newlyCleared > 0) {
      updateStatsUI();
      saveStatsToDB();
    }
  }

  function updatePlayerPosition(lat, lng, headingHint = null) {
    if (state.lastLat !== null && state.lastLng !== null) {
      const dist = calculateDistance(state.lastLat, state.lastLng, lat, lng);
      // GPSの異常値（100m以上の急激なワープ）を除外
      if (dist < 100) {
        state.totalDistance += Math.round(dist);
      }
    }

    state.lastLat = lat;
    state.lastLng = lng;
    state.lat = lat;
    state.lng = lng;

    const newGrid = latLngToGrid(lat, lng);

    if (headingHint) {
      state.heading = headingHint;
    } else if (newGrid.x !== state.gridX || newGrid.y !== state.gridY) {
      if (Math.abs(newGrid.x - state.gridX) > Math.abs(newGrid.y - state.gridY)) {
        state.heading = newGrid.x > state.gridX ? 'right' : 'left';
      } else {
        state.heading = newGrid.y > state.gridY ? 'up' : 'down';
      }
    }

    state.gridX = newGrid.x;
    state.gridY = newGrid.y;
    state.walkFrame = (state.walkFrame + 1) % 2;

    // 霧を晴らす
    clearFogAround(state.gridX, state.gridY);

    // 座標表示更新
    const coordsEl = document.getElementById('playerCoords');
    if (coordsEl) {
      coordsEl.textContent = `${lat.toFixed(4)}, ${lng.toFixed(4)} (X:${state.gridX}, Y:${state.gridY})`;
    }

    requestRender();
  }

  // ==========================================
  // 7. Canvas 2D レトロマップ描画
  // ==========================================
  let renderRequested = false;

  function requestRender() {
    if (!renderRequested) {
      renderRequested = true;
      requestAnimationFrame(render);
    }
  }

  function render() {
    renderRequested = false;
    const ctx = state.ctx;
    if (!ctx) return;

    const w = state.width;
    const h = state.height;

    // 背景クリア（深闇の黒）
    ctx.fillStyle = '#0f141c';
    ctx.fillRect(0, 0, w, h);

    const centerX = w / 2;
    const centerY = h / 2;
    const tileSize = TILE_PX;

    const halfTilesX = Math.ceil(w / (2 * tileSize)) + 1;
    const halfTilesY = Math.ceil(h / (2 * tileSize)) + 1;

    // 各グリッドタイルの描画
    for (let vy = -halfTilesY; vy <= halfTilesY; vy++) {
      for (let vx = -halfTilesX; vx <= halfTilesX; vx++) {
        const gx = state.gridX + vx;
        const gy = state.gridY + vy;
        const key = getGridKey(gx, gy);

        const screenX = Math.round(centerX + vx * tileSize - tileSize / 2);
        const screenY = Math.round(centerY - vy * tileSize - tileSize / 2); // Y軸反転（北が上）

        const isExplored = state.exploredTiles.has(key);

        if (!isExplored) {
          // 未探索: 濃霧タイル
          drawFogTile(ctx, screenX, screenY, tileSize, gx, gy);
        } else {
          // 探索済み: 地形タイル
          const feature = getTileFeature(gx, gy);
          drawFeatureTile(ctx, screenX, screenY, tileSize, feature, gx, gy);
        }
      }
    }

    // 画面中央に自機キャラクターを描画
    drawPlayerSprite(ctx, centerX, centerY, tileSize);
  }

  // 濃霧タイル描画
  function drawFogTile(ctx, x, y, size, gx, gy) {
    ctx.fillStyle = '#1a202c';
    ctx.fillRect(x, y, size, size);

    // うっすらグリッド目地
    ctx.strokeStyle = '#232b38';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);

    // 霧のモヤドット
    if (pseudoRandom(gx, gy) > 0.7) {
      ctx.fillStyle = '#2d3748';
      ctx.fillRect(x + 4, y + 4, 3, 3);
      ctx.fillRect(x + size - 7, y + size - 7, 3, 3);
    }
  }

  // 地形タイル描画
  function drawFeatureTile(ctx, x, y, size, feature, gx, gy) {
    switch (feature) {
      case TILE_TYPE.PLAINS:
        // 平地 / 草原
        ctx.fillStyle = '#38a169';
        ctx.fillRect(x, y, size, size);

        // 草のドット
        ctx.fillStyle = '#2f855a';
        if (pseudoRandom(gx, gy) > 0.5) {
          ctx.fillRect(x + 5, y + 6, 2, 4);
          ctx.fillRect(x + 7, y + 4, 2, 6);
        }
        if (pseudoRandom(gx + 1, gy + 1) > 0.6) {
          ctx.fillRect(x + size - 7, y + size - 8, 2, 4);
        }
        break;

      case TILE_TYPE.ROAD:
        // 道路（土色・レンガ調）
        ctx.fillStyle = '#d69e2e';
        ctx.fillRect(x, y, size, size);

        // 舗装のテクスチャ
        ctx.fillStyle = '#b7791f';
        ctx.fillRect(x, y + size - 2, size, 2);
        ctx.fillRect(x + size - 2, y, 2, size);
        ctx.fillStyle = '#ecc94b';
        ctx.fillRect(x + 4, y + 4, 3, 2);
        break;

      case TILE_TYPE.WATER:
        // 水面・河川
        ctx.fillStyle = '#3182ce';
        ctx.fillRect(x, y, size, size);

        // 白い波ドット
        ctx.fillStyle = '#63b3ed';
        ctx.fillRect(x + 4, y + 6, 6, 2);
        ctx.fillRect(x + size - 10, y + size - 8, 6, 2);
        break;

      case TILE_TYPE.BRIDGE:
        // 橋（川の上に木造の橋脚）
        ctx.fillStyle = '#3182ce';
        ctx.fillRect(x, y, size, size); // 下地は水

        // 丸太・木製板
        ctx.fillStyle = '#8c531b';
        ctx.fillRect(x + 2, y, size - 4, size);

        // 欄干（木のヘリ）
        ctx.fillStyle = '#5c330a';
        ctx.fillRect(x + 2, y, 2, size);
        ctx.fillRect(x + size - 4, y, 2, size);

        // 板の筋
        ctx.fillStyle = '#b7791f';
        for (let i = 3; i < size; i += 6) {
          ctx.fillRect(x + 4, y + i, size - 8, 1);
        }
        break;

      case TILE_TYPE.SPOT:
        // スポット（平地の上にアイコン）
        ctx.fillStyle = '#38a169';
        ctx.fillRect(x, y, size, size);

        const spot = getSpotInfo(gx, gy);
        ctx.font = '14px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(spot.emoji, x + size / 2, y + size / 2);
        break;
    }

    // グリッド境界線（探索済みの光沢）
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);
  }

  // ドット絵勇者スプライト描画
  function drawPlayerSprite(ctx, cx, cy, size) {
    const s = 16; // 16x16 ドット
    const scale = 1.5;
    const px = cx - (s * scale) / 2;
    const py = cy - (s * scale) / 2;

    ctx.save();
    ctx.translate(px, py);
    ctx.scale(scale, scale);

    const frame = state.walkFrame;
    const head = state.heading;

    // 影
    ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
    ctx.beginPath();
    ctx.ellipse(8, 15, 6, 2.5, 0, 0, Math.PI * 2);
    ctx.fill();

    // 体・服（青いマント/鎧）
    ctx.fillStyle = '#3182ce';
    ctx.fillRect(5, 7, 6, 6);

    // ベルト
    ctx.fillStyle = '#d69e2e';
    ctx.fillRect(5, 11, 6, 1);

    // 頭（肌色）
    ctx.fillStyle = '#fbd38d';
    ctx.fillRect(5, 3, 6, 4);

    // 髪 / ヘルメット（茶色）
    ctx.fillStyle = '#744210';
    ctx.fillRect(4, 2, 8, 2);
    ctx.fillRect(4, 3, 2, 3);

    // 目（向きによる）
    ctx.fillStyle = '#1a202c';
    if (head === 'down') {
      ctx.fillRect(6, 5, 1, 1);
      ctx.fillRect(9, 5, 1, 1);
    } else if (head === 'up') {
      // 後頭部
      ctx.fillStyle = '#744210';
      ctx.fillRect(5, 3, 6, 4);
    } else if (head === 'left') {
      ctx.fillRect(5, 5, 1, 1);
    } else if (head === 'right') {
      ctx.fillRect(10, 5, 1, 1);
    }

    // 手足（アニメーション）
    ctx.fillStyle = '#c53030'; // 赤いブーツ
    if (frame === 0) {
      ctx.fillRect(5, 13, 2, 2);
      ctx.fillRect(9, 13, 2, 2);
    } else {
      ctx.fillRect(4, 13, 2, 2);
      ctx.fillRect(10, 13, 2, 2);
    }

    // 剣（背中または右脇）
    ctx.fillStyle = '#e2e8f0';
    if (head === 'right') {
      ctx.fillRect(11, 7, 4, 1);
    } else if (head === 'left') {
      ctx.fillRect(1, 7, 4, 1);
    } else {
      ctx.fillRect(11, 6, 1, 6);
    }

    ctx.restore();
  }

  // ==========================================
  // 8. GPS 測位監視
  // ==========================================
  function startGPSWatch() {
    if (!('geolocation' in navigator)) {
      setGPSBadge('GPS非対応', 'bg-rose-500');
      return;
    }

    setGPSBadge('GPS測位中...', 'bg-amber-400 animate-ping');

    state.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude, accuracy } = pos.coords;

        // 精度が60mより悪い場合は誤差として除外
        if (accuracy > 60) {
          setGPSBadge(`GPS精度低 (${Math.round(accuracy)}m)`, 'bg-amber-500');
          return;
        }

        state.gpsActive = true;
        setGPSBadge(`GPS測位中 (精度±${Math.round(accuracy)}m)`, 'bg-emerald-400');

        if (state.mode === 'gps') {
          updatePlayerPosition(latitude, longitude);
        }
      },
      (err) => {
        console.warn('Geolocation error:', err);
        setGPSBadge('GPS停止中（仮想モード利用可）', 'bg-rose-400');
      },
      {
        enableHighAccuracy: true,
        maximumAge: 3000,
        timeout: 10000
      }
    );
  }

  function setGPSBadge(text, indicatorClass) {
    const textEl = document.getElementById('gpsStatusText');
    const dotEl = document.getElementById('gpsIndicator');
    if (textEl) textEl.textContent = text;
    if (dotEl) dotEl.className = `inline-block w-2 h-2 rounded-full ${indicatorClass}`;
  }

  // ==========================================
  // 9. UI / モード管理 / イベント
  // ==========================================
  function updateStatsUI() {
    const totalTiles = state.exploredTiles.size;
    
    // 開拓マス数
    const tilesEl = document.getElementById('statTiles');
    if (tilesEl) tilesEl.innerHTML = `${totalTiles} <span class="text-[9px] text-slate-500">マス</span>`;

    // 踏破距離
    const distEl = document.getElementById('statDistance');
    if (distEl) distEl.innerHTML = `${state.totalDistance} <span class="text-[9px] text-slate-500">m</span>`;

    // レベル & 称号判定
    let currentTitle = TITLES[0];
    for (let i = TITLES.length - 1; i >= 0; i--) {
      if (totalTiles >= TITLES[i].minTiles) {
        currentTitle = TITLES[i];
        break;
      }
    }

    const titleEl = document.getElementById('playerTitle');
    if (titleEl) titleEl.textContent = currentTitle.title;

    const level = Math.floor(Math.sqrt(totalTiles / 5)) + 1;
    const levelEl = document.getElementById('playerLevel');
    if (levelEl) levelEl.textContent = `Lv.${level}`;

    // モーダル内詳細
    const dTiles = document.getElementById('detailTotalTiles');
    if (dTiles) dTiles.textContent = `${totalTiles} マス`;

    const dDist = document.getElementById('detailTotalDistance');
    if (dDist) dDist.textContent = `${state.totalDistance} m`;

    const dSpots = document.getElementById('detailTotalSpots');
    if (dSpots) dSpots.textContent = `${state.discoveredSpots.size} 箇所`;

    const dRank = document.getElementById('detailRank');
    if (dRank) dRank.textContent = currentTitle.rank;
  }

  function showDiscoveryToast(spot) {
    const toast = document.getElementById('discoveryToast');
    const icon = document.getElementById('toastIcon');
    const text = document.getElementById('toastText');
    if (!toast) return;

    icon.textContent = spot.emoji;
    text.textContent = `${spot.name} を発見！`;

    toast.classList.remove('opacity-0', '-translate-y-4');
    toast.classList.add('opacity-100', 'translate-y-0');

    setTimeout(() => {
      toast.classList.remove('opacity-100', 'translate-y-0');
      toast.classList.add('opacity-0', '-translate-y-4');
    }, 3500);
  }

  function renderSpotsList() {
    const listEl = document.getElementById('spotsList');
    if (!listEl) return;

    if (state.discoveredSpots.size === 0) {
      listEl.innerHTML = '<div class="text-center py-8 text-slate-500 text-xs">まだ新しいスポットを発見していません。<br>外を歩いて冒険に出かけよう！</div>';
      return;
    }

    let html = '';
    state.discoveredSpots.forEach(spot => {
      html += `
        <div class="bg-slate-800/80 border border-slate-700 p-2 rounded flex items-center justify-between">
          <div class="flex items-center space-x-2">
            <span class="text-xl">${spot.emoji}</span>
            <div>
              <div class="font-bold text-xs text-amber-300">${spot.name}</div>
              <div class="text-[9px] text-slate-400">種別: ${spot.type}</div>
            </div>
          </div>
          <a href="https://maps.google.com/?q=${spot.lat},${spot.lng}" target="_blank" rel="noopener noreferrer" class="rpg-btn bg-slate-900 border border-slate-600 px-2 py-1 rounded text-[10px] text-sky-400 hover:bg-slate-800">
            Map ↗
          </a>
        </div>
      `;
    });
    listEl.innerHTML = html;
  }

  // 仮想D-Pad移動（室内テスト用）
  function moveVirtual(dx, dy, heading) {
    const newGridX = state.gridX + dx;
    const newGridY = state.gridY + dy;
    const coords = gridToLatLng(newGridX, newGridY);
    updatePlayerPosition(coords.lat, coords.lng, heading);
  }

  // ==========================================
  // 10. 初期化 & イベントリスナー
  // ==========================================
  function resizeCanvas() {
    const canvas = state.canvas;
    if (!canvas) return;
    const rect = canvas.parentElement.getBoundingClientRect();
    state.width = rect.width;
    state.height = rect.height;
    canvas.width = state.width * state.pixelRatio;
    canvas.height = state.height * state.pixelRatio;
    state.ctx.scale(state.pixelRatio, state.pixelRatio);
    requestRender();
  }

  window.addEventListener('DOMContentLoaded', async () => {
    state.canvas = document.getElementById('gameCanvas');
    state.ctx = state.canvas.getContext('2d');

    // Canvasリサイズ
    window.addEventListener('resize', resizeCanvas);
    resizeCanvas();

    // 初期位置の設定
    const initGrid = latLngToGrid(state.lat, state.lng);
    state.gridX = initGrid.x;
    state.gridY = initGrid.y;

    // IndexedDB初期化 & データ復元
    await initIndexedDB();
    await loadPersistedData();

    // 初回の霧晴らし
    clearFogAround(state.gridX, state.gridY);

    // GPS開始
    startGPSWatch();

    // D-Pad イベント
    document.getElementById('btnPadUp')?.addEventListener('click', () => moveVirtual(0, 1, 'up'));
    document.getElementById('btnPadDown')?.addEventListener('click', () => moveVirtual(0, -1, 'down'));
    document.getElementById('btnPadLeft')?.addEventListener('click', () => moveVirtual(-1, 0, 'left'));
    document.getElementById('btnPadRight')?.addEventListener('click', () => moveVirtual(1, 0, 'right'));
    document.getElementById('btnPadCenter')?.addEventListener('click', () => {
      // 周囲3マスを即座に探索
      clearFogAround(state.gridX, state.gridY);
      requestRender();
    });

    // キーボード矢印キーでも操作可能に
    window.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp' || e.key === 'w') moveVirtual(0, 1, 'up');
      if (e.key === 'ArrowDown' || e.key === 's') moveVirtual(0, -1, 'down');
      if (e.key === 'ArrowLeft' || e.key === 'a') moveVirtual(-1, 0, 'left');
      if (e.key === 'ArrowRight' || e.key === 'd') moveVirtual(1, 0, 'right');
    });

    // モード切替ボタン
    document.getElementById('btnToggleMode')?.addEventListener('click', () => {
      if (state.mode === 'gps') {
        state.mode = 'virtual';
        document.getElementById('currentModeLabel').textContent = '仮想パッド操作';
        document.getElementById('currentModeLabel').className = 'font-bold text-amber-400';
        document.getElementById('modeHintText').textContent = 'D-Padまたは矢印キーで移動できます';
      } else {
        state.mode = 'gps';
        document.getElementById('currentModeLabel').textContent = 'リアルGPS連動';
        document.getElementById('currentModeLabel').className = 'font-bold text-emerald-400';
        document.getElementById('modeHintText').textContent = '外を歩くと自動で霧が晴れます';
      }
    });

    // 自機位置リセンター
    document.getElementById('btnRecenter')?.addEventListener('click', () => {
      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          (pos) => updatePlayerPosition(pos.coords.latitude, pos.coords.longitude),
          () => requestRender(),
          { enableHighAccuracy: true }
        );
      } else {
        requestRender();
      }
    });

    // メニューモーダル開閉
    const menuModal = document.getElementById('menuModal');
    document.getElementById('btnOpenMenu')?.addEventListener('click', () => {
      menuModal?.classList.remove('hidden');
    });
    document.getElementById('btnCloseMenu')?.addEventListener('click', () => {
      menuModal?.classList.add('hidden');
    });
    document.getElementById('btnConfirmClose')?.addEventListener('click', () => {
      menuModal?.classList.add('hidden');
    });

    // モーダルタブ切り替え
    const tabSpots = document.getElementById('tabSpots');
    const tabSettings = document.getElementById('tabSettings');
    const tabAbout = document.getElementById('tabAbout');
    const contentSpots = document.getElementById('contentSpots');
    const contentSettings = document.getElementById('contentSettings');
    const contentAbout = document.getElementById('contentAbout');

    function switchTab(activeTab, activeContent) {
      [tabSpots, tabSettings, tabAbout].forEach(t => {
        t.className = 'flex-1 py-2 text-center text-slate-400 border-b-2 border-transparent';
      });
      [contentSpots, contentSettings, contentAbout].forEach(c => c.classList.add('hidden'));

      activeTab.className = 'flex-1 py-2 text-center font-bold text-amber-400 border-b-2 border-amber-400';
      activeContent.classList.remove('hidden');
    }

    tabSpots?.addEventListener('click', () => switchTab(tabSpots, contentSpots));
    tabSettings?.addEventListener('click', () => switchTab(tabSettings, contentSettings));
    tabAbout?.addEventListener('click', () => switchTab(tabAbout, contentAbout));

    // データエクスポート (JSON)
    document.getElementById('btnExportData')?.addEventListener('click', () => {
      const exportObj = {
        exploredCount: state.exploredTiles.size,
        totalDistance: state.totalDistance,
        spots: Array.from(state.discoveredSpots.values()),
        tiles: Array.from(state.exploredTiles.entries()),
        exportedAt: new Date().toISOString()
      };
      const blob = new Blob([JSON.stringify(exportObj, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `fogwalker_backup_${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });

    // データ初期化
    document.getElementById('btnResetData')?.addEventListener('click', () => {
      if (confirm('冒険の記録（開拓マス・発見スポット）を初期化しますか？\n※この操作は取り消せません。')) {
        if (dbInstance) {
          const tx = dbInstance.transaction(['explored_tiles', 'discovered_landmarks', 'user_stats'], 'readwrite');
          tx.objectStore('explored_tiles').clear();
          tx.objectStore('discovered_landmarks').clear();
          tx.objectStore('user_stats').clear();
        }
        state.exploredTiles.clear();
        state.discoveredSpots.clear();
        state.totalDistance = 0;
        clearFogAround(state.gridX, state.gridY);
        updateStatsUI();
        renderSpotsList();
        requestRender();
        alert('データを初期化しました。');
      }
    });

    // Service Worker 登録 (PWA)
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(err => {
        console.warn('SW registration skipped:', err);
      });
    }

    requestRender();
  });

})();
