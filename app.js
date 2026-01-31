const STORAGE_KEY = 'timeTiles.v3';

const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, kids = []) => {
  const n = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (k === 'class') n.className = v;
    else if (k === 'dataset') Object.entries(v).forEach(([dk, dv]) => (n.dataset[dk] = dv));
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (v === false || v === null || v === undefined) return;
    else n.setAttribute(k, v === true ? '' : String(v));
  });
  for (const kid of kids) n.append(kid);
  return n;
};

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const msToClock = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
};
const uid = () => Math.random().toString(16).slice(2) + Date.now().toString(16);

function base64UrlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
function base64UrlDecode(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const base = b64.replaceAll('-', '+').replaceAll('_', '/') + pad;
  const bin = atob(base);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

const defaultState = () => ({
  version: 3,
  windowMins: 120,
  tiles: [],
  selectedId: null,
  focus: {
    running: false,
    startedAt: null,
    elapsedMs: 0,
    tileId: null,
  },
});

let state = defaultState();

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.style.opacity = '1';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.style.opacity = '0.85'), 1400);
}

function loadState() {
  // 1) permalink hash wins
  if (location.hash.startsWith('#s=')) {
    try {
      const raw = base64UrlDecode(location.hash.slice(3));
      const parsed = JSON.parse(raw);
      return normalizeState(parsed);
    } catch {
      // fall through
    }
  }
  // 2) localStorage
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    return normalizeState(JSON.parse(raw));
  } catch {
    return defaultState();
  }
}

function normalizeState(s) {
  const base = defaultState();
  const tiles = Array.isArray(s.tiles) ? s.tiles : [];
  const merged = {
    ...base,
    ...s,
    tiles: tiles
      .filter((t) => t && typeof t === 'object')
      .map((t) => ({
        id: String(t.id || uid()),
        title: String(t.title || '').slice(0, 60) || 'Untitled',
        mins: clamp(Number(t.mins || 25), 5, 120),
        energy: ['low', 'medium', 'high'].includes(t.energy) ? t.energy : 'medium',
        done: Boolean(t.done),
        createdAt: Number(t.createdAt || Date.now()),
      })),
  };

  if (!merged.selectedId || !merged.tiles.some((t) => t.id === merged.selectedId)) {
    merged.selectedId = merged.tiles[0]?.id ?? null;
  }

  if (merged.focus?.tileId && !merged.tiles.some((t) => t.id === merged.focus.tileId)) {
    merged.focus = { running: false, startedAt: null, elapsedMs: 0, tileId: null };
  }

  return merged;
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore
  }
}

function totalPlannedMins() {
  return state.tiles.filter((t) => !t.done).reduce((a, t) => a + t.mins, 0);
}

function remainingWindowMins() {
  return Math.max(0, state.windowMins - totalPlannedMins());
}

function selectedIndex() {
  return state.tiles.findIndex((t) => t.id === state.selectedId);
}

function selectByIndex(i) {
  if (state.tiles.length === 0) {
    state.selectedId = null;
    return;
  }
  const idx = clamp(i, 0, state.tiles.length - 1);
  state.selectedId = state.tiles[idx].id;
}

function getSelectedTile() {
  return state.tiles.find((t) => t.id === state.selectedId) ?? null;
}

function focusTileId() {
  return state.focus.tileId ?? state.selectedId;
}

function getFocusTile() {
  const id = focusTileId();
  return state.tiles.find((t) => t.id === id) ?? null;
}

function setFocusTile(id) {
  state.focus.tileId = id;
  state.selectedId = id;
}

function stopTimer() {
  state.focus.running = false;
  state.focus.startedAt = null;
}

function startTimer() {
  if (!getFocusTile()) return;
  state.focus.running = true;
  state.focus.startedAt = Date.now();
}

