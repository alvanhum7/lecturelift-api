(async function () {

  function checkAndRevertExpiredAdjustment() {
    const adjustment = JSON.parse(localStorage.getItem('activeAdjustment') || 'null');
    if (!adjustment || adjustment.isPermanent) return;
    if (new Date() >= new Date(adjustment.endDate)) {
      const original = localStorage.getItem('originalProgramme');
      if (original) localStorage.setItem('generatedProgramme', original);
      localStorage.removeItem('originalProgramme');
      localStorage.removeItem('activeAdjustment');
    }
  }

  // ── SUPABASE SYNC ──
  async function getSb() {
    for (let i = 0; i < 40; i++) {
      if (window.llSupabase) return window.llSupabase;
      await new Promise(r => setTimeout(r, 100));
    }
    return null;
  }
  const sb = await getSb();
  let sbUser = null;
  try {
    if (sb) {
      const { data } = await sb.auth.getSession();
      sbUser = data.session ? data.session.user : null;
    }
  } catch (e) { console.error(e); }

  async function pushProgramme() {
    if (!sb || !sbUser) return;
    try {
      const prog = JSON.parse(localStorage.getItem('generatedProgramme') || 'null');
      if (!prog) return;
      const orig = JSON.parse(localStorage.getItem('originalProgramme') || 'null');
      const adj = JSON.parse(localStorage.getItem('activeAdjustment') || 'null');
      const r = await sb.from('programmes').upsert({
        user_id: sbUser.id,
        programme: prog,
        original_programme: adj ? orig : null,
        active_adjustment: adj,
        updated_at: new Date().toISOString()
      });
      if (r.error) console.error('Save failed:', r.error);
    } catch (e) { console.error('Save failed:', e); }
  }

  if (sbUser) {
    try {
      const { data: row } = await sb.from('programmes').select('*').eq('user_id', sbUser.id).maybeSingle();
      if (row) {
        localStorage.setItem('generatedProgramme', JSON.stringify(row.programme));
        if (row.active_adjustment) {
          localStorage.setItem('activeAdjustment', JSON.stringify(row.active_adjustment));
          if (row.original_programme) localStorage.setItem('originalProgramme', JSON.stringify(row.original_programme));
        } else {
          localStorage.removeItem('activeAdjustment');
          localStorage.removeItem('originalProgramme');
        }
      } else {
        const localProg = JSON.parse(localStorage.getItem('generatedProgramme') || 'null');
        if (localProg) {
          const qa = JSON.parse(localStorage.getItem('quizAnswers') || 'null');
          const r = await sb.from('programmes').upsert({
            user_id: sbUser.id,
            programme: localProg,
            quiz_answers: qa,
            original_programme: null,
            active_adjustment: null,
            updated_at: new Date().toISOString()
          });
          if (r.error) console.error('Upload failed:', r.error);
        }
      }
    } catch (e) { console.error('Load failed:', e); }
  }

  // ── LOG SYNC ──
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 3 | 8)).toString(16);
    });
  }
  function isUuid(s) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || '')); }

  function weightRows(entry) {
    const rows = [];
    (entry.exercises || []).forEach(ex => (ex.sets || []).forEach(s => {
      if (s.done && s.weight) rows.push({
        user_id: sbUser.id, exercise_name: ex.name, logged_at: entry.date,
        weight_kg: parseFloat(s.weight), reps: String(s.reps || ''), rir: String(s.rir || '')
      });
    }));
    return rows;
  }

  function rebuildWeightLogs(logs) {
    const wl = {};
    logs.slice().reverse().forEach(l => (l.exercises || []).forEach(ex => (ex.sets || []).forEach(s => {
      if (s.done && s.weight) (wl[ex.name] = wl[ex.name] || []).push({ date: l.date, weight: parseFloat(s.weight), reps: s.reps, rir: s.rir });
    })));
    saveWeightLogs(wl);
  }

  async function pushSession(entry) {
    if (!sb || !sbUser) return;
    try {
      const r1 = await sb.from('session_logs').upsert({
        id: entry.id, user_id: sbUser.id, logged_at: entry.date,
        day: entry.day, session_title: entry.sessionTitle, exercises: entry.exercises
      });
      if (r1.error) throw r1.error;
      const wrows = weightRows(entry);
      if (wrows.length) { const r2 = await sb.from('weight_logs').insert(wrows); if (r2.error) throw r2.error; }
    } catch (e) { console.error('Session save failed:', e); }
  }

  async function syncLogs() {
    if (!sb || !sbUser) return;
    try {
      const local = getLogs();
      local.forEach(l => { if (!isUuid(l.id)) l.id = uuid(); });
      saveLogs(local);
      const { data: remote, error } = await sb.from('session_logs').select('*').eq('user_id', sbUser.id);
      if (error) throw error;
      const remoteIds = new Set((remote || []).map(r => r.id));
      const fresh = local.filter(l => !remoteIds.has(l.id));
      if (fresh.length) {
        const r1 = await sb.from('session_logs').upsert(fresh.map(l => ({
          id: l.id, user_id: sbUser.id, logged_at: l.date,
          day: l.day, session_title: l.sessionTitle, exercises: l.exercises
        })));
        if (r1.error) throw r1.error;
        const wrows = fresh.flatMap(weightRows);
        if (wrows.length) { const r2 = await sb.from('weight_logs').insert(wrows); if (r2.error) throw r2.error; }
      }
      const merged = (remote || []).map(r => ({
        id: r.id, date: r.logged_at, day: r.day, sessionTitle: r.session_title, exercises: r.exercises || []
      })).concat(fresh);
      merged.sort((a, b) => new Date(b.date) - new Date(a.date));
      saveLogs(merged);
      rebuildWeightLogs(merged);
    } catch (e) { console.error('Log sync failed:', e); }
  }
  await syncLogs();

  const hadAdj = !!localStorage.getItem('activeAdjustment');
  checkAndRevertExpiredAdjustment();
  if (hadAdj && !localStorage.getItem('activeAdjustment')) pushProgramme();

  function getUnit() { return localStorage.getItem('ll_weight_unit') || 'kg'; }
  function setUnit(u) { localStorage.setItem('ll_weight_unit', u); }
  function toDisplay(kg) {
  if (!kg && kg !== 0) return '';
  return getUnit() === 'lbs' ? (parseFloat(kg) * 2.2046).toFixed(1) : kg;
  }
  function toKg(val) {
  if (!val && val !== 0) return '';
  return getUnit() === 'lbs' ? (parseFloat(val) / 2.2046).toFixed(2) : val;
  }
  function unitLabel() { return getUnit(); }

  function getLogs() { return JSON.parse(localStorage.getItem('ll_session_logs') || '[]'); }
  function saveLogs(l) { localStorage.setItem('ll_session_logs', JSON.stringify(l)); }
  function getWeightLogs() { return JSON.parse(localStorage.getItem('ll_weight_logs') || '{}'); }
  function saveWeightLogs(l) { localStorage.setItem('ll_weight_logs', JSON.stringify(l)); }
  function getCurrentProgramme() {
    const prog = JSON.parse(localStorage.getItem('generatedProgramme') || 'null');
    if (!prog || !prog.workouts) return prog;
    prog.workouts.forEach(w => {
      if ((!w.exercises || !w.exercises.length) && Array.isArray(w.blocks)) {
        w.exercises = w.blocks
          .filter(b => b.type !== 'warmup' && b.type !== 'cooldown')
          .flatMap(b => (b.exercises || []).map(ex => {
            const m = String(ex.detail || '').match(/(\d+)\s*[x×]\s*([\d–\-]+)/i);
            return {
              ...ex,
              sets: ex.sets || (m ? m[1] : 3),
              reps: ex.reps || (m ? m[2].replace('–', '-') : '')
            };
          }));
      }
    });
    return prog;
  }
  function formatDate(d) { return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); }
  function timeAgo(d) {
  const diff = Date.now() - new Date(d).getTime();
  const mins = Math.floor(diff/60000), hours = Math.floor(diff/3600000), days = Math.floor(diff/86400000);
  if (mins < 2) return 'Just now'; if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`; if (days === 1) return 'Yesterday'; return `${days} days ago`;
  }
  function getLastWeight(exName) {
  const logs = getWeightLogs(); const entries = logs[exName];
  return (entries && entries.length > 0) ? entries[entries.length - 1] : null;
  }

  const wrap = document.createElement('div');
  wrap.id = 'll-prog-wrap';
  document.body.appendChild(wrap);
  document.body.insertAdjacentHTML('beforeend', `
  <div id="ll-toast">✓ Session logged!</div>
  <div id="ll-sticky-bar">
    <div id="ll-sticky-bar-inner">
      <div id="ll-sticky-progress">
        <div id="ll-sticky-label">Today's session <span id="ll-sticky-count">0 / 0 exercises</span></div>
        <div id="ll-sticky-track"><div id="ll-sticky-fill" style="width:0%"></div></div>
      </div>
      <button id="ll-sticky-btn">Log Session ✓</button>
    </div>
  </div>
  <div class="ll-modal-overlay hidden" id="ll-ex-modal">
    <div class="ll-modal">
      <div class="ll-modal-hdr">
        <div><div class="ll-modal-title" id="ll-modal-title"></div><div class="ll-modal-sub" id="ll-modal-sub"></div></div>
        <button class="ll-modal-close" id="ll-modal-close">✕</button>
      </div>
      <div class="ll-modal-tabs">
        <button class="ll-modal-tab active" data-panel="history">History</button>
        <button class="ll-modal-tab" data-panel="weight">Weight</button>
        <button class="ll-modal-tab" data-panel="volume">Volume</button>
      </div>
      <div class="ll-modal-panel active" id="ll-modal-panel-history"></div>
      <div class="ll-modal-panel" id="ll-modal-panel-weight"></div>
      <div class="ll-modal-panel" id="ll-modal-panel-volume"></div>
    </div>
  </div>
    <div class="ll-modal-overlay hidden" id="ll-last-modal">
    <div class="ll-modal">
      <div class="ll-modal-hdr">
        <div><div class="ll-modal-title" id="ll-last-title"></div><div class="ll-modal-sub" id="ll-last-sub"></div></div>
        <button class="ll-modal-close" id="ll-last-close">✕</button>
      </div>
      <div id="ll-last-body"></div>
    </div>
  </div>
  `);

    function findLastSession(title) {
    const key = String(title || '').trim().toLowerCase();
    const today = new Date().toDateString();
    return getLogs()
      .filter(l => String(l.sessionTitle || '').trim().toLowerCase() === key && new Date(l.date).toDateString() !== today)
      .sort((a, b) => new Date(b.date) - new Date(a.date))[0] || null;
  }

  function getLastExercise(name) {
    const logs = getLogs().slice().sort((a, b) => new Date(b.date) - new Date(a.date));
    for (const l of logs) {
      const ex = (l.exercises || []).find(e => e.name === name);
      const done = ex ? (ex.sets || []).filter(s => s.done) : [];
      if (done.length) return { date: l.date, day: l.day, sets: done };
    }
    return null;
  }

  function openLastSession(title) {
    const overlay = document.getElementById('ll-last-modal');
    const log = findLastSession(title);
    document.getElementById('ll-last-title').textContent = title;
    document.getElementById('ll-last-sub').textContent = log ? `${log.day} · ${formatDate(log.date)}` : '';
    document.getElementById('ll-last-body').innerHTML = log
      ? buildHistoryBody(log)
      : '<div class="ll-empty">No previous session of this type logged yet.</div>';
    overlay.classList.remove('hidden');
    document.getElementById('ll-last-close').onclick = () => overlay.classList.add('hidden');
    overlay.onclick = e => { if (e.target === overlay) overlay.classList.add('hidden'); };
  }
  
  // ── EXERCISE MODAL ──
  function openExModal(exName) {
    const overlay = document.getElementById('ll-ex-modal');
    const wl = getWeightLogs();
    const entries = wl[exName] || [];
    document.getElementById('ll-modal-title').textContent = exName;
    document.getElementById('ll-modal-sub').textContent = `${entries.length} weight entr${entries.length !== 1 ? 'ies' : 'y'} logged`;

    const histPanel = document.getElementById('ll-modal-panel-history');
    const allLogs = getLogs().filter(l => l.exercises && l.exercises.some(e => e.name === exName));
    if (allLogs.length === 0) {
      histPanel.innerHTML = '<div class="ll-empty">No sessions logged for this exercise yet.</div>';
    } else {
      histPanel.innerHTML = allLogs.map(log => {
        const ex = log.exercises.find(e => e.name === exName);
        const doneSets = (ex.sets||[]).filter(s=>s.done);
        const pills = doneSets.length > 0
          ? doneSets.map(s => {
              const w = s.weight ? `${toDisplay(s.weight)}${unitLabel()}` : null;
              const label = [w, s.reps].filter(Boolean).join(' × ');
              return `<span class="ll-hist-set-pill has-data">${label||'logged'}</span>`;
            }).join('')
          : '<span class="ll-hist-no-data">No set data</span>';
        return `<div class="ll-hist-ex-row"><div style="flex:1"><div class="ll-hist-ex-name" style="color:#8b949e;font-weight:400">${log.day} · ${formatDate(log.date)}</div><div class="ll-hist-sets-list" style="margin-top:4px">${pills}</div></div></div>`;
      }).join('');
    }

    const wtPanel = document.getElementById('ll-modal-panel-weight');
    wtPanel.innerHTML = '<div id="ll-modal-wt-area"></div>';
    setTimeout(() => drawWeightLine(document.getElementById('ll-modal-wt-area'), entries), 0);

    const volPanel = document.getElementById('ll-modal-panel-volume');
    volPanel.innerHTML = '<div id="ll-modal-vol-area"></div>';
    setTimeout(() => drawVolumeBars(document.getElementById('ll-modal-vol-area'), exName), 0);

    overlay.querySelectorAll('.ll-modal-tab').forEach(tab => {
      tab.onclick = () => {
        overlay.querySelectorAll('.ll-modal-tab').forEach(t => t.classList.remove('active'));
        overlay.querySelectorAll('.ll-modal-panel').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById(`ll-modal-panel-${tab.dataset.panel}`).classList.add('active');
      };
    });
    overlay.querySelectorAll('.ll-modal-tab')[0].click();

    overlay.classList.remove('hidden');
    document.getElementById('ll-modal-close').onclick = () => overlay.classList.add('hidden');
    overlay.onclick = e => { if (e.target === overlay) overlay.classList.add('hidden'); };
  }

  // ── PROGRESSIVE OVERLOAD SUGGESTION ──
  async function fetchPOSuggestion(ex, poBarEl) {
  poBarEl.innerHTML = '<div class="ll-po-dot" style="background:#8b949e;animation:ll-po-pulse 1.2s infinite"></div><div class="ll-po-text" style="color:#8b949e">Getting AI suggestion…</div>';

  try {
    const wl = getWeightLogs();
    const history = (wl[ex.name] || []).slice(-5).reverse().map(e => ({
      weight: parseFloat(toDisplay(e.weight)),
      reps: e.reps,
      rir: e.rir,
      sets: 1
    }));

       const sess = sb ? (await sb.auth.getSession()).data.session : null;
    const res = await fetch('https://lecturelift-api.vercel.app/api/po-suggestion', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(sess ? { Authorization: 'Bearer ' + sess.access_token } : {})
      },
      body: JSON.stringify({
        exerciseName: ex.name,
        history,
        targetSets: parseInt(ex.sets) || 3,
        targetReps: ex.reps || 8
      })
    });

    const data = await res.json();
    if (data.error) throw new Error(data.error);

    poBarEl.innerHTML = `
      <div class="ll-po-dot" style="background:#3fb950"></div>
      <div class="ll-po-text">
        <span style="color:#e6edf3;font-weight:600">
          ${data.weight ? data.weight + unitLabel() + ' × ' : ''}${data.reps} reps
          <span style="color:#58a6ff;font-size:11px;margin-left:6px">RIR ${data.rir}</span>
        </span>
        <span style="color:#8b949e;font-size:11px;margin-left:8px">— ${data.reason}</span>
      </div>
    `;
    } catch (e) {
    const msgs = {
      pro_required: 'Suggested weights, reps and RIR are a Pro feature.',
      limit_reached: "You've reached today's suggestion limit. It resets tomorrow.",
      login_required: 'Log in to see suggestions.',
      auth_failed: 'Log in again to see suggestions.'
    };
    const msg = msgs[e.message] || "Couldn't load suggestion — try again.";
    poBarEl.innerHTML = '<div class="ll-po-dot" style="background:#f85149"></div><div class="ll-po-text" style="color:#8b949e">' + msg + '</div>';
  }
  }

  const WEEK_DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];

  let activeDay = -1;
  let activeWeek = 1;
  let setData = {};

  function getTodayIdx() { const d = new Date().getDay(); return d === 0 ? 6 : d - 1; }

    function getMaxWeeks() {
  const prog = getCurrentProgramme();
  if (!prog || !prog.workouts) return 1;
  const fromWorkouts = Math.max(...prog.workouts.map(w => w.week || 1));
  return Math.max(fromWorkouts, parseInt(prog.weeks) || 1);
  }

  function getDays() {
  const prog = getCurrentProgramme();
  if (!prog || !prog.workouts) return [];
  const wk = prog.workouts.filter(w => w.week === activeWeek);
  const base = wk.length ? wk : prog.workouts.filter(w => w.week === 1);
  return WEEK_DAYS.map(name => base.find(w => w.day === name) || { week:activeWeek, day:name, sessionTitle:'Rest day', exercises:[] });
  }

  function isRest(day) { return !day.exercises || day.exercises.length === 0 || day.sessionTitle.toLowerCase().includes('rest'); }

    function isDayLogged(idx) {
  if (activeWeek !== 1) return false;
  const days = getDays(); const day = days[idx]; if (!day) return false;
  const today = new Date().toDateString();
  return getLogs().some(l => l.day === day.day && new Date(l.date).toDateString() === today);
  }

  function initSetData(dayIdx) {
  if (setData[dayIdx]) return;
  const day = getDays()[dayIdx];
  if (!day || isRest(day)) return;
  setData[dayIdx] = {};
  day.exercises.forEach((ex, i) => {
    const last = getLastWeight(ex.name);
    const sets = parseInt(ex.sets) || 3;
    setData[dayIdx][i] = Array.from({length: sets}, () => ({
      weight: '', reps: '', rir: '', done: false    }));
  });
  }

  function computeStats() {
  const logs = getLogs(); const now = new Date();
  const wStart = new Date(now); wStart.setDate(now.getDate() - (now.getDay() === 0 ? 6 : now.getDay()-1)); wStart.setHours(0,0,0,0);
  const mStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const thisWeek = logs.filter(l => new Date(l.date) >= wStart).length;
  const thisMonth = logs.filter(l => new Date(l.date) >= mStart).length;
  let streak = 0;
  const dates = [...new Set(logs.map(l => new Date(l.date).toDateString()))].sort((a,b) => new Date(b)-new Date(a));
  let check = new Date(); check.setHours(0,0,0,0);
  for (const d of dates) { const ld = new Date(d); ld.setHours(0,0,0,0); if ((check-ld)/86400000 <= 1) { streak++; check = ld; } else break; }
  return { total: logs.length, thisWeek, thisMonth, streak };
  }

  function showToast() {
  const t = document.getElementById('ll-toast'); t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
  }

  function showRirPopup(btn) {
  const existing = document.getElementById('ll-rir-popup');
  if (existing) { existing.remove(); return; }
  const popup = document.createElement('div');
  popup.id = 'll-rir-popup';
  popup.className = 'll-rir-popup';
  popup.innerHTML = `
    <h4>What is RIR?</h4>
    <p><strong style="color:#e6edf3">Reps In Reserve</strong> — how many more reps you could do before failure.</p>
    <ul>
      <li><span>RIR 0</span> — absolute failure, couldn't do one more</li>
      <li><span>RIR 1</span> — one rep left in the tank</li>
      <li><span>RIR 2</span> — two reps left (solid working set)</li>
      <li><span>RIR 3–4</span> — still fairly easy, consider going heavier</li>
    </ul>
  `;
  document.body.appendChild(popup);
  const rect = btn.getBoundingClientRect();
  popup.style.top = (rect.bottom + window.scrollY + 8) + 'px';
  popup.style.left = Math.min(rect.left + window.scrollX, window.innerWidth - 280) + 'px';
  setTimeout(() => {
    document.addEventListener('click', function handler(e) {
      if (!popup.contains(e.target) && e.target !== btn) {
        popup.remove(); document.removeEventListener('click', handler);
      }
    });
  }, 10);
  }

  async function endAdjustmentNow() {
    const original = localStorage.getItem('originalProgramme');
    if (original) localStorage.setItem('generatedProgramme', original);
    localStorage.removeItem('originalProgramme');
    localStorage.removeItem('activeAdjustment');
    await pushProgramme();
    location.reload();
  }

  function renderAdjustmentBanner() {
    const adjustment = JSON.parse(localStorage.getItem('activeAdjustment') || 'null');
    if (!adjustment) return;
    const banner = document.createElement('div');
    banner.style.cssText = 'background:rgba(240,136,62,0.1);border:1px solid rgba(240,136,62,0.3);border-radius:8px;padding:10px 14px;margin-bottom:16px;display:flex;justify-content:space-between;align-items:center;font-size:13px;color:#f0883e;';
    const endLabel = adjustment.isPermanent ? '' : ` · back to normal ${new Date(adjustment.endDate).toLocaleDateString('en-GB',{day:'numeric',month:'short'})}`;
    banner.innerHTML = `<span>⚡ Adjusted for ${adjustment.reason}${endLabel}</span>`;
    if (!adjustment.isPermanent) {
      const endBtn = document.createElement('button');
      endBtn.textContent = 'End now';
      endBtn.style.cssText = 'background:none;border:1px solid #f0883e;color:#f0883e;border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer;';
      endBtn.addEventListener('click', endAdjustmentNow);
      banner.appendChild(endBtn);
    }
    wrap.appendChild(banner);
  }

  function render() {
  wrap.innerHTML = '';
  const prog = getCurrentProgramme();

  if (activeDay === -1) activeDay = getTodayIdx();

  const s = computeStats();
  const unit = getUnit();
  wrap.insertAdjacentHTML('beforeend', `
    <div id="ll-prog-header">
      ${prog ? `<button id="ll-adjust-btn-progress" style="float:right;background:transparent;border:1px solid #58a6ff;color:#58a6ff;font-size:13px;font-weight:600;padding:7px 16px;border-radius:20px;cursor:pointer;font-family:inherit;">⚡ Adjust Programme</button>` : ''}
      <h1>Progress</h1>
      <p>
        <span>${prog ? `Tracking: <strong style="color:#e6edf3">${prog.planTitle}</strong>` : 'Complete the quiz or build a plan to start tracking'}</span>
      </p>
    </div>
    <div id="ll-stats-row">
      <div class="ll-stat-card"><div class="ll-stat-value blue">${s.total}</div><div class="ll-stat-label">Total Sessions</div></div>
      <div class="ll-stat-card"><div class="ll-stat-value green">${s.thisWeek}</div><div class="ll-stat-label">This Week</div></div>
      <div class="ll-stat-card"><div class="ll-stat-value yellow">${s.streak}</div><div class="ll-stat-label">Day Streak</div></div>
      <div class="ll-stat-card"><div class="ll-stat-value">${s.thisMonth}</div><div class="ll-stat-label">This Month</div></div>
    </div>
  `);

  const adjustBtnProgress = document.getElementById('ll-adjust-btn-progress');
  if (adjustBtnProgress) {
    adjustBtnProgress.addEventListener('click', function () {
      localStorage.setItem('ll_open_adjust', '1');
      window.location.href = '/programmes';
    });
  }

  renderAdjustmentBanner();

  if (!prog) {
    wrap.insertAdjacentHTML('beforeend', `<div class="ll-empty">No programme found. <a href="/quiz" style="color:#58a6ff;">Take the quiz</a> or <a href="/build" style="color:#58a6ff;">build a plan</a>.</div>`);
    renderHistory(); return;
  }

  renderDayNav();
  renderSession();
  renderHistory();
  setTimeout(() => updateStickyBar(), 0);
  }

  function renderDayNav() {
  const days = getDays(); const todayIdx = getTodayIdx();
  const maxWeeks = getMaxWeeks();
  const tabs = days.map((day, i) => {
    const abbr = day.day.substring(0,3);
    const done = isDayLogged(i);
    let cls = 'll-day-tab' + (i === activeDay ? ' ll-active' : '') + (done ? ' ll-done' : '');
    return `<button class="${cls}" data-day="${i}">${abbr}${(i === todayIdx && activeWeek === 1) ? ' ·' : ''}</button>`;
  }).join('');

  wrap.insertAdjacentHTML('beforeend', `
    <div id="ll-day-nav">
      <button class="ll-day-nav-arr" id="ll-prev">‹</button>
      <div class="ll-day-tabs">${tabs}</div>
      <button class="ll-day-nav-arr" id="ll-next">›</button>
    </div>
    ${maxWeeks > 1 ? `<div style="display:flex;align-items:center;gap:8px;margin-bottom:16px;">
      <button id="ll-wk-prev" style="background:none;border:1px solid #21262d;border-radius:6px;color:#8b949e;padding:4px 10px;cursor:pointer;font-family:inherit;font-size:12px;" ${activeWeek<=1?'disabled style="opacity:.3;cursor:default"':''}>← Prev week</button>
      <span style="font-size:12px;font-weight:600;color:#8b949e;">Week ${activeWeek} / ${maxWeeks}</span>
      <button id="ll-wk-next" style="background:none;border:1px solid #21262d;border-radius:6px;color:#8b949e;padding:4px 10px;cursor:pointer;font-family:inherit;font-size:12px;" ${activeWeek>=maxWeeks?'disabled style="opacity:.3;cursor:default"':''}>Next week →</button>
         ${(activeWeek !== 1 || activeDay !== todayIdx) ? `<button id="ll-today" style="margin-left:auto;background:none;border:1px solid #58a6ff;border-radius:6px;color:#58a6ff;padding:4px 10px;cursor:pointer;font-family:inherit;font-size:12px;font-weight:600;">Today</button>` : ''}
    </div>` : ''}
  `);

  wrap.querySelectorAll('.ll-day-tab').forEach(btn => {
    btn.addEventListener('click', function() {
      activeDay = parseInt(this.dataset.day);
      setData = {};
      render();
    });
  });

  document.getElementById('ll-prev').addEventListener('click', () => {
    if (activeDay === 0 && activeWeek > 1) { activeWeek--; activeDay = 6; }
    else if (activeDay > 0) { activeDay--; }
    else { activeDay = 6; }
    setData = {}; render();
  });
  document.getElementById('ll-next').addEventListener('click', () => {
    if (activeDay === 6 && activeWeek < maxWeeks) { activeWeek++; activeDay = 0; }
    else if (activeDay < 6) { activeDay++; }
    else { activeDay = 0; }
    setData = {}; render();
  });

  if (maxWeeks > 1) {
    const wkPrev = document.getElementById('ll-wk-prev');
    const wkNext = document.getElementById('ll-wk-next');
    if (wkPrev) wkPrev.addEventListener('click', () => { if (activeWeek > 1) { activeWeek--; setData = {}; render(); } });
    if (wkNext) wkNext.addEventListener('click', () => { if (activeWeek < maxWeeks) { activeWeek++; setData = {}; render(); } });
        const todayBtn = document.getElementById('ll-today');
    if (todayBtn) todayBtn.addEventListener('click', () => { activeWeek = 1; activeDay = getTodayIdx(); setData = {}; render(); });
  }
  }

  function renderSession() {
  const day = getDays()[activeDay];
  const panel = document.createElement('div');

  if (isRest(day)) {
    panel.innerHTML = `<div class="ll-rest-panel"><div>😴 Rest Day</div>Recovery is part of the programme. Take it easy today.</div>`;
    wrap.appendChild(panel); return;
  }

  initSetData(activeDay);
  const logged = isDayLogged(activeDay);
  const preview = activeWeek !== 1;
    
  const hdr = document.createElement('div');
  hdr.className = 'll-session-header';
  hdr.innerHTML = `
    <div>
      <div class="ll-session-title">${day.sessionTitle}</div>
      <div class="ll-session-meta">${day.day} · ${day.exercises.length} exercises</div>
    </div>
       <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end;">
      <button id="ll-last-sess-btn" style="background:transparent;border:1px solid #58a6ff;color:#58a6ff;font-size:13px;font-weight:600;padding:7px 14px;border-radius:20px;cursor:pointer;font-family:inherit;">Last session ↗</button>
      <button class="ll-log-btn ${logged ? 'll-logged' : ''}" id="ll-log-btn" ${preview ? 'disabled style="opacity:.4;cursor:default"' : ''}>${preview ? 'Preview' : (logged ? '✓ Logged Today' : 'Log Session ✓')}</button>
    </div>
  `;
  panel.appendChild(hdr);
  hdr.querySelector('#ll-last-sess-btn').addEventListener('click', () => openLastSession(day.sessionTitle));
    
  if (!logged && !preview) {
    hdr.querySelector('#ll-log-btn').addEventListener('click', () => logSession(activeDay));
  }

  day.exercises.forEach((ex, exIdx) => panel.appendChild(buildExCard(ex, exIdx, activeDay)));
  wrap.appendChild(panel);
  setTimeout(() => updateStickyBar(), 0);
  }

  function updateStickyBar() {
  const bar = document.getElementById('ll-sticky-bar');
  const fillEl = document.getElementById('ll-sticky-fill');
  const countEl = document.getElementById('ll-sticky-count');
  const btn = document.getElementById('ll-sticky-btn');
  const labelEl = document.getElementById('ll-sticky-label');
  if (!bar) return;

  const day = getDays()[activeDay];
  if (!day || isRest(day)) { bar.classList.remove('visible'); return; }
  if (activeWeek !== 1) { bar.classList.remove('visible'); return; }

  const logged = isDayLogged(activeDay);
  bar.classList.add('visible');

  if (logged) {
    if (fillEl) fillEl.style.width = '100%';
    if (countEl) countEl.textContent = 'Logged ✓';
    if (btn) { btn.textContent = '✓ Logged Today'; btn.className = 'll-logged'; btn.onclick = null; }
    return;
  }

  const exCount = day.exercises.length;
  let doneCount = 0;
  if (setData[activeDay]) {
    day.exercises.forEach((ex, ei) => {
      const sets = setData[activeDay][ei] || [];
      if (sets.length > 0 && sets.every(s => s.done)) doneCount++;
    });
  }
  const pct = exCount > 0 ? Math.round((doneCount / exCount) * 100) : 0;

  if (fillEl) fillEl.style.width = pct + '%';
  if (countEl) countEl.textContent = `${doneCount} / ${exCount} exercises`;
  if (labelEl) {
    const firstChild = labelEl.firstChild;
    if (firstChild && firstChild.nodeType === 3) firstChild.textContent = doneCount === exCount && exCount > 0 ? 'All done! Ready to log 🎉' : "Today's session ";
  }
  if (btn) {
    btn.textContent = 'Log Session ✓';
    btn.className = doneCount === exCount && exCount > 0 ? 'ready' : '';
    btn.onclick = () => logSession(activeDay);
  }
  }

  function updateExCardState(dayIdx, exIdx) {
  const sets = setData[dayIdx]?.[exIdx] || [];
  const card = document.getElementById(`card-${dayIdx}-${exIdx}`);
  const summary = document.getElementById(`summary-${dayIdx}-${exIdx}`);
  if (!card) return;
  const doneSets = sets.filter(s => s.done).length;
  if (summary) summary.textContent = `${doneSets}/${sets.length} sets`;
  if (sets.length > 0 && doneSets === sets.length) {
    card.classList.add('ll-ex-complete');
  } else {
    card.classList.remove('ll-ex-complete');
  }
  updateStickyBar();
  }

  function autoCheckSet(sets, si, dayIdx, exIdx, ex) {
  const s = sets[si];
  if (s.editing) return;
  const filled = v => v !== '' && v !== null && v !== undefined;
  const allFilled = filled(s.weight) && filled(s.reps) && filled(s.rir);
  if (allFilled !== !!s.done) {
    s.done = allFilled;
    renderSets(dayIdx, exIdx, sets, ex);
    updateExCardState(dayIdx, exIdx);
    updateStickyBar();
  }
  }

  function buildExCard(ex, exIdx, dayIdx) {
  initSetData(dayIdx);
  const sets = setData[dayIdx]?.[exIdx] || [];
  const last = getLastWeight(ex.name);
  const card = document.createElement('div');
  card.className = 'll-ex-card';
  card.id = `card-${dayIdx}-${exIdx}`;

    const lastEx = getLastExercise(ex.name);
  let lastHintHtml = '';
  if (lastEx) {
    const fmt = s => [s.weight ? toDisplay(s.weight) + unitLabel() : null, s.reps].filter(Boolean).join(' × ') + (s.rir !== '' && s.rir != null ? ' · RIR ' + s.rir : '');
    const lastSet = lastEx.sets[lastEx.sets.length - 1];
    lastHintHtml = `<div class="ll-last-row">
      <button class="ll-last-btn" data-act="show" title="${lastEx.day.substring(0,3)} ${formatDate(lastEx.date)}">Last time: ${fmt(lastSet)}</button>
      <button class="ll-last-btn" data-act="paste">Paste last weight</button>
    </div>
    <div class="ll-last-all" style="display:none">${lastEx.sets.map(s => `<span class="ll-hist-set-pill has-data">${fmt(s)}</span>`).join('')}</div>`;
  }
  card.innerHTML = `
    <div class="ll-ex-card-hdr">
      <div class="ll-ex-card-name">${ex.name}</div>
      <span class="ll-ex-prog-pill">${ex.sets} × ${ex.reps}</span>
      <span class="ll-ex-complete-badge">✓ Done</span>
      <button class="ll-ex-hist-btn" id="hist-btn-${dayIdx}-${exIdx}">History ↗</button>
      <div class="ll-ex-summary" id="summary-${dayIdx}-${exIdx}">${sets.filter(s=>s.done).length}/${sets.length} sets</div>
      <svg class="ll-ex-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="6 9 12 15 18 9"/></svg>
    </div>
    <div class="ll-ex-card-body">
      <div class="ll-po-bar" id="po-${dayIdx}-${exIdx}">
        <div class="ll-po-dot"></div>
        <div class="ll-po-text">Open card to load AI suggestion…</div>
      </div>
      ${lastHintHtml}
      <div class="ll-set-hdrs">
        <div class="ll-set-hdr">Set</div>
        <div class="ll-set-hdr">Weight <span class="ll-unit-toggle" style="margin-left:6px;vertical-align:middle"><button class="ll-unit-btn ${getUnit()==='kg'?'active':''}" data-unit="kg">kg</button><button class="ll-unit-btn ${getUnit()==='lbs'?'active':''}" data-unit="lbs">lbs</button></span></div>
        <div class="ll-set-hdr">Reps</div>
        <div class="ll-set-hdr">RIR <button class="ll-rir-help" id="rir-help-${dayIdx}-${exIdx}">?</button></div>
        <div></div>
      </div>
      <div id="sets-${dayIdx}-${exIdx}"></div>
      <button class="ll-add-set" id="add-set-${dayIdx}-${exIdx}">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Add set
      </button>
    </div>
  `;

  let poLoaded = false;
  card.querySelector('.ll-ex-card-hdr').addEventListener('click', () => {
    card.classList.toggle('open');
    if (card.classList.contains('open') && !poLoaded) {
      poLoaded = true;
      fetchPOSuggestion(ex, document.getElementById(`po-${dayIdx}-${exIdx}`));
    }
  });

  card.querySelector(`#hist-btn-${dayIdx}-${exIdx}`).addEventListener('click', e => {
    e.stopPropagation();
    openExModal(ex.name);
  });
