'use strict';

// ===== STATE =====
const DEFAULT_STATE = {
  charName: 'Heroe',
  charAvatar: '⚔️',
  level: 1,
  xp: 0,
  stats: { strength: 0, mind: 0, discipline: 0, health: 0, confidence: 0 },
  habits: [],
  missions: [],
  streak: 0,
  streakBest: 0,
  lastCheckDate: null,
};

const STAT_COLORS = {
  strength: '#e05050',
  mind: '#5090e0',
  discipline: '#e0a030',
  health: '#50c080',
  confidence: '#b060e0',
};

const STAT_LABELS = {
  strength: '💪 Fuerza',
  mind: '🧠 Mente',
  discipline: '🎯 Disciplina',
  health: '❤️ Salud',
};

const XP_PER_LEVEL = (lvl) => 100 * lvl;

let state = JSON.parse(JSON.stringify(DEFAULT_STATE));

function load() {
  try {
    const saved = localStorage.getItem('liferpg-state');
    if (saved) state = JSON.parse(saved);
  } catch (e) { /* ignore */ }
  checkDailyReset();
}

function save() {
  localStorage.setItem('liferpg-state', JSON.stringify(state));
}

// ===== DAILY RESET =====
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function checkDailyReset() {
  const today = todayStr();
  if (state.lastCheckDate !== today) {
    const allDone = state.habits.length > 0 && state.habits.every(h => h.doneToday);
    if (state.lastCheckDate) {
      if (allDone) {
        state.streak++;
        if (state.streak > state.streakBest) state.streakBest = state.streak;
      } else {
        state.streak = 0;
      }
    }
    state.habits.forEach(h => { h.doneToday = false; });
    state.lastCheckDate = today;
    save();
  }
}

// ===== XP & LEVEL =====
function addXP(amount) {
  state.xp += amount;
  let leveled = false;
  while (state.xp >= XP_PER_LEVEL(state.level)) {
    state.xp -= XP_PER_LEVEL(state.level);
    state.level++;
    leveled = true;
  }
  if (leveled) showLevelUp(state.level);
  save();
  renderHeader();
}

function addStat(stat, pts) {
  state.stats[stat] = (state.stats[stat] || 0) + pts;
  state.stats.confidence = (state.stats.confidence || 0) + Math.ceil(pts * 0.3);
  save();
  renderStats();
}

// ===== RENDER =====
function renderHeader() {
  document.getElementById('charName').textContent = state.charName;
  document.getElementById('charAvatar').textContent = state.charAvatar;
  document.getElementById('charLevel').textContent = state.level;
  const needed = XP_PER_LEVEL(state.level);
  document.getElementById('xpCurrent').textContent = state.xp;
  document.getElementById('xpNext').textContent = needed;
  document.getElementById('xpBar').style.width = Math.min(100, (state.xp / needed) * 100) + '%';
}

function statBarWidth(val) {
  const max = Math.max(200, val + 50);
  return Math.min(100, (val / max) * 100) + '%';
}

function renderStats() {
  ['strength', 'mind', 'discipline', 'health', 'confidence'].forEach(stat => {
    const val = state.stats[stat] || 0;
    document.getElementById('bar-' + stat).style.width = statBarWidth(val);
    document.getElementById('val-' + stat).textContent = val;
  });
  document.getElementById('streakCount').textContent = state.streak;
  document.getElementById('streakBest').textContent = state.streakBest;
}

function renderHabits() {
  const list = document.getElementById('habitList');
  if (!state.habits.length) {
    list.innerHTML = '<li class="empty-state"><div class="empty-icon">🌱</div><div class="empty-text">No tienes habitos aun.<br>Agrega uno para empezar.</div></li>';
    return;
  }
  list.innerHTML = state.habits.map((h, i) => `
    <li class="habit-item ${h.doneToday ? 'done' : ''}" data-id="${h.id}">
      <button class="habit-check ${h.doneToday ? 'checked' : ''}" data-idx="${i}" aria-label="Completar">
        ${h.doneToday ? '✓' : ''}
      </button>
      <div class="habit-info">
        <div class="habit-name">${esc(h.name)}</div>
        <div class="habit-meta">
          <span class="habit-stat-dot" style="background:${STAT_COLORS[h.stat]}"></span>
          ${STAT_LABELS[h.stat]} &nbsp;· +${h.pts} pts
        </div>
      </div>
      <button class="habit-delete" data-del-idx="${i}" aria-label="Eliminar">×</button>
    </li>
  `).join('');

  list.querySelectorAll('.habit-check').forEach(btn => {
    btn.addEventListener('click', () => toggleHabit(+btn.dataset.idx));
  });
  list.querySelectorAll('.habit-delete').forEach(btn => {
    btn.addEventListener('click', () => deleteHabit(+btn.dataset.delIdx));
  });
}