function toggleTimer() {
  if (!getFocusTile()) return;
  if (state.focus.running) {
    // pause
    const now = Date.now();
    state.focus.elapsedMs += now - (state.focus.startedAt ?? now);
    stopTimer();
  } else {
    startTimer();
  }
}

function markDone() {
  const t = getFocusTile();
  if (!t) return;
  t.done = true;
  // celebrate w/ tiny haptic-ish sound (safe, simple)
  blip();
  toast('Done. Nice.');

  // advance to next unfinished tile
  const idx = state.tiles.findIndex((x) => x.id === t.id);
  const next = state.tiles.slice(idx + 1).find((x) => !x.done) ?? state.tiles.find((x) => !x.done) ?? null;
  state.focus.elapsedMs = 0;
  stopTimer();
  state.focus.tileId = next?.id ?? null;
  state.selectedId = next?.id ?? null;
}

// --- Audio (tiny; no external deps) ---
let audioCtx = null;
function blip() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'triangle';
    o.frequency.value = 620;
    g.gain.value = 0.0001;
    o.connect(g);
    g.connect(audioCtx.destination);
    const t0 = audioCtx.currentTime;
    g.gain.exponentialRampToValueAtTime(0.08, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
    o.start(t0);
    o.stop(t0 + 0.2);
  } catch {
    // ignore
  }
}

// --- Drag & drop ---
let dragId = null;
function onDragStart(e) {
  dragId = e.currentTarget?.dataset?.id || null;
  e.dataTransfer?.setData('text/plain', dragId || '');
  e.dataTransfer && (e.dataTransfer.effectAllowed = 'move');
  e.currentTarget.classList.add('dragging');
}
function onDragEnd(e) {
  e.currentTarget.classList.remove('dragging');
  for (const node of document.querySelectorAll('.tile.drop-target')) node.classList.remove('drop-target');
  dragId = null;
}
function onDragOver(e) {
  e.preventDefault();
  e.dataTransfer && (e.dataTransfer.dropEffect = 'move');
}
function onDragEnter(e) {
  const id = e.currentTarget?.dataset?.id;
  if (!dragId || dragId === id) return;
  e.currentTarget.classList.add('drop-target');
}
function onDragLeave(e) {
  e.currentTarget.classList.remove('drop-target');
}
function onDrop(e) {
  e.preventDefault();
  const targetId = e.currentTarget?.dataset?.id;
  if (!dragId || !targetId || dragId === targetId) return;

  const from = state.tiles.findIndex((t) => t.id === dragId);
  const to = state.tiles.findIndex((t) => t.id === targetId);
  if (from < 0 || to < 0) return;

  const [moved] = state.tiles.splice(from, 1);
  state.tiles.splice(to, 0, moved);
  toast('Reordered.');
  render();
}

function renderStats() {
  const planned = totalPlannedMins();
  const remaining = remainingWindowMins();
  const done = state.tiles.filter((t) => t.done).length;
  const over = Math.max(0, planned - state.windowMins);

  const stats = $('#stats');
  const nodes = [
    pill(`Planned: ${planned}m`, 'var(--terracotta)'),
    pill(`Left in window: ${remaining}m`, remaining === 0 && planned > 0 ? 'var(--danger)' : 'var(--cactus)'),
    pill(`Done: ${done}/${state.tiles.length}`, 'var(--sun)'),
  ];

  if (over > 0) nodes.splice(1, 0, pill(`Over by: ${over}m`, 'var(--danger)'));

  stats.replaceChildren(...nodes);
}

function pill(text, color) {
  return el('div', { class: 'pill' }, [
    el('span', { class: 'pill__dot', style: `background:${color}` }),
    document.createTextNode(text),
  ]);
}

