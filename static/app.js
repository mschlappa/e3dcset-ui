const state = {
  chart: null,
  range: 'all',
};

const el = {
  systemTag: document.querySelector('#systemTag'),
  soh: document.querySelector('#sohWert'),
  rsoc: document.querySelector('#rsocWert'),
  cycles: document.querySelector('#zyklenWert'),
  dcbChips: document.querySelector('#dcbChips'),
  timestamp: document.querySelector('#letzteMessung'),
  warning: document.querySelector('#warnung'),
  button: document.querySelector('#messenBtn'),
  buttonLabel: document.querySelector('#messenLabel'),
  measureError: document.querySelector('#measureError'),
  emptyState: document.querySelector('#emptyState'),
  tableHead: document.querySelector('#tableHead'),
  tableBody: document.querySelector('#tabelleBody'),
  footer: document.querySelector('#footerInfo'),
};

function fmtPercent(value, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '--';
  return Number(value).toLocaleString('de-DE', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function fmtPercentWithUnit(value, digits = 1) {
  const formatted = fmtPercent(value, digits);
  return formatted === '--' ? '--' : `${formatted} %`;
}

function fmtNumber(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '--';
  return Number(value).toLocaleString('de-DE');
}

function fmtDate(value) {
  if (!value) return '--';
  return new Date(value).toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function sourceBadge(source) {
  const normalized = source === 'manual' ? 'manuell' : 'timer';
  const klass = source === 'manual' ? 'badge manuell' : 'badge';
  return `<span class="${klass}">${normalized}</span>`;
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload.detail || payload;
    throw new Error(detail.error || detail.detail || payload.error || `HTTP ${response.status}`);
  }
  return payload;
}

function historyQuery() {
  if (state.range === 'all') return '';
  const from = new Date();
  from.setDate(from.getDate() - Number(state.range));
  return `?from=${from.toISOString().slice(0, 10)}`;
}

function updateLatest(payload) {
  const latest = payload.measurement;
  if (!latest) {
    el.soh.textContent = '--';
    el.rsoc.textContent = '--';
    el.cycles.textContent = '--';
    el.dcbChips.innerHTML = '<span class="chip">keine DCB-Daten</span>';
    el.timestamp.textContent = 'noch keine';
    return;
  }

  el.soh.textContent = fmtPercent(latest.soh, 1);
  el.rsoc.textContent = fmtPercentWithUnit(latest.rsoc, 1);
  el.cycles.textContent = fmtNumber(latest.charge_cycles);
  el.timestamp.innerHTML = `${fmtDate(latest.ts)} <span class="quelle">(${latest.source === 'manual' ? 'manuell' : 'timer'})</span>`;
  el.systemTag.textContent = `Modul ${latest.module_index ?? 0} · ${(latest.dcbs || []).length} Zellblöcke`;
  el.dcbChips.innerHTML = (latest.dcbs || []).length
    ? latest.dcbs.map((dcb) => (
      `<span class="chip">DCB ${dcb.dcb_index} · <b>${fmtPercentWithUnit(dcb.soh, 1)}</b></span>`
    )).join('')
    : '<span class="chip">keine DCB-Daten</span>';

  if (payload.last_error) {
    el.warning.textContent = `Letzte Messung fehlgeschlagen (${fmtDate(payload.last_error.ts)}): ${payload.last_error.error}`;
    el.warning.classList.add('sichtbar');
  } else {
    el.warning.classList.remove('sichtbar');
  }
}

function dcbColor(index) {
  const colors = ['#4C8F84', '#93B8B1', '#5E7CE2', '#D08C3F', '#8A5A83', '#557A46'];
  return colors[index % colors.length];
}

function renderChart(history) {
  const points = history.points || [];
  el.emptyState.classList.toggle('sichtbar', points.length === 0);

  const labels = points.map((point) => new Date(point.ts).toLocaleDateString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
  }));
  const values = points.flatMap((point) => [point.soh, ...(point.dcbs || [])])
    .filter((value) => value !== null && value !== undefined);
  const yMin = values.length ? Math.max(0, Math.floor(Math.min(...values)) - 1) : 80;
  const showPoints = points.length < 60;

  const datasets = [{
    label: 'Gesamt-SOH',
    data: points.map((point) => point.soh),
    borderColor: '#175E54',
    backgroundColor: '#175E54',
    borderWidth: 2.5,
    pointRadius: showPoints ? 2.5 : 0,
    tension: 0.25,
  }];

  for (let index = 0; index < (history.dcb_count || 0); index += 1) {
    datasets.push({
      label: `DCB ${index}`,
      data: points.map((point) => (point.dcbs || [])[index] ?? null),
      borderColor: dcbColor(index),
      backgroundColor: dcbColor(index),
      borderWidth: 1.25,
      borderDash: [5, 4],
      pointRadius: 0,
      tension: 0.25,
    });
  }

  if (state.chart) state.chart.destroy();
  state.chart = new Chart(document.querySelector('#chart'), {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            usePointStyle: true,
            pointStyle: 'line',
            color: '#6B7773',
            padding: 18,
          },
        },
        tooltip: {
          backgroundColor: '#0F433C',
          callbacks: {
            label: (context) => ` ${context.dataset.label}: ${fmtPercentWithUnit(context.parsed.y, 2)}`,
          },
        },
      },
      scales: {
        y: {
          min: yMin,
          max: 100,
          ticks: { callback: (value) => `${fmtPercent(value, 1)} %` },
          grid: { color: '#EDF1F0' },
        },
        x: {
          ticks: { maxTicksLimit: 8 },
          grid: { display: false },
        },
      },
    },
  });
}