function renderMissions() {
  const list = document.getElementById('missionList');
  if (!state.missions.length) {
    list.innerHTML = '<li class="empty-state"><div class="empty-icon">🗺️</div><div class="empty-text">No tienes misiones activas.<br>Crea tu primera mision.</div></li>';
    return;
  }
  list.innerHTML = state.missions.map((m, i) => `
    <li class="mission-item ${m.done ? 'done' : ''}" data-id="${m.id}">
      <div class="mission-header">
        <div class="mission-title">${esc(m.title)}</div>
        <button class="mission-delete" data-del-idx="${i}" aria-label="Eliminar">×</button>
      </div>
      ${m.desc ? `<div class="mission-desc">${esc(m.desc)}</div>` : ''}
      <div class="mission-footer">
        <div class="mission-xp">⭐ ${m.xp} XP</div>
        <span style="font-size:11px;color:#8888aa">${STAT_LABELS[m.stat]}</span>
        <button class="mission-complete-btn ${m.done ? 'done-btn' : ''}" data-idx="${i}">
          ${m.done ? '✓ Completada' : 'Completar'}
        </button>
      </div>
    </li>
  `).join('');

  list.querySelectorAll('.mission-complete-btn:not(.done-btn)').forEach(btn => {
    btn.addEventListener('click', () => completeMission(+btn.dataset.idx));
  });
  list.querySelectorAll('.mission-delete').forEach(btn => {
    btn.addEventListener('click', () => deleteMission(+btn.dataset.delIdx));
  });
}

function renderAll() {
  renderHeader();
  renderStats();
  renderHabits();
  renderMissions();
  document.getElementById('dateBadge').textContent = new Date().toLocaleDateString('es-ES', { weekday:'short', day:'numeric', month:'short' });
}

// ===== ACTIONS =====
function toggleHabit(idx) {
  const h = state.habits[idx];
  if (h.doneToday) return;
  h.doneToday = true;
  addStat(h.stat, h.pts);
  addXP(h.pts);
  save();
  renderHabits();
  showToast(`+${h.pts} ${STAT_LABELS[h.stat]} ⚡`);
}

function deleteHabit(idx) {
  state.habits.splice(idx, 1);
  save();
  renderHabits();
}

function completeMission(idx) {
  const m = state.missions[idx];
  if (m.done) return;
  m.done = true;
  addStat(m.stat, Math.ceil(m.xp * 0.5));
  addXP(m.xp);
  save();
  renderMissions();
  showToast(`¡Mision completada! +${m.xp} XP 🎉`);
}

function deleteMission(idx) {
  state.missions.splice(idx, 1);
  save();
  renderMissions();
}

// ===== MODALS =====
// HABIT MODAL
let habitSelectedStat = 'strength';
let habitSelectedPts = 5;

document.getElementById('btnAddHabit').addEventListener('click', () => {
  document.getElementById('habitName').value = '';
  habitSelectedStat = 'strength';
  habitSelectedPts = 5;
  syncPicker('habitStatPicker', habitSelectedStat, 'data-stat');
  syncPicker('habitPointsPicker', '5', 'data-pts');
  openModal('modalHabit');
});

document.getElementById('habitStatPicker').addEventListener('click', e => {
  const btn = e.target.closest('.stat-btn');
  if (!btn) return;
  habitSelectedStat = btn.dataset.stat;
  syncPicker('habitStatPicker', habitSelectedStat, 'data-stat');
});

document.getElementById('habitPointsPicker').addEventListener('click', e => {
  const btn = e.target.closest('.pts-btn');
  if (!btn) return;
  habitSelectedPts = +btn.dataset.pts;
  syncPicker('habitPointsPicker', btn.dataset.pts, 'data-pts');
});