function renderTimeline() {
  const list = $('#timeline');
  list.replaceChildren();

  if (state.tiles.length === 0) {
    list.append(
      el('div', { class: 'tile', 'aria-selected': 'false' }, [
        el('div', { class: 'tile__left' }, [
          el('div', { class: 'tile__title' }, [document.createTextNode('Add your first tile')]),
          el('div', { class: 'tile__meta' }, [document.createTextNode('Try: “tidy desk” for 10 minutes.')]),
        ]),
        el('div', { class: 'tile__right' }, [
          el('span', { class: 'chip' }, [document.createTextNode('hint')]),
        ])
      ])
    );
    return;
  }

  for (const t of state.tiles) {
    const isSelected = state.selectedId === t.id;
    const tileNode = el('div', {
      class: 'tile',
      role: 'listitem',
      tabindex: '0',
      draggable: 'true',
      'aria-selected': isSelected ? 'true' : 'false',
      dataset: { id: t.id, energy: t.energy },
      onClick: () => {
        state.selectedId = t.id;
        setFocusTile(t.id);
        render();
      },
      onKeydown: (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          state.selectedId = t.id;
          setFocusTile(t.id);
          render();
        }
      },
      onDragstart: onDragStart,
      onDragend: onDragEnd,
      onDragover: onDragOver,
      onDragenter: onDragEnter,
      onDragleave: onDragLeave,
      onDrop: onDrop,
    }, [
      el('div', { class: 'tile__left' }, [
        el('div', { class: 'tile__title' }, [document.createTextNode(t.done ? `✓ ${t.title}` : t.title)]),
        el('div', { class: 'tile__meta' }, [document.createTextNode(`${t.mins} min • ${t.energy} energy`)]),
      ]),
      el('div', { class: 'tile__right' }, [
        el('span', { class: 'chip' }, [document.createTextNode(t.done ? 'done' : 'tile')]),
        el('button', {
          class: 'iconbtn',
          type: 'button',
          title: 'Delete tile',
          onClick: (e) => {
            e.stopPropagation();
            if (!confirm(`Delete “${t.title}”?`)) return;
            const idx = state.tiles.findIndex((x) => x.id === t.id);
            state.tiles.splice(idx, 1);
            if (state.focus.tileId === t.id) {
              state.focus.tileId = null;
              state.focus.elapsedMs = 0;
              stopTimer();
            }
            if (state.selectedId === t.id) {
              state.selectedId = state.tiles[0]?.id ?? null;
            }
            render();
          },
        }, [document.createTextNode('×')]),
      ]),
    ]);

    list.append(tileNode);
  }
}

function renderFocus() {
  const t = getFocusTile();

  $('#focusTitle').textContent = t ? t.title : 'No tile selected';
  $('#focusMeta').textContent = t ? `${t.mins} minutes • ${t.energy} energy` : '—';
  $('#btnDone').disabled = !t;
  $('#btnStartPause').disabled = !t;

  const hint = $('#nowHint');
  hint.textContent = t
    ? (state.focus.running ? 'Stay with it. You’re doing it.' : 'Press Start (or Space) to begin.')
    : 'Pick a tile from the left.';
}

function renderTimer() {
  const t = getFocusTile();
  const ring = document.querySelector('.ring__progress');
  const time = $('#focusTime');
  const sub = $('#focusSub');
  const btn = $('#btnStartPause');

  if (!t) {
    ring.style.strokeDashoffset = '100';
    time.textContent = '00:00';
    sub.textContent = 'ready';
    btn.textContent = 'Start';
    return;
  }

  const durationMs = t.mins * 60_000;
  const now = Date.now();
  const elapsed = state.focus.elapsedMs + (state.focus.running ? (now - (state.focus.startedAt ?? now)) : 0);
  const remain = Math.max(0, durationMs - elapsed);
  const pct = durationMs === 0 ? 0 : clamp((elapsed / durationMs) * 100, 0, 100);

  ring.style.stroke = t.energy === 'low' ? 'var(--cactus)' : t.energy === 'high' ? 'var(--sun)' : 'var(--terracotta)';
  ring.style.strokeDashoffset = String(100 - pct);

  time.textContent = msToClock(remain);
  sub.textContent = state.focus.running ? 'running' : (elapsed > 0 ? 'paused' : 'ready');
  btn.textContent = state.focus.running ? 'Pause' : 'Start';

  if (remain === 0 && state.focus.running) {
    // auto-stop + notify
    state.focus.elapsedMs = durationMs;
    stopTimer();
    blip();
    toast('Time. Mark it done or continue.');
    renderFocus();
  }
}

