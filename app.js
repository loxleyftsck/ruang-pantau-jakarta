const officialPortal = 'https://jakcctv.jakarta.go.id/publik';

// Catalog is served as JSON so camera data can be reviewed and updated independently.
let cameras = [];
let cameraCatalogError = '';
const cameraHealth = new Map();

const state = { area: 'Semua', healthFilter: 'all', query: '', selectedId: null, favoritesOnly: false, favorites: readFavorites() };
const cameraList = document.getElementById('cameraList');
const searchInput = document.getElementById('cameraSearch');
const resultCount = document.getElementById('resultCount');
const mapCameraCount = document.getElementById('mapCameraCount');
const playerPanel = document.getElementById('playerPanel');
const playerFrame = document.getElementById('playerFrame');
const playerTitle = document.getElementById('playerTitle');
const playerArea = document.getElementById('playerArea');
const playerStatus = document.getElementById('playerStatus');
const playerStatusDot = document.getElementById('playerStatusDot');
const openSource = document.getElementById('openSource');
const playerTheater = document.getElementById('playerTheater');
const aiEstimateEmpty = document.getElementById('aiEstimateEmpty');
const aiEstimateDemo = document.getElementById('aiEstimateDemo');
const aiEstimateResult = document.getElementById('aiEstimateResult');
let map;
let markerLayer;
let activeHls = null;
let playerStartTimer = null;
let playerStallTimer = null;
let activeVideoCleanup = null;
let playerSession = 0;
let activeCameraId = null;
const markers = new Map();
const trafficEstimatesByCamera = new Map();
let demoTrafficEstimate = null;
let trafficEstimateModel = null;
let trafficEstimateGeneratedAt = null;
let trafficEstimateLoadState = 'pending';
let trafficEstimateHasInvalidRows = false;
let trafficEstimateHasUnknownCamera = false;

const trafficVehicleLabels = { car: 'Mobil', motorcycle: 'Motor', bus: 'Bus', truck: 'Truk' };
const trafficDensityLabels = { low: 'Rendah', medium: 'Sedang', high: 'Tinggi', unrated: 'Belum dikalibrasi' };

const healthLabels = {
  unknown: 'BELUM DIVERIFIKASI',
  connecting: 'MENGHUBUNGKAN',
  live: 'TERPUTAR SESI INI',
  error: 'GAGAL DIMUAT SESI INI'
};

function getCameraHealth(id) {
  return cameraHealth.get(id) || 'unknown';
}

function setCameraHealth(id, health) {
  if (!['unknown', 'connecting', 'live', 'error'].includes(health)) return;
  cameraHealth.set(id, health);
  cameraList.querySelectorAll('.camera-card').forEach((card) => {
    if (card.dataset.cameraId !== id) return;
    const status = card.querySelector('.camera-health');
    if (!status) return;
    status.className = `camera-health health-${health}`;
    status.textContent = healthLabels[health];
    status.setAttribute('aria-label', `Status siaran: ${healthLabels[health]}`);
  });
  renderHealthFilters();
  if (state.healthFilter !== 'all') renderList();
}