card.querySelectorAll('.ll-last-btn').forEach(b => b.addEventListener('click', e => {
  e.stopPropagation();
  if (b.dataset.act === 'show') {
    const all = card.querySelector('.ll-last-all');
    all.style.display = all.style.display === 'none' ? 'flex' : 'none';
  } else {
    const lx = getLastExercise(ex.name);
    if (!lx) return;
    sets.forEach((s, i) => {
      if (s.done) return;
      s.weight = (lx.sets[i] || lx.sets[lx.sets.length - 1]).weight;
    });
    renderSets(dayIdx, exIdx, sets, ex);
  }
}));
    
  card.querySelector(`#rir-help-${dayIdx}-${exIdx}`).addEventListener('click', function(e) {
    e.stopPropagation();
    showRirPopup(this);
  });

       card.querySelectorAll('.ll-unit-btn').forEach(btn => btn.addEventListener('click', function(e) {
    e.stopPropagation();
    const openIds = [...document.querySelectorAll('.ll-ex-card.open')].map(c => c.id);
    setUnit(this.dataset.unit);
    render();
    openIds.forEach(id => { const c = document.getElementById(id); if (c) c.classList.add('open'); });
  }));
  card.querySelector(`#add-set-${dayIdx}-${exIdx}`).addEventListener('click', function(e) {
    e.stopPropagation();
    const lastSet = sets[sets.length-1] || { weight:'', reps: ex.reps||'', rir:'' };
    sets.push({ weight: lastSet.weight, reps: '', rir:'', done:false });
    renderSets(dayIdx, exIdx, sets, ex);
    updateExCardState(dayIdx, exIdx);
  });

  setTimeout(() => {
    renderSets(dayIdx, exIdx, sets, ex);
    updateExCardState(dayIdx, exIdx);
  }, 0);

  return card;
  }

  function renderSets(dayIdx, exIdx, sets, ex) {
  const container = document.getElementById(`sets-${dayIdx}-${exIdx}`);
  if (!container) return;
  container.innerHTML = '';
  sets.forEach((set, si) => {
    const locked = set.done && !set.editing;
    const ro = locked ? 'readonly' : '';
    const dn = locked ? 'done' : '';
    const row = document.createElement('div');
    row.className = 'll-set-row' + (set.done ? ' ll-set-done-row' : '');
    row.innerHTML = `
      <div class="ll-set-num">${si+1}</div>
      <input class="ll-set-inp ${dn}" type="number" placeholder="${unitLabel()}" value="${toDisplay(set.weight)}" min="0" step="0.5" ${ro} />
      <input class="ll-set-inp ${dn}" type="text" placeholder="${ex.reps||'reps'}" value="${set.reps}" ${ro} />
      <input class="ll-set-inp ${dn}" type="number" placeholder="0-4" value="${set.rir}" min="0" max="10" ${ro} />
      <div class="ll-set-acts">
        ${set.done ? `<button class="ll-set-edit" title="${set.editing ? 'Save changes' : 'Edit set'}">${set.editing ? '✓' : '✎'}</button>` : ''}
        <button class="ll-set-del" title="Remove set">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
    `;
    const [wInp, rInp, rirInp] = row.querySelectorAll('.ll-set-inp');

    wInp.addEventListener('input', () => {
      sets[si].weight = wInp.value === '' ? '' : toKg(parseFloat(wInp.value));
      autoCheckSet(sets, si, dayIdx, exIdx, ex);
    });
    rInp.addEventListener('input', () => {
      sets[si].reps = rInp.value;
      autoCheckSet(sets, si, dayIdx, exIdx, ex);
    });
    rirInp.addEventListener('input', () => {
      sets[si].rir = rirInp.value;
      autoCheckSet(sets, si, dayIdx, exIdx, ex);
    });

    const editBtn = row.querySelector('.ll-set-edit');
    if (editBtn) editBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      if (set.editing) {
        set.editing = false;
        const filled = v => v !== '' && v !== null && v !== undefined;
        set.done = filled(set.weight) && filled(set.reps) && filled(set.rir);
      } else {
        set.editing = true;
      }
      renderSets(dayIdx, exIdx, sets, ex);
      updateExCardState(dayIdx, exIdx);
    });

    row.querySelector('.ll-set-del').addEventListener('click', function(e) {
      e.stopPropagation();
      if (sets.length <= 1) return;
      sets.splice(si, 1);
      renderSets(dayIdx, exIdx, sets, ex);
      updateExCardState(dayIdx, exIdx);
    });

    container.appendChild(row);
  });
  }

  function logSession(dayIdx) {
  const day = getDays()[dayIdx];
  const now = new Date().toISOString();

  const exerciseSnapshot = day.exercises.map((ex, ei) => {
    const sets = (setData[dayIdx]?.[ei] || []).map(s => ({
      weight: s.weight, reps: s.reps, rir: s.rir, done: s.done
    }));
    return { name: ex.name, sets };
  });

  if (setData[dayIdx]) {
    const wl = getWeightLogs();
    day.exercises.forEach((ex, ei) => {
      (setData[dayIdx][ei]||[]).forEach(set => {
        if (set.weight && set.done) {
          if (!wl[ex.name]) wl[ex.name] = [];
          wl[ex.name].push({ date: now, weight: parseFloat(set.weight), reps: set.reps, rir: set.rir });
        }
      });
    });
    saveWeightLogs(wl);
  }
  const logs = getLogs();
  const entry = {
    id: uuid(),
    date: now,
    sessionTitle: day.sessionTitle,
    day: day.day,
    exercises: exerciseSnapshot
  };
  logs.unshift(entry);
  saveLogs(logs);
  pushSession(entry);
  showToast();
  render();
  }

  function renderHistory() {
  const logs = getLogs();
  const section = document.createElement('div');
  section.id = 'll-history';

  const hdr = document.createElement('div');
  hdr.className = 'll-section-hdr';
  const chevronSvg = `<svg class="ll-section-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="6 9 12 15 18 9"/></svg>`;
  hdr.innerHTML = `
    <div class="ll-section-hdr-left">
      <div class="ll-section-title">Session History</div>
      <div class="ll-section-sub">Every session you've logged</div>
    </div>
    <div class="ll-section-hdr-right">
      <span class="ll-section-pill">${logs.length} session${logs.length !== 1 ? 's' : ''}</span>
      ${chevronSvg}
    </div>
  `;
  section.appendChild(hdr);

  const body = document.createElement('div');
  body.className = 'll-section-body collapsed';

  const chevron = hdr.querySelector('.ll-section-chevron');
  hdr.addEventListener('click', () => {
    const isCollapsed = body.classList.contains('collapsed');
    body.classList.toggle('collapsed', !isCollapsed);
    chevron.classList.toggle('open', isCollapsed);
  });

  if (logs.length === 0) {
    body.insertAdjacentHTML('beforeend', '<div class="ll-empty">No sessions logged yet. Complete your first workout to start building your history.</div>');
    section.appendChild(body);
    wrap.appendChild(section);
    return;
  }

  const table = document.createElement('div');
  table.className = 'll-hist-table';

  table.insertAdjacentHTML('beforeend', `
    <div class="ll-hist-table-head">
      <div class="ll-hist-th">Day</div>
      <div class="ll-hist-th">Session</div>
      <div class="ll-hist-th">Date</div>
      <div class="ll-hist-th">Volume</div>
      <div></div>
      <div></div>
    </div>
  `);

  const groups = groupByWeek(logs);

  groups.forEach(({ label, entries }) => {
    const weekRow = document.createElement('div');
    weekRow.className = 'll-hist-week-row';
    weekRow.innerHTML = `<span>${label}</span>`;
    table.appendChild(weekRow);

    entries.forEach((log) => {
      const globalIdx = logs.indexOf(log);
      const exCount = log.exercises ? log.exercises.length : 0;
      const totalSets = log.exercises
        ? log.exercises.reduce((acc, ex) => acc + (ex.sets || []).filter(s => s.done).length, 0)
        : 0;

      const row = document.createElement('div');
      row.className = 'll-hist-session-row';
      row.innerHTML = `
        <div class="ll-hist-td-day">${log.day.substring(0, 3)}</div>
        <div class="ll-hist-td-name">${log.sessionTitle}</div>
        <div class="ll-hist-td-date">${formatDate(log.date)}</div>
        <div class="ll-hist-td-meta">${exCount > 0 ? `${exCount} ex · ${totalSets} sets` : '—'}</div>
        ${exCount > 0
          ? `<svg class="ll-hist-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="6 9 12 15 18 9"/></svg>`
          : `<div></div>`}
        <button class="ll-hist-del" data-i="${globalIdx}" title="Delete session">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      `;

      const detail = document.createElement('div');
      detail.className = 'll-hist-detail';
      detail.innerHTML = buildHistoryBody(log);

      if (exCount > 0) {
        row.addEventListener('click', function(e) {
          if (e.target.closest('.ll-hist-del')) return;
          const isOpen = row.classList.contains('open');
          row.classList.toggle('open', !isOpen);
          detail.classList.toggle('open', !isOpen);
        });
      }

      row.querySelector('.ll-hist-del').addEventListener('click', function(e) {
        e.stopPropagation();
        const all = getLogs();
        const removed = all.splice(parseInt(this.dataset.i), 1)[0];
        saveLogs(all);
        rebuildWeightLogs(all);
        render();
        if (removed && sb && sbUser) {
          sb.from('session_logs').delete().eq('id', removed.id).eq('user_id', sbUser.id)
            .then(r => { if (r.error) console.error('Delete failed:', r.error); });
          sb.from('weight_logs').delete().eq('user_id', sbUser.id).eq('logged_at', removed.date)
            .then(r => { if (r.error) console.error('Delete failed:', r.error); });
        }
      });

      table.appendChild(row);
      table.appendChild(detail);
    });
  });

  body.appendChild(table);
  section.appendChild(body);
  wrap.appendChild(section);
  }

  function buildHistoryBody(log) {
  if (!log.exercises || log.exercises.length === 0) return '';
  return log.exercises.map(ex => {
    const doneSets = (ex.sets||[]).filter(s => s.done);
    const pills = doneSets.length > 0
      ? doneSets.map(s => {
          const w = s.weight ? `${toDisplay(s.weight)}${unitLabel()}` : null;
          const r = s.reps || null;
          const label = [w, r].filter(Boolean).join(' × ');
          return label
            ? `<span class="ll-hist-set-pill has-data">${label}</span>`
            : `<span class="ll-hist-set-pill">logged</span>`;
        }).join('')
      : `<span class="ll-hist-no-data">No set data recorded</span>`;
    return `
      <div class="ll-hist-ex-row">
        <div style="flex:1">
          <div class="ll-hist-ex-name">${ex.name}</div>
          <div class="ll-hist-sets-list">${pills}</div>
        </div>
      </div>
    `;
  }).join('');
  }

  function groupByWeek(logs) {
  const now = new Date(); now.setHours(0,0,0,0);
  const getWeekStart = d => {
    const x = new Date(d); x.setHours(0,0,0,0);
    const day = x.getDay(); x.setDate(x.getDate() - (day === 0 ? 6 : day - 1));
    return x.getTime();
  };
  const thisWeekStart = getWeekStart(now);
  const lastWeekStart = thisWeekStart - 7*86400000;

  const buckets = {};
  logs.forEach(log => {
    const ws = getWeekStart(new Date(log.date));
    if (!buckets[ws]) buckets[ws] = [];
    buckets[ws].push(log);
  });

  return Object.keys(buckets).sort((a,b) => b-a).map(ws => {
    const wsNum = parseInt(ws);
    let label;
    if (wsNum === thisWeekStart) label = 'This Week';
    else if (wsNum === lastWeekStart) label = 'Last Week';
    else {
      const weeksAgo = Math.round((thisWeekStart - wsNum) / (7*86400000));
      label = `${weeksAgo} weeks ago`;
    }
    return { label, entries: buckets[ws] };
  });
  }

  function drawWeightLine(area, entries) {
  const data = entries.slice(-12);
  if (data.length < 1) { area.innerHTML = `<div class="ll-empty" style="padding:20px 0;">No weight data yet.</div>`; return; }
  if (data.length === 1) {
    const d = data[0];
    area.innerHTML = `<div style="font-size:13px;color:#8b949e;padding:16px 0;">Only one entry so far — <strong style="color:#e6edf3">${toDisplay(d.weight)}${unitLabel()}</strong> on ${formatDate(d.date)}. Log again to see a trend.</div>`;
    return;
  }
  const displayData = data.map(d => ({ ...d, dw: parseFloat(toDisplay(d.weight)) }));
  const maxW = Math.max(...displayData.map(d => d.dw));
  const minW = Math.min(...displayData.map(d => d.dw));
  const range = maxW - minW || 1;
  const W = 100, H = 120, pX = 6, pY = 10;
  const pts = displayData.map((d, i) => ({
    x: pX + (i / (displayData.length - 1)) * (W - pX * 2),
    y: pY + (1 - (d.dw - minW) / range) * (H - pY * 2),
    ...d
  }));
  const pathD = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
  const areaD = `${pathD} L ${pts[pts.length-1].x} ${H} L ${pts[0].x} ${H} Z`;
  const dots = pts.map(p => `<circle cx="${p.x}" cy="${p.y}" r="2.5" fill="#58a6ff" stroke="#161b22" stroke-width="1.5"><title>${p.dw}${unitLabel()} — ${formatDate(p.date)}</title></circle>`).join('');
  const gain = displayData[displayData.length-1].dw - displayData[0].dw;
  const gainStr = gain > 0
    ? `<span style="color:#3fb950">+${gain.toFixed(1)}${unitLabel()} ↑</span>`
    : gain < 0
    ? `<span style="color:#f85149">${gain.toFixed(1)}${unitLabel()} ↓</span>`
    : `<span style="color:#8b949e">no change</span>`;
  area.innerHTML = `
    <svg viewBox="0 0 ${W} ${H + 12}" style="width:100%;height:150px;overflow:visible;">
      <defs><linearGradient id="llg${pts.length}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#58a6ff" stop-opacity="0.15"/><stop offset="100%" stop-color="#58a6ff" stop-opacity="0"/></linearGradient></defs>
      <path d="${areaD}" fill="url(#llg${pts.length})"/>
      <path d="${pathD}" fill="none" stroke="#58a6ff" stroke-width="1.5" stroke-linejoin="round"/>
      ${dots}
      <text x="${pts[0].x}" y="${H+11}" text-anchor="middle" font-size="7" fill="#8b949e">${formatDate(data[0].date)}</text>
      <text x="${pts[pts.length-1].x}" y="${H+11}" text-anchor="middle" font-size="7" fill="#8b949e">${formatDate(data[data.length-1].date)}</text>
    </svg>
    <div style="font-size:12px;color:#8b949e;margin-top:2px;">
      <strong style="color:#e6edf3">${displayData[0].dw}${unitLabel()}</strong> → <strong style="color:#e6edf3">${displayData[displayData.length-1].dw}${unitLabel()}</strong> &nbsp;${gainStr}
    </div>`;
  }

  function drawVolumeBars(area, exName) {
  const logs = getLogs();
  const getWeekStart = d => {
    const x = new Date(d); x.setHours(0,0,0,0);
    const day = x.getDay(); x.setDate(x.getDate() - (day === 0 ? 6 : day - 1));
    return x.getTime();
  };
  const now = new Date(); now.setHours(0,0,0,0);
  const thisWeekStart = getWeekStart(now);

  const weekMap = {};
  logs.forEach(log => {
    const ws = getWeekStart(new Date(log.date));
    if (!log.exercises) return;
    log.exercises.forEach(ex => {
      if (ex.name !== exName) return;
      const sets = (ex.sets || []).filter(s => s.done).length;
      weekMap[ws] = (weekMap[ws] || 0) + sets;
    });
  });

  const weeks = Object.keys(weekMap).map(Number).sort((a, b) => a - b).slice(-8);
  if (weeks.length === 0) {
    area.innerHTML = `<div class="ll-empty" style="padding:20px 0;">No logged sets for this exercise yet.</div>`;
    return;
  }

  const values = weeks.map(w => weekMap[w]);
  const maxVal = Math.max(...values) || 1;
  const barW = 10, gap = 5;
  const chartW = weeks.length * (barW + gap) - gap;
  const H = 80, labelH = 18;
  const totalW = Math.max(chartW, 60);

  const bars = weeks.map((ws, i) => {
    const v = values[i];
    const barH = Math.max(2, (v / maxVal) * H);
    const x = i * (barW + gap);
    const y = H - barH;
    const weeksAgo = Math.round((thisWeekStart - ws) / (7 * 86400000));
    const lbl = weeksAgo === 0 ? 'This' : weeksAgo === 1 ? 'Last' : `W-${weeksAgo}`;
    return `
      <rect x="${x}" y="${y}" width="${barW}" height="${barH}" rx="3" fill="${weeksAgo === 0 ? '#3fb950' : '#58a6ff'}" opacity="0.8"/>
      <text x="${x + barW/2}" y="${H + 13}" text-anchor="middle" font-size="7" fill="#8b949e">${lbl}</text>
      <text x="${x + barW/2}" y="${y - 3}" text-anchor="middle" font-size="7" fill="#8b949e">${v}</text>
    `;
  }).join('');

  area.innerHTML = `
    <svg viewBox="0 0 ${totalW} ${H + labelH}" style="width:100%;max-width:${totalW * 5}px;height:130px;overflow:visible;">
      ${bars}
    </svg>
    <div style="font-size:12px;color:#8b949e;margin-top:4px;">Sets logged per week · green = current week</div>
  `;
  }

  render();

})();