function ensureFocusValid() {
  const t = getFocusTile();
  if (!t) return;
  if (!t.done) return;

  const idx = state.tiles.findIndex((x) => x.id === t.id);
  const next = state.tiles.slice(idx + 1).find((x) => !x.done) ?? state.tiles.find((x) => !x.done) ?? null;
  state.focus.tileId = next?.id ?? null;
  state.selectedId = next?.id ?? null;
  state.focus.elapsedMs = 0;
  stopTimer();
}

function render() {
  ensureFocusValid();
  renderStats();
  renderTimeline();
  renderFocus();
  renderTimer();
  saveState();
}

function exportJson() {
  const payload = JSON.stringify({
    exportedAt: new Date().toISOString(),
    app: 'Time Tiles',
    styleId: 'desert-sun',
    state,
  }, null, 2);

  const blob = new Blob([payload], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `time-tiles-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function shareLink() {
  const raw = JSON.stringify(state);
  const encoded = base64UrlEncode(raw);
  const url = `${location.origin}${location.pathname}#s=${encoded}`;

  try {
    if (navigator.share) {
      await navigator.share({
        title: 'Time Tiles',
        text: 'My next 2 hours, tiled.',
        url,
      });
      toast('Shared.');
      return;
    }
  } catch {
    // fall back to clipboard
  }

  try {
    await navigator.clipboard.writeText(url);
    toast('Link copied.');
  } catch {
    prompt('Copy link:', url);
  }
}

async function importJsonFile(file) {
  const raw = await file.text();
  const parsed = JSON.parse(raw);
  const maybeState = parsed?.state ?? parsed;
  state = normalizeState(maybeState);
  stopTimer();
  state.focus.elapsedMs = 0;
  toast('Imported.');
  render();
}

function wire() {
  $('#formAdd').addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const title = String(fd.get('title') || '').trim();
    const mins = clamp(Number(fd.get('mins') || 25), 5, 120);
    const energy = String(fd.get('energy') || 'medium');

    if (!title) return;

    const t = { id: uid(), title, mins, energy, done: false, createdAt: Date.now() };
    state.tiles.push(t);
    state.selectedId = t.id;
    setFocusTile(t.id);

    e.currentTarget.reset();
    $('#mins').value = '25';
    $('#energy').value = 'medium';
    toast('Added.');
    render();
  });

  $('#btnStartPause').addEventListener('click', () => {
    toggleTimer();
    render();
  });

  $('#btnDone').addEventListener('click', () => {
    markDone();
    render();
  });

  $('#btnReset').addEventListener('click', () => {
    if (!confirm('Reset everything?')) return;
    state = defaultState();
    location.hash = '';
    toast('Reset.');
    render();
  });

  $('#btnExport').addEventListener('click', exportJson);
  $('#btnShare').addEventListener('click', shareLink);

  $('#fileImport').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await importJsonFile(file);
    e.target.value = '';
  });

  document.addEventListener('keydown', (e) => {
    if (e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;

    if (e.key === ' ') {
      e.preventDefault();
      toggleTimer();
      render();
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      markDone();
      render();
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectByIndex(selectedIndex() - 1);
      setFocusTile(state.selectedId);
      render();
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectByIndex(selectedIndex() + 1);
      setFocusTile(state.selectedId);
      render();
    }
  });
}

function tickLoop() {
  renderTimer();
  requestAnimationFrame(tickLoop);
}

// boot
state = loadState();
wire();
render();
requestAnimationFrame(tickLoop);