function renderHealthFilters() {
  const counts = {
    all: cameras.length,
    live: cameras.filter((camera) => getCameraHealth(camera.id) === 'live').length,
    unknown: cameras.filter((camera) => ['unknown', 'connecting'].includes(getCameraHealth(camera.id))).length,
    error: cameras.filter((camera) => getCameraHealth(camera.id) === 'error').length
  };
  document.querySelectorAll('#healthFilters [data-health]').forEach((button) => {
    const health = button.dataset.health;
    const count = button.querySelector('span');
    if (count) count.textContent = String(counts[health] ?? 0);
    const selected = health === state.healthFilter;
    button.classList.toggle('is-active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
}

async function loadCameraCatalog() {
  try {
    const response = await fetch('./cameras.json', { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const catalog = await response.json();
    const ids = new Set();
    const validCatalog = Array.isArray(catalog) && catalog.length > 0 && catalog.every((camera) => {
      if (!camera || typeof camera.id !== 'string' || !camera.id || ids.has(camera.id) || !camera.name || !camera.view || !camera.area || !camera.district || !camera.provider || !camera.feedType || !Number.isFinite(camera.lat) || !Number.isFinite(camera.lng)) return false;
      let url;
      try { url = new URL(camera.url); } catch { return false; }
      if (url.protocol !== 'https:') return false;
      ids.add(camera.id);
      return true;
    });
    if (!validCatalog) {
      throw new Error('Format katalog tidak valid');
    }
    cameras = catalog;
    cameras.forEach((camera) => cameraHealth.set(camera.id, 'unknown'));
  } catch (error) {
    console.error('Tidak dapat memuat katalog kamera', error);
    cameraCatalogError = window.location.protocol === 'file:'
      ? 'Browser memblokir pemuatan katalog saat halaman dibuka langsung dari file. Jalankan py -m http.server 8000 di folder proyek, lalu buka http://localhost:8000/.'
      : 'Pastikan cameras.json berada di folder yang sama dengan halaman, lalu muat ulang.';
  }
}

function isNonnegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isValidTrafficEstimate(estimate) {
  const interval = estimate?.clip_interval_seconds;
  const counts = estimate?.vehicle_counts_mean_per_frame;
  const density = estimate?.estimated_density;
  return Boolean(
    estimate && typeof estimate.source_id === 'string' && estimate.source_id.trim() &&
    estimate.source_type === 'local-video' &&
    (estimate.camera_id === null || (typeof estimate.camera_id === 'string' && estimate.camera_id.trim())) &&
    typeof estimate.mapping_is_explicit === 'boolean' &&
    isNonnegativeNumber(interval) && interval > 0 &&
    Number.isInteger(estimate.sample_count) && estimate.sample_count > 0 &&
    counts && ['car', 'motorcycle', 'bus', 'truck'].every((key) => isNonnegativeNumber(counts[key])) &&
    (estimate.mean_detection_confidence === null ||
      (isNonnegativeNumber(estimate.mean_detection_confidence) && estimate.mean_detection_confidence <= 1)) &&
    (density === null || ['unrated', 'low', 'medium', 'high'].includes(density)) &&
    ((estimate.camera_id === null && !estimate.mapping_is_explicit) ||
      (typeof estimate.camera_id === 'string' && estimate.mapping_is_explicit && typeof estimate.mapping_provenance === 'string' && estimate.mapping_provenance.trim()))
  );
}

async function loadTrafficEstimates() {
  try {
    const response = await fetch('./ai/traffic-estimates.json', { cache: 'no-cache' });
    if (response.status === 404) {
      trafficEstimateLoadState = 'missing';
      return;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const generatedAt = typeof payload?.generated_at === 'string' ? Date.parse(payload.generated_at) : NaN;
    const model = payload?.model;
    const validInputSize = typeof model?.input_size === 'string' || isNonnegativeNumber(model?.input_size) ||
      (Array.isArray(model?.input_size) && model.input_size.length > 0 && model.input_size.every((dimension) => Number.isInteger(dimension) && dimension > 0));
    const validModel = model && ['name', 'format', 'precision', 'version', 'sha256'].every((key) => typeof model[key] === 'string' && model[key].trim()) &&
      /^[a-f\d]{64}$/i.test(model.sha256) && validInputSize;
    if (payload?.schema_version !== 1 || !Number.isFinite(generatedAt) || !validModel || !Array.isArray(payload.estimates)) {
      throw new Error('Format hasil analisis tidak valid');
    }

    const cameraIds = new Set(cameras.map((camera) => camera.id));
    trafficEstimateModel = model;
    trafficEstimateGeneratedAt = new Date(generatedAt).toISOString();
    trafficEstimateHasInvalidRows = payload.estimates.some((estimate) => !isValidTrafficEstimate(estimate));
    payload.estimates.filter(isValidTrafficEstimate).forEach((estimate) => {
      if (estimate.camera_id === null && estimate.mapping_is_explicit === false) {
        demoTrafficEstimate = estimate;
      } else if (estimate.mapping_is_explicit) {
        if (cameraIds.has(estimate.camera_id)) trafficEstimatesByCamera.set(estimate.camera_id, estimate);
        else trafficEstimateHasUnknownCamera = true;
      }
    });
    trafficEstimateLoadState = 'ready';
  } catch (error) {
    console.info('Hasil analisis AI belum dapat dimuat', error);
    trafficEstimateLoadState = 'unavailable';
  }
}

function formatEstimateNumber(value) {
  return Number(value).toLocaleString('id-ID', { maximumFractionDigits: 2 });
}

function formatEstimateTimestamp(timestamp) {
  return new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta', dateStyle: 'medium', timeStyle: 'short'
  }).format(new Date(timestamp));
}

function formatEstimateAge(timestamp) {
  const elapsed = Date.now() - Date.parse(timestamp);
  if (elapsed < -5 * 60_000) return 'waktu pembuatan berada di masa depan';
  if (elapsed < 60_000) return 'baru saja';
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes} menit lalu`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} jam lalu`;
  const days = Math.floor(hours / 24);
  return `${days} hari lalu`;
}

function renderEstimateCard(estimate, { demo = false } = {}) {
  const observedAt = trafficEstimateGeneratedAt;
  const age = Date.now() - Date.parse(observedAt);
  const isStale = age > 24 * 60 * 60_000 || age < -5 * 60_000;
  const counts = estimate.vehicle_counts_mean_per_frame;
  const total = Object.keys(trafficVehicleLabels).reduce((sum, key) => sum + counts[key], 0);
  const density = estimate.estimated_density ? (trafficDensityLabels[estimate.estimated_density] || 'Belum dikalibrasi') : 'Belum dikalibrasi';
  const modelText = `${trafficEstimateModel.name} ${trafficEstimateModel.version} · ${trafficEstimateModel.format} ${trafficEstimateModel.precision}`;
  const heading = demo ? 'Sampel demo · tidak terkait kamera ini' : 'Sampel offline · pemetaan eksplisit';
  const staleNote = isStale ? '<p class="ai-estimate-warning">Hasil analisis dibuat lebih dari 24 jam lalu atau memiliki waktu pembuatan yang tidak valid; ini bukan kondisi lalu lintas terkini.</p>' : '';
  const mappingNote = !demo && typeof estimate.mapping_provenance === 'string' && estimate.mapping_provenance.trim()
    ? `<p class="ai-estimate-provenance">Pemetaan: ${escapeHtml(estimate.mapping_provenance)}</p>` : '';
  const metricMarkup = Object.entries(trafficVehicleLabels).map(([key, label]) => `
    <div class="ai-estimate-metric"><dt>${label}</dt><dd>${formatEstimateNumber(counts[key])}</dd></div>`).join('');

  return `
    <div class="ai-estimate-result-heading"><span class="ai-estimate-result-label">${heading}</span><span class="ai-estimate-freshness${isStale ? ' is-stale' : ''}">${isStale ? 'KEDALUWARSA' : 'SAMPEL'}</span></div>
    <p class="ai-estimate-timestamp">Dibuat ${escapeHtml(formatEstimateTimestamp(observedAt))} WIB · ${escapeHtml(formatEstimateAge(observedAt))}</p>
    ${staleNote}
    <p class="ai-estimate-context">Sampel ${escapeHtml(estimate.source_id)} · rata-rata deteksi per frame · interval target nominal ${formatEstimateNumber(estimate.clip_interval_seconds)} detik · ${estimate.sample_count} frame</p>
    <dl class="ai-estimate-metrics"><div class="ai-estimate-metric ai-estimate-total"><dt>Total rata-rata</dt><dd>${formatEstimateNumber(total)}</dd></div>${metricMarkup}<div class="ai-estimate-metric ai-estimate-density"><dt>Kepadatan</dt><dd>${escapeHtml(density)}</dd></div></dl>
    <div class="ai-estimate-confidence"><span>Skor deteksi rata-rata · belum terkalibrasi</span><strong>${estimate.mean_detection_confidence === null ? '—' : `${Math.round(estimate.mean_detection_confidence * 100)}%`}</strong></div>
    ${mappingNote}<p class="ai-estimate-model">${escapeHtml(modelText)} · SHA-256 ${escapeHtml(trafficEstimateModel.sha256.slice(0, 12))}…</p>`;
}

function renderTrafficEstimates(cameraId) {
  const mappedEstimate = trafficEstimatesByCamera.get(cameraId);
  const hasMappedEstimate = Boolean(mappedEstimate);
  aiEstimateEmpty.hidden = hasMappedEstimate;
  aiEstimateResult.hidden = !hasMappedEstimate;
  aiEstimateDemo.hidden = !demoTrafficEstimate;

  if (hasMappedEstimate) aiEstimateResult.innerHTML = renderEstimateCard(mappedEstimate);
  if (demoTrafficEstimate) aiEstimateDemo.innerHTML = renderEstimateCard(demoTrafficEstimate, { demo: true });

  if (!hasMappedEstimate) {
    const title = aiEstimateEmpty.querySelector('strong');
    const detail = aiEstimateEmpty.querySelectorAll('span');
    if (trafficEstimateLoadState === 'missing') {
      title.textContent = 'Belum ada file hasil analisis.';
      detail[0].textContent = 'Jalankan worker pada video lokal yang diizinkan untuk membuat hasil sampel. Siaran Bali Tower di atas tidak dianalisis.';
    } else if (trafficEstimateLoadState === 'unavailable') {
      title.textContent = 'Hasil analisis belum bisa dibaca.';
      detail[0].textContent = 'Periksa format file ai/traffic-estimates.json, lalu muat ulang halaman. Siaran Bali Tower di atas tidak dianalisis.';
    } else if (trafficEstimateLoadState === 'ready' && demoTrafficEstimate) {
      title.textContent = 'Belum ada sampel yang dipetakan ke kamera ini.';
      detail[0].textContent = 'Sampel demo di bawah tidak terhubung dengan lokasi atau feed CCTV yang dipilih.';
    } else if (trafficEstimateLoadState === 'ready' && trafficEstimateHasInvalidRows) {
      title.textContent = 'Sebagian hasil analisis tidak sesuai format.';
      detail[0].textContent = 'Periksa hasil worker dan buat ulang file sebelum memakai hasilnya.';
    } else if (trafficEstimateLoadState === 'ready' && trafficEstimateHasUnknownCamera) {
      title.textContent = 'ID kamera pada hasil analisis tidak dikenal.';
      detail[0].textContent = 'Periksa ID yang digunakan worker terhadap katalog kamera; hasil yang tidak cocok tidak ditampilkan.';
    } else if (trafficEstimateLoadState === 'ready') {
      title.textContent = 'Belum ada sampel yang dipetakan ke kamera ini.';
      detail[0].textContent = 'Pemetaan lokasi harus ditetapkan secara eksplisit setelah klip dan kamera diverifikasi.';
    }
  }
}

function readFavorites() {
  try { return new Set(JSON.parse(localStorage.getItem('jakarta-cctv-favorites') || '[]')); }
  catch { return new Set(); }
}

function saveFavorites() {
  try { localStorage.setItem('jakarta-cctv-favorites', JSON.stringify([...state.favorites])); } catch { /* storage can be unavailable in private browsing */ }
}

function cameraIconSvg() {
  return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2 6.5h9l3 3.5-3 3.5H2v-7Z"/><path d="M14 10h4"/></svg>';
}

function visibleCameras() {
  const query = state.query.trim().toLocaleLowerCase('id-ID');
  return cameras.filter((camera) => {
    const matchesArea = state.area === 'Semua' || camera.area === state.area;
    const matchesQuery = !query || `${camera.name} ${camera.area} ${camera.district} ${camera.view}`.toLocaleLowerCase('id-ID').includes(query);
    const matchesFavorite = !state.favoritesOnly || state.favorites.has(camera.id);
    const health = getCameraHealth(camera.id);
    const matchesHealth = state.healthFilter === 'all' || (state.healthFilter === 'live' && health === 'live') || (state.healthFilter === 'unknown' && ['unknown', 'connecting'].includes(health)) || (state.healthFilter === 'error' && health === 'error');
    return matchesArea && matchesQuery && matchesFavorite && matchesHealth;
  });
}

function renderList() {
  const list = visibleCameras();
  resultCount.textContent = `${list.length} lokasi`;
  mapCameraCount.textContent = `${list.length} KAMERA`;
  document.querySelectorAll('.filter-chip').forEach((button) => {
    const count = button.dataset.area === 'Semua' ? cameras.length : cameras.filter((camera) => camera.area === button.dataset.area).length;
    if (button.dataset.area) {
      if (button.dataset.area === 'Semua') button.innerHTML = `Semua <span>${count}</span>`;
      button.classList.toggle('is-active', button.dataset.area === state.area);
    }
  });
  renderHealthFilters();

  if (cameraCatalogError) {
    cameraList.innerHTML = `<div class="no-results catalog-error"><strong>Katalog kamera gagal dimuat</strong><span>${escapeHtml(cameraCatalogError)}</span></div>`;
    mapCameraCount.textContent = '0 KAMERA';
  } else if (!list.length) {
    const message = state.favoritesOnly ? 'Belum ada favorit yang cocok.' : 'Coba kata kunci atau wilayah lain.';
    cameraList.innerHTML = `<div class="no-results"><strong>Tidak ada titik kamera</strong>${message}</div>`;
  } else {
    cameraList.innerHTML = list.map((camera) => {
      const isFavorite = state.favorites.has(camera.id);
      return `
      <div class="camera-card${camera.id === state.selectedId ? ' is-selected' : ''}" data-camera-id="${camera.id}">
        <button class="camera-select" type="button" aria-pressed="${camera.id === state.selectedId}">
          <span class="camera-thumb">${cameraIconSvg()}</span>
          <span class="camera-info"><span class="camera-name">${escapeHtml(camera.name)}</span><span class="camera-sub"><span>${escapeHtml(camera.area)}</span><span class="separator">·</span><span>${escapeHtml(camera.view)}</span></span><span class="camera-health health-${getCameraHealth(camera.id)}" aria-label="Status siaran: ${healthLabels[getCameraHealth(camera.id)]}">${healthLabels[getCameraHealth(camera.id)]}</span></span>
        </button>
        <button class="favorite-camera${isFavorite ? ' is-favorite' : ''}" type="button" aria-label="${isFavorite ? 'Hapus' : 'Tambahkan'} ${escapeHtml(camera.name)} ${isFavorite ? 'dari' : 'ke'} favorit" aria-pressed="${isFavorite}" title="${isFavorite ? 'Hapus dari' : 'Tambahkan ke'} favorit"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 17s-6.4-3.8-7.7-7.4C.5 4.8 6.4 2.1 10 6.4c3.6-4.3 9.5-1.6 7.7 3.2C16.4 13.2 10 17 10 17Z"/></svg></button>
      </div>`;
    }).join('');
    cameraList.querySelectorAll('.camera-card').forEach((card) => {
      card.querySelector('.camera-select').addEventListener('click', () => selectCamera(card.dataset.cameraId));
      card.querySelector('.favorite-camera').addEventListener('click', () => toggleFavorite(card.dataset.cameraId));
    });
  }
  updateMarkers(list);
  const selectedCamera = cameras.find((camera) => camera.id === state.selectedId);
  const selectedMatchesOtherFilters = selectedCamera && (state.area === 'Semua' || selectedCamera.area === state.area) && (!state.query.trim() || `${selectedCamera.name} ${selectedCamera.area} ${selectedCamera.district} ${selectedCamera.view}`.toLocaleLowerCase('id-ID').includes(state.query.trim().toLocaleLowerCase('id-ID'))) && (!state.favoritesOnly || state.favorites.has(selectedCamera.id));
  if (state.selectedId && !list.some((camera) => camera.id === state.selectedId) && (!selectedMatchesOtherFilters || state.healthFilter === 'all')) {
    state.selectedId = null;
    if (activeCameraId && getCameraHealth(activeCameraId) === 'connecting') setCameraHealth(activeCameraId, 'unknown');
    stopActivePlayer();
    activeCameraId = null;
    playerPanel.hidden = true;
    playerFrame.innerHTML = '';
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

function createMarkerIcon(camera, selected = false) {
  return L.divIcon({
    className: 'camera-div-icon',
    html: `<span class="camera-marker${selected ? ' is-selected' : ''}">${cameraIconSvg()}</span>`,
    iconSize: selected ? [35, 35] : [30, 30],
    iconAnchor: selected ? [18, 31] : [15, 27]
  });
}

function initializeMap() {
  const mapElement = document.getElementById('map');
  if (!window.L || !window.maplibregl || !L.maplibreGL) {
    mapElement.innerHTML = '<div class="map-fallback"><strong>Peta belum dapat dimuat</strong><span>Periksa koneksi internet lalu buka ulang halaman.</span><a href="https://jakcctv.jakarta.go.id/publik" target="_blank" rel="noreferrer">Buka portal CCTV Jakarta ↗</a></div>';
    return;
  }
  map = L.map(mapElement, { zoomControl: false, scrollWheelZoom: true, preferCanvas: true }).setView([-6.2028, 106.8175], 12.1);
  L.maplibreGL({
    style: 'https://tiles.openfreemap.org/styles/positron'
  }).addTo(map);
  markerLayer = L.layerGroup().addTo(map);
  cameras.forEach((camera) => {
    const marker = L.marker([camera.lat, camera.lng], { icon: createMarkerIcon(camera) });
    marker.bindTooltip(`${camera.name} · ${camera.view}`, { direction: 'top', offset: [0, -18], opacity: .94 });
    marker.on('click', () => selectCamera(camera.id, { keepMapCenter: true }));
    markers.set(camera.id, marker);
  });
  updateMarkers(cameras);
}

function updateMarkers(list) {
  if (!markerLayer) return;
  markerLayer.clearLayers();
  list.forEach((camera) => {
    const marker = markers.get(camera.id);
    if (!marker) return;
    marker.setIcon(createMarkerIcon(camera, camera.id === state.selectedId));
    marker.addTo(markerLayer);
  });
}

function selectCamera(id, options = {}) {
  const camera = cameras.find((item) => item.id === id);
  if (!camera) return;
  state.selectedId = id;
  renderList();
  if (map && !options.keepMapCenter) map.flyTo([camera.lat, camera.lng], Math.max(map.getZoom(), 14), { duration: .55 });
  if (map && options.keepMapCenter) map.panTo([camera.lat, camera.lng], { animate: true, duration: .35 });
  showPlayer(camera);
}

function getFeedUrl(camera) {
  const url = new URL(camera.url);
  if (camera.provider === 'Bali Tower' && camera.feedType === 'hls-derived' && url.hostname === 'cctv.balitower.co.id' && !url.searchParams.has('proto')) url.searchParams.set('proto', 'hls');
  return url.toString();
}

function getHlsUrl(camera) {
  const url = new URL(camera.url);
  if (camera.provider !== 'Bali Tower' || camera.feedType !== 'hls-derived' || url.hostname !== 'cctv.balitower.co.id') return null;
  url.pathname = url.pathname.replace(/\/embed\.html$/, '/index.fmp4.m3u8');
  url.search = '';
  url.hash = '';
  return url.toString();
}

function stopActivePlayer() {
  playerSession += 1;
  window.clearTimeout(playerStartTimer);
  playerStartTimer = null;
  window.clearTimeout(playerStallTimer);
  playerStallTimer = null;
  if (activeHls) {
    activeHls.destroy();
    activeHls = null;
  }
  if (activeVideoCleanup) {
    activeVideoCleanup();
    activeVideoCleanup = null;
  }
}

function setPlayerStatus(text, mode = 'unknown') {
  playerStatus.textContent = text;
  playerStatusDot.className = `unknown-dot${mode === 'live' ? ' is-verified' : mode === 'error' ? ' is-unavailable' : ''}`;
}

function showPlayerMessage(text, isError = false) {
  const message = document.getElementById('playerFeedback');
  if (!message) return;
  message.hidden = false;
  message.classList.toggle('is-error', isError);
  message.querySelector('span:last-child').textContent = text;
}

function hidePlayerMessage() {
  const message = document.getElementById('playerFeedback');
  if (message) message.hidden = true;
}

function startHlsPlayer(camera, streamUrl) {
  const video = document.getElementById('cameraVideo');
  if (!video) return;
  const session = ++playerSession;
  const isCurrentSession = () => session === playerSession;
  let hasPlayed = false;

  const failPlayer = (message, status = 'SIARAN TIDAK TERSEDIA') => {
    if (!isCurrentSession()) return;
    stopActivePlayer();
    setCameraHealth(camera.id, 'error');
    setPlayerStatus(status, 'error');
    showPlayerMessage(message, true);
  };

  const onPlaying = () => {
    if (!isCurrentSession()) return;
    hasPlayed = true;
    window.clearTimeout(playerStartTimer);
    playerStartTimer = null;
    window.clearTimeout(playerStallTimer);
    playerStallTimer = null;
    setCameraHealth(camera.id, 'live');
    setPlayerStatus('LIVE · TERHUBUNG', 'live');
    hidePlayerMessage();
  };
  const onWaiting = (event) => {
    if (!isCurrentSession()) return;
    if (hasPlayed || video.currentTime > 0) {
      setCameraHealth(camera.id, 'connecting');
      setPlayerStatus('LIVE · BUFFERING');
      window.clearTimeout(playerStallTimer);
      playerStallTimer = window.setTimeout(() => {
        failPlayer('Siaran berhenti menerima gambar. Coba buka sumber langsung atau pilih kamera lain.', 'SIARAN TERPUTUS');
      }, 20_000);
    } else {
      setCameraHealth(camera.id, 'connecting');
      setPlayerStatus('MENGHUBUNGKAN SIARAN', 'connecting');
      showPlayerMessage('Menghubungkan ke siaran langsung…');
    }
  };
  const onError = () => {
    failPlayer(`Feed ${camera.name} tidak merespons. Coba buka sumber langsung.`);
  };
  const promptPlayback = () => {
    if (!isCurrentSession()) return;
    setCameraHealth(camera.id, 'unknown');
    setPlayerStatus('STATUS SIARAN BELUM DIVERIFIKASI', 'unknown');
    showPlayerMessage('Siaran siap, tetapi belum mulai diputar. Tekan tombol putar.');
  };
  video.addEventListener('playing', onPlaying);
  video.addEventListener('waiting', onWaiting);
  video.addEventListener('stalled', onWaiting);
  video.addEventListener('error', onError);
  activeVideoCleanup = () => {
    video.removeEventListener('playing', onPlaying);
    video.removeEventListener('waiting', onWaiting);
    video.removeEventListener('stalled', onWaiting);
    video.removeEventListener('error', onError);
    video.pause();
    video.removeAttribute('src');
    video.load();
  };
  playerStartTimer = window.setTimeout(() => {
    playerStartTimer = null;
    if (!isCurrentSession()) return;
    if (video.readyState >= 2) {
      promptPlayback();
      return;
    }
    failPlayer('Belum ada gambar dari kamera. Coba buka sumber langsung atau pilih kamera lain.', 'SIARAN BELUM MERESPONS');
  }, 20_000);

  if (window.Hls && window.Hls.isSupported()) {
    const hls = new window.Hls({ enableWorker: true, lowLatencyMode: true });
    activeHls = hls;
    hls.on(window.Hls.Events.MEDIA_ATTACHED, () => {
      if (isCurrentSession()) hls.loadSource(streamUrl);
    });
    hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
      if (!isCurrentSession()) return;
      video.play().catch(promptPlayback);
    });
    hls.on(window.Hls.Events.ERROR, (_event, data) => {
      if (!data.fatal || !isCurrentSession()) return;
      console.warn('CCTV HLS playback error', { type: data.type, details: data.details, responseCode: data.response?.code, reason: data.reason });
      failPlayer('Feed ini gagal dimuat. Kamera mungkin offline atau aksesnya terbatas.');
    });
    hls.attachMedia(video);
    return;
  }

  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = streamUrl;
    video.play().catch(promptPlayback);
    return;
  }
  stopActivePlayer();
  setCameraHealth(camera.id, 'error');
  setPlayerStatus('PEMUTAR TIDAK DIDUKUNG', 'error');
  showPlayerMessage('Browser ini belum mendukung pemutaran HLS. Buka sumber langsung.', true);
}

function showPlayer(camera) {
  if (activeCameraId && getCameraHealth(activeCameraId) === 'connecting') {
    setCameraHealth(activeCameraId, 'unknown');
  }
  stopActivePlayer();
  activeCameraId = camera.id;
  playerPanel.hidden = false;
  playerTitle.textContent = camera.name;
  playerArea.textContent = `${camera.area} · Kecamatan ${camera.district} · ${camera.view}`;
  renderTrafficEstimates(camera.id);
  const feedUrl = getFeedUrl(camera);
  openSource.href = feedUrl;
  openSource.textContent = 'Buka sumber asli ↗';
  setCameraHealth(camera.id, 'connecting');
  setPlayerStatus('MENGHUBUNGKAN SIARAN', 'connecting');

  const streamUrl = getHlsUrl(camera);
  if (streamUrl) {
    playerFrame.innerHTML = `<video id="cameraVideo" class="camera-video" title="Siaran CCTV ${escapeHtml(camera.name)}" controls autoplay muted playsinline></video><div class="player-feedback" id="playerFeedback" role="status"><span class="feedback-spinner" aria-hidden="true"></span><span>Menghubungkan ke siaran langsung…</span></div>`;
    startHlsPlayer(camera, streamUrl);
    return;
  }

  // A cross-origin embed's load event cannot confirm that video is actually playing.
  setCameraHealth(camera.id, 'unknown');
  setPlayerStatus('STATUS SIARAN BELUM DIVERIFIKASI', 'unknown');
  playerFrame.innerHTML = `<iframe title="Siaran CCTV ${escapeHtml(camera.name)}" src="${escapeHtml(feedUrl)}" loading="lazy" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
}

function closePlayer() {
  if (activeCameraId && getCameraHealth(activeCameraId) === 'connecting') setCameraHealth(activeCameraId, 'unknown');
  stopActivePlayer();
  activeCameraId = null;
  playerPanel.hidden = true;
  playerFrame.innerHTML = '<div class="player-empty"><span class="empty-camera" aria-hidden="true"><svg viewBox="0 0 32 32"><path d="M3 10h15l5 6-5 6H3v-12Z"/><path d="M23 16h6"/></svg></span><strong>Pilih kamera di peta</strong><span>Siaran akan dibuka saat kamu memilih titik.</span></div>';
  playerPanel.classList.remove('is-theater');
  updateTheaterButton();
  setPlayerStatus('PILIH KAMERA');
  state.selectedId = null;
  renderList();
}

function updateTheaterButton() {
  const expanded = document.fullscreenElement === playerPanel || playerPanel.classList.contains('is-theater');
  const label = expanded ? 'Keluar dari tampilan besar' : 'Besarkan pemutar';
  playerTheater.setAttribute('aria-pressed', String(expanded));
  playerTheater.setAttribute('aria-label', label);
  playerTheater.title = label;
}

async function togglePlayerTheater() {
  if (document.fullscreenElement === playerPanel) {
    await document.exitFullscreen().catch(() => {});
    return;
  }
  if (playerPanel.classList.contains('is-theater')) {
    playerPanel.classList.remove('is-theater');
    updateTheaterButton();
    return;
  }
  if (playerPanel.requestFullscreen) {
    try {
      await playerPanel.requestFullscreen();
      return;
    } catch { /* Fall back to an expanded panel inside the map. */ }
  }
  playerPanel.classList.add('is-theater');
  updateTheaterButton();
}

function toggleFavorite(id) {
  if (state.favorites.has(id)) state.favorites.delete(id);
  else state.favorites.add(id);
  saveFavorites();
  document.getElementById('favoritesToggle').setAttribute('aria-pressed', String(state.favoritesOnly));
  renderList();
}

function updateClock() {
  const now = new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  document.getElementById('jakartaClock').textContent = now;
}

document.getElementById('areaFilters').addEventListener('click', (event) => {
  const button = event.target.closest('[data-area]');
  if (!button) return;
  state.area = button.dataset.area;
  renderList();
});

searchInput.addEventListener('input', () => {
  state.query = searchInput.value;
  renderList();
});

document.getElementById('resetFilters').addEventListener('click', () => {
  state.area = 'Semua';
  state.healthFilter = 'all';
  state.query = '';
  state.favoritesOnly = false;
  searchInput.value = '';
  document.getElementById('favoritesToggle').setAttribute('aria-pressed', 'false');
  renderList();
});

document.getElementById('favoritesToggle').addEventListener('click', (event) => {
  state.favoritesOnly = !state.favoritesOnly;
  event.currentTarget.setAttribute('aria-pressed', String(state.favoritesOnly));
  renderList();
});

document.getElementById('healthFilters').addEventListener('click', (event) => {
  const button = event.target.closest('[data-health]');
  if (!button) return;
  state.healthFilter = button.dataset.health;
  renderList();
});

document.getElementById('closePlayer').addEventListener('click', closePlayer);
playerTheater.addEventListener('click', togglePlayerTheater);
document.addEventListener('fullscreenchange', updateTheaterButton);
document.getElementById('zoomIn').addEventListener('click', () => map?.zoomIn());
document.getElementById('zoomOut').addEventListener('click', () => map?.zoomOut());
document.getElementById('zoomHome').addEventListener('click', () => {
  if (!map) return;
  const visible = visibleCameras();
  if (visible.length) map.fitBounds(L.latLngBounds(visible.map((camera) => [camera.lat, camera.lng])), { padding: [70, 70], maxZoom: 13 });
  else map.setView([-6.2028, 106.8175], 12.1);
});
document.getElementById('openOfficialPortal').addEventListener('click', () => window.open(officialPortal, '_blank', 'noopener,noreferrer'));

document.addEventListener('keydown', (event) => {
  if (event.key === '/' && document.activeElement !== searchInput && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    searchInput.focus();
  }
  if (event.key === 'Escape') {
    if (document.activeElement === searchInput) searchInput.blur();
    else if (document.fullscreenElement === playerPanel) document.exitFullscreen().catch(() => {});
    else if (playerPanel.classList.contains('is-theater')) {
      playerPanel.classList.remove('is-theater');
      updateTheaterButton();
    }
    else if (!playerPanel.hidden) closePlayer();
  }
});

async function startApp() {
  await loadCameraCatalog();
  await loadTrafficEstimates();
  initializeMap();
  renderList();
  updateClock();
  setInterval(updateClock, 30_000);
}

startApp();