function maxDcbCount(measurements) {
  return measurements.reduce((max, item) => Math.max(max, (item.dcbs || []).length), 0);
}

function renderRecent(payload) {
  const measurements = payload.measurements || [];
  const dcbCount = maxDcbCount(measurements);

  const dcbHeaders = Array.from({ length: dcbCount }, (_, index) => `<th>DCB ${index}</th>`).join('');
  el.tableHead.innerHTML = `<tr><th>Datum</th><th>Quelle</th><th>SOH</th>${dcbHeaders}<th>Zyklen</th></tr>`;

  if (!measurements.length) {
    el.tableBody.innerHTML = '<tr><td colspan="6" class="fehltext">Noch keine Messungen.</td></tr>';
    return;
  }

  el.tableBody.innerHTML = measurements.map((item) => {
    if (Number(item.ok) !== 1) {
      return `
        <tr class="fehler">
          <td>${fmtDate(item.ts)}</td>
          <td class="quelle-zelle">${sourceBadge(item.source)}</td>
          <td colspan="${dcbCount + 2}" class="fehltext">Fehlgeschlagen: ${item.error || 'unbekannter Fehler'}</td>
        </tr>
      `;
    }

    const dcbCells = Array.from({ length: dcbCount }, (_, index) => {
      const dcb = (item.dcbs || [])[index];
      return `<td>${dcb ? fmtPercentWithUnit(dcb.soh, 2) : '--'}</td>`;
    }).join('');

    return `
      <tr>
        <td>${fmtDate(item.ts)}</td>
        <td class="quelle-zelle">${sourceBadge(item.source)}</td>
        <td>${fmtPercentWithUnit(item.soh, 2)}</td>
        ${dcbCells}
        <td>${fmtNumber(item.charge_cycles)}</td>
      </tr>
    `;
  }).join('');
}

function updateFooter(health) {
  const count = health.measurement_count ?? 0;
  el.footer.textContent = `e3dcset · SQLite: ${health.db_path} · ${count} Messungen`;
}

async function refresh() {
  const [latest, history, recent, health] = await Promise.all([
    fetchJson('/api/latest'),
    fetchJson(`/api/history${historyQuery()}`),
    fetchJson('/api/recent'),
    fetchJson('/api/health'),
  ]);
  updateLatest(latest);
  renderChart(history);
  renderRecent(recent);
  updateFooter(health);
  if (!health.e3dcset_bin_executable) {
    el.warning.textContent = `e3dcset-Binary nicht ausführbar: ${health.e3dcset_bin_resolved}`;
    el.warning.classList.add('sichtbar');
  }
}

async function measureNow() {
  el.button.disabled = true;
  el.button.classList.add('laeuft');
  el.buttonLabel.textContent = 'Messe ...';
  el.measureError.textContent = '';
  try {
    await fetchJson('/api/measure', { method: 'POST' });
    await refresh();
  } catch (error) {
    el.measureError.textContent = error.message;
    await refresh().catch(() => {});
  } finally {
    el.button.disabled = false;
    el.button.classList.remove('laeuft');
    el.buttonLabel.textContent = 'Jetzt messen';
  }
}

document.querySelector('#bereichSchalter').addEventListener('click', (event) => {
  if (event.target.tagName !== 'BUTTON') return;
  document.querySelectorAll('.bereich-schalter button').forEach((button) => {
    button.classList.remove('aktiv');
  });
  event.target.classList.add('aktiv');
  state.range = event.target.dataset.range;
  refresh().catch((error) => {
    el.measureError.textContent = error.message;
  });
});

el.button.addEventListener('click', measureNow);

refresh().catch((error) => {
  el.warning.textContent = error.message;
  el.warning.classList.add('sichtbar');
});
