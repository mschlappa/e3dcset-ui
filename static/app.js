const state = {
  chart: null,
  range: '30',
};

const elements = {
  soh: document.querySelector('#sohValue'),
  rsoc: document.querySelector('#rsocValue'),
  cycles: document.querySelector('#cyclesValue'),
  timestamp: document.querySelector('#lastTimestamp'),
  warning: document.querySelector('#warning'),
  healthBadge: document.querySelector('#healthBadge'),
  measureButton: document.querySelector('#measureButton'),
  buttonSpinner: document.querySelector('#buttonSpinner'),
  buttonText: document.querySelector('#buttonText'),
  measureError: document.querySelector('#measureError'),
  emptyState: document.querySelector('#emptyState'),
  recentRows: document.querySelector('#recentRows'),
};

function formatPercent(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '--';
  return `${Number(value).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`;
}

function formatNumber(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '--';
  return Number(value).toLocaleString('de-DE');
}

function formatDate(value) {
  if (!value) return '--';
  return new Date(value).toLocaleString('de-DE', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
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

function dateRange() {
  if (state.range === 'all') return '';
  const from = new Date();
  from.setDate(from.getDate() - Number(state.range));
  return `?from=${from.toISOString().slice(0, 10)}`;
}

function updateLatest(payload) {
  const latest = payload.measurement;
  if (!latest) {
    elements.soh.textContent = '--';
    elements.rsoc.textContent = '--';
    elements.cycles.textContent = '--';
    elements.timestamp.textContent = 'Noch keine Messung';
  } else {
    elements.soh.textContent = formatPercent(latest.soh);
    elements.rsoc.textContent = formatPercent(latest.rsoc);
    elements.cycles.textContent = formatNumber(latest.charge_cycles);
    elements.timestamp.textContent = `Letzte Messung: ${formatDate(latest.ts)}`;
  }

  if (payload.last_error) {
    elements.warning.textContent = `Letzte Messung fehlgeschlagen (${formatDate(payload.last_error.ts)}): ${payload.last_error.error}`;
    elements.warning.classList.remove('hidden');
  } else {
    elements.warning.classList.add('hidden');
  }
}

function palette(index) {
  const colors = ['#175E54', '#5E7CE2', '#D08C3F', '#8A5A83', '#557A46', '#B85042'];
  return colors[index % colors.length];
}

function renderChart(history) {
  const points = history.points || [];
  elements.emptyState.classList.toggle('hidden', points.length > 0);

  const labels = points.map((point) => formatDate(point.ts));
  const values = points.flatMap((point) => [
    point.soh,
    ...(point.dcbs || []),
  ]).filter((value) => value !== null && value !== undefined);

  const minValue = values.length ? Math.max(0, Math.floor(Math.min(...values) - 2)) : 80;
  const maxValue = values.length ? Math.min(100, Math.ceil(Math.max(...values) + 1)) : 100;
  const showPoints = points.length <= 60;

  const datasets = [{
    label: 'Gesamt-SOH',
    data: points.map((point) => point.soh),
    borderColor: '#175E54',
    backgroundColor: 'rgba(23, 94, 84, 0.12)',
    borderWidth: 3,
    pointRadius: showPoints ? 3 : 0,
    tension: 0.25,
  }];

  for (let index = 0; index < history.dcb_count; index += 1) {
    datasets.push({
      label: `DCB ${index}`,
      data: points.map((point) => (point.dcbs || [])[index] ?? null),
      borderColor: palette(index + 1),
      backgroundColor: 'transparent',
      borderWidth: 2,
      pointRadius: showPoints ? 2 : 0,
      tension: 0.25,
    });
  }

  if (state.chart) {
    state.chart.destroy();
  }

  state.chart = new Chart(document.querySelector('#sohChart'), {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: 'index' },
      plugins: {
        legend: { labels: { usePointStyle: true } },
        tooltip: {
          callbacks: {
            label: (context) => `${context.dataset.label}: ${formatPercent(context.parsed.y)}`,
          },
        },
      },
      scales: {
        y: {
          min: minValue,
          max: maxValue,
          ticks: { callback: (value) => `${value} %` },
          grid: { color: 'rgba(28, 45, 43, 0.08)' },
        },
        x: {
          grid: { display: false },
        },
      },
    },
  });
}

function renderRecent(rows) {
  const measurements = rows.measurements || [];
  if (!measurements.length) {
    elements.recentRows.innerHTML = '<tr><td colspan="5">Noch keine Messungen.</td></tr>';
    return;
  }
  elements.recentRows.innerHTML = measurements.map((item) => {
    const dcbs = (item.dcbs || [])
      .map((dcb) => `DCB ${dcb.dcb_index}: ${formatPercent(dcb.soh)}`)
      .join(', ');
    const statusClass = Number(item.ok) === 1 ? '' : 'failed';
    const soh = Number(item.ok) === 1 ? formatPercent(item.soh) : (item.error || 'Fehler');
    return `
      <tr class="${statusClass}">
        <td>${formatDate(item.ts)}</td>
        <td>${item.source || '--'}</td>
        <td>${soh}</td>
        <td>${dcbs || '--'}</td>
        <td>${formatNumber(item.charge_cycles)}</td>
      </tr>
    `;
  }).join('');
}

async function refresh() {
  const [latest, history, recent, health] = await Promise.all([
    fetchJson('/api/latest'),
    fetchJson(`/api/history${dateRange()}`),
    fetchJson('/api/recent'),
    fetchJson('/api/health'),
  ]);
  updateLatest(latest);
  renderChart(history);
  renderRecent(recent);
  elements.healthBadge.textContent = health.e3dcset_bin_executable ? 'Bereit' : 'Binary prüfen';
  elements.healthBadge.classList.toggle('warn', !health.e3dcset_bin_executable);
}

async function measureNow() {
  elements.measureButton.disabled = true;
  elements.buttonSpinner.classList.remove('hidden');
  elements.buttonText.textContent = 'Messe...';
  elements.measureError.textContent = '';
  try {
    await fetchJson('/api/measure', { method: 'POST' });
    await refresh();
  } catch (error) {
    elements.measureError.textContent = error.message;
    await refresh().catch(() => {});
  } finally {
    elements.measureButton.disabled = false;
    elements.buttonSpinner.classList.add('hidden');
    elements.buttonText.textContent = 'Jetzt messen';
  }
}

document.querySelectorAll('.range-control button').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.range-control button').forEach((item) => item.classList.remove('active'));
    button.classList.add('active');
    state.range = button.dataset.range;
    refresh().catch((error) => {
      elements.measureError.textContent = error.message;
    });
  });
});

elements.measureButton.addEventListener('click', measureNow);

refresh().catch((error) => {
  elements.healthBadge.textContent = 'Fehler';
  elements.healthBadge.classList.add('warn');
  elements.measureError.textContent = error.message;
});