document.getElementById('confirmHabit').addEventListener('click', () => {
  const name = document.getElementById('habitName').value.trim();
  if (!name) return shake('habitName');
  state.habits.push({ id: uid(), name, stat: habitSelectedStat, pts: habitSelectedPts, doneToday: false });
  save();
  renderHabits();
  closeModal('modalHabit');
  showToast('Habito creado ✓');
});
document.getElementById('cancelHabit').addEventListener('click', () => closeModal('modalHabit'));

// MISSION MODAL
let missionSelectedStat = 'strength';
let missionSelectedXp = 50;

document.getElementById('btnAddMission').addEventListener('click', () => {
  document.getElementById('missionTitle').value = '';
  document.getElementById('missionDesc').value = '';
  missionSelectedStat = 'strength';
  missionSelectedXp = 50;
  syncPicker('missionStatPicker', missionSelectedStat, 'data-stat');
  syncPicker('missionXpPicker', '50', 'data-pts');
  openModal('modalMission');
});

document.getElementById('missionStatPicker').addEventListener('click', e => {
  const btn = e.target.closest('.stat-btn');
  if (!btn) return;
  missionSelectedStat = btn.dataset.stat;
  syncPicker('missionStatPicker', missionSelectedStat, 'data-stat');
});

document.getElementById('missionXpPicker').addEventListener('click', e => {
  const btn = e.target.closest('.pts-btn');
  if (!btn) return;
  missionSelectedXp = +btn.dataset.pts;
  syncPicker('missionXpPicker', btn.dataset.pts, 'data-pts');
});

document.getElementById('confirmMission').addEventListener('click', () => {
  const title = document.getElementById('missionTitle').value.trim();
  if (!title) return shake('missionTitle');
  const desc = document.getElementById('missionDesc').value.trim();
  state.missions.push({ id: uid(), title, desc, stat: missionSelectedStat, xp: missionSelectedXp, done: false });
  save();
  renderMissions();
  closeModal('modalMission');
  showToast('Mision creada ✓');
});
document.getElementById('cancelMission').addEventListener('click', () => closeModal('modalMission'));

// CONFIG MODAL
let configSelectedAvatar = '⚔️';

document.getElementById('btnConfig').addEventListener('click', () => {
  document.getElementById('inputCharName').value = state.charName;
  configSelectedAvatar = state.charAvatar;
  syncPicker('avatarPicker', configSelectedAvatar, 'data-emoji');
  openModal('modalConfig');
});

document.getElementById('avatarPicker').addEventListener('click', e => {
  const btn = e.target.closest('.avatar-btn');
  if (!btn) return;
  configSelectedAvatar = btn.dataset.emoji;
  syncPicker('avatarPicker', configSelectedAvatar, 'data-emoji');
});

document.getElementById('confirmConfig').addEventListener('click', () => {
  const name = document.getElementById('inputCharName').value.trim();
  if (!name) return shake('inputCharName');
  state.charName = name;
  state.charAvatar = configSelectedAvatar;
  save();
  renderHeader();
  closeModal('modalConfig');
  showToast('Personaje actualizado ✓');
});
document.getElementById('cancelConfig').addEventListener('click', () => closeModal('modalConfig'));

// ===== TABS =====
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('panel-' + tab.dataset.tab).classList.add('active');
  });
});

// ===== HELPERS =====
function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

function syncPicker(pickerId, value, attr) {
  document.querySelectorAll(`#${pickerId} [${attr}]`).forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute(attr) === value);
  });
}

function shake(inputId) {
  const el = document.getElementById(inputId);
  el.style.borderColor = '#e05050';
  el.focus();
  setTimeout(() => el.style.borderColor = '', 600);
}

let toastTimer;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

function showLevelUp(lvl) {
  const overlay = document.getElementById('levelupOverlay');
  document.getElementById('levelupNum').textContent = lvl;
  overlay.classList.add('show');
  setTimeout(() => overlay.classList.remove('show'), 2500);
}

function uid() { return Math.random().toString(36).slice(2, 10); }

function esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Close modals on backdrop tap
document.querySelectorAll('.modal').forEach(modal => {
  modal.addEventListener('click', e => {
    if (e.target === modal) closeModal(modal.id);
  });
});

// ===== INIT =====
load();
renderAll();

// Register SW
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
