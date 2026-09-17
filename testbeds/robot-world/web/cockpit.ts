import type { DiagnosticChannel, DiagnosticEvent, Diagnostics } from '../src/diagnostics.ts';
import type { LabRuntime } from '../src/runtime.ts';
import './cockpit.css';

type Batch = ReturnType<Diagnostics['read']> & { observation: LabRuntime['lastObservation']; controller: LabRuntime['controller'] };
type WorldState = ReturnType<LabRuntime['inspect']>;
const channels: DiagnosticChannel[] = ['controller', 'protocol', 'sensors', 'bridge'];
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') {
  const el = document.createElement(tag); el.className = className; el.textContent = text; return el;
}
const definitions = {
  controller: { title: 'Controller / agent', icon: '01', hint: 'Decisions, reasoning summaries, messages & tool calls', filters: [['all', 'All activity'], ['summary', 'Reasoning summaries'], ['tool', 'Tool calls / output'], ['request', 'Decision requests'], ['error', 'Errors']] },
  protocol: { title: 'Raw communications', icon: '02', hint: 'Actual protocol frames and decoded payloads', filters: [['all', 'TX + RX'], ['TX', 'TX · commands'], ['RX', 'RX · telemetry']] },
  sensors: { title: 'Robot observations', icon: '03', hint: 'Received samples · acquisition and receipt clocks', filters: [['all', 'All sensors'], ['odometry', 'Odometry'], ['range', 'Range ring'], ['depth', 'Depth grid'], ['invalid', 'Invalid / stale']] },
  bridge: { title: 'Nervelet / execution', icon: '04', hint: 'Commands, receipts, acknowledgements & jobs', filters: [['all', 'All bridge activity'], ['job', 'Job transitions'], ['observation', 'Observation history'], ['admission', 'Admissions'], ['bundle', 'Latest delivered observation']] }
};
type Pane = { root: HTMLElement; status: HTMLElement; list: HTMLElement; detail: HTMLElement; meta: HTMLElement;
  filter: HTMLSelectElement; latest: HTMLButtonElement; pinned?: DiagnosticEvent; signature: string; };

export function createCockpit() {
  const panes = {} as Record<DiagnosticChannel, Pane>;
  let history: Record<DiagnosticChannel, DiagnosticEvent[]> = { controller: [], protocol: [], sensors: [], bridge: [] };
  let cursor = 0, runId = '', pending = false, frozen = false, search = '', batch: Batch | undefined, state: WorldState | undefined;
  const discarded = { controller: 0, protocol: 0, sensors: 0, bridge: 0 };
  for (const channel of channels) {
    const config = definitions[channel], root = node('section', `cockpit-pane ${channel}`); root.id = `pane-${channel}`;
    root.setAttribute('aria-label', config.title);
    const heading = node('div', 'pane-heading'); heading.append(node('span', 'pane-number', config.icon), node('h3', '', config.title));
    const expand = node('button', 'pane-expand', '⛶'); expand.title = `Expand ${config.title}`; expand.setAttribute('aria-label', expand.title);
    expand.onclick = () => {
      const expanded = root.classList.toggle('expanded'); $('cockpit-panels').classList.toggle('has-expanded', expanded);
      expand.title = `${expanded ? 'Restore' : 'Expand'} ${config.title}`; expand.setAttribute('aria-label', expand.title);
    }; heading.append(expand);
    const tools = node('div', 'pane-tools'), filter = node('select'); filter.setAttribute('aria-label', `${config.title} filter`);
    for (const [value, label] of config.filters) { const option = node('option', '', label); option.value = value!; filter.append(option); }
    const latest = node('button', '', 'Latest'); latest.setAttribute('aria-label', `Follow latest ${config.title}`);
    const status = node('span', 'pane-status', '—'); tools.append(filter, latest, status);
    const list = node('div', 'log-list'); list.setAttribute('aria-label', `${config.title} events`);
    const meta = node('div', 'detail-meta', config.hint), detail = node('pre', 'raw-detail', 'Waiting for captured data…'); detail.tabIndex = 0;
    root.append(heading, tools, list, meta, detail); $('cockpit-panels').append(root);
    const pane = { root, status, list, detail, meta, filter, latest, signature: '' }; panes[channel] = pane;
    filter.onchange = () => { panes[channel].pinned = undefined; render(); };
    latest.onclick = () => { panes[channel].pinned = undefined; render(); };
  }
  function render() {
    for (const channel of channels) {
      const p = panes[channel], filter = p.filter.value;
      const filtered = history[channel].filter(e => (filter === 'all' || e.kind === filter || (channel === 'sensors' && (e.data as { sensor?: string })?.sensor === filter)) &&
        (!search || `${e.label} ${JSON.stringify(e.data)}`.toLowerCase().includes(search)));
      const rows = filtered.slice(-45).reverse(), chosen = p.pinned ?? rows[0];
      // Only replace the list when it changes; preserve pinned payloads and scroll position.
      const signature = `${rows.map(e => e.id).join(',')}:${p.pinned?.id}:${filter}`;
      if (signature !== p.signature) {
        const scroll = p.list.scrollTop; p.list.replaceChildren(); p.signature = signature;
        for (const event of rows) {
          const row = node('button', `log-row ${event.kind === 'error' || event.kind === 'invalid' ? 'problem' : ''}${p.pinned?.id === event.id ? ' selected' : ''}`);
          row.append(node('time', '', `S ${(event.simMs / 1000).toFixed(2)}`), node('span', '', event.label));
          row.title = `#${event.id} · W ${(event.wallMs / 1000).toFixed(3)} s`; row.onclick = () => { p.pinned = event; render(); };
          p.list.append(row);
        }
        if (!rows.length) p.list.append(node('div', 'log-empty', channel === 'controller' && filter === 'summary' ? 'Summaries appear when a native controller emits them.' : filter === 'bundle' ? 'Showing the exact latest captured delivery below.' : 'No matching events captured.'));
        if (p.pinned) p.list.scrollTop = scroll;
      }
      p.latest.classList.toggle('active', !p.pinned); p.latest.textContent = p.pinned ? 'Unpin / latest' : 'Following';
      p.status.textContent = channel === 'controller' ? batch?.controller.status ?? 'idle' : channel === 'protocol' ? state?.scenario.robot.protocol ?? '—' : `${history[channel].length} buffered`;
      const delivered = channel === 'bridge' && filter === 'bundle' ? batch?.observation : null;
      p.meta.textContent = delivered ? `${delivered.source} · S ${(delivered.simMs / 1000).toFixed(3)} s${delivered.truncated ? ' · TRUNCATED' : ''}` : chosen ?
        `${p.pinned ? 'PINNED · ' : ''}#${chosen.id} · S ${(chosen.simMs / 1000).toFixed(3)} / W ${(chosen.wallMs / 1000).toFixed(3)} s${chosen.truncated ? ' · TRUNCATED' : ''}` : definitions[channel].hint;
      const content = delivered ? JSON.stringify(delivered.data, null, 2) : chosen ? JSON.stringify(chosen.data, null, 2) : 'No data in this view yet.';
      if (p.detail.textContent !== content) p.detail.textContent = content;
    }
    const lost = batch ? Object.values(batch.dropped).reduce((a, b) => a + b, 0) : 0;
    const aged = Object.values(discarded).reduce((a, b) => a + b, 0);
    $('diagnostic-health').textContent = `Run ${runId.slice(0, 8) || '—'} · ${batch?.latest ?? 0} captured · ${lost} server evictions · ${aged} browser evictions${batch?.hasMore ? ' · catching up' : ''}`;
  }
  $('log-search').oninput = () => { search = $<HTMLInputElement>('log-search').value.trim().toLowerCase(); render(); };
  $('freeze-cockpit').onclick = () => {
    frozen = !frozen; $('freeze-cockpit').textContent = frozen ? 'Resume inspector' : 'Freeze inspector';
    $('capture-status').textContent = frozen ? 'FROZEN · WORLD CONTINUES' : 'LIVE'; $('capture-status').classList.toggle('frozen', frozen);
    if (!frozen) render();
  };
  async function poll() {
    if (pending || frozen) return; pending = true;
    try {
      const response = await fetch(`/api/diagnostics?after=${cursor}&runId=${encodeURIComponent(runId)}`);
      if (!response.ok) throw new Error('Diagnostic stream disconnected');
      const next: Batch = await response.json();
      if (frozen) return;
      if (next.reset || next.runId !== runId) {
        history = { controller: [], protocol: [], sensors: [], bridge: [] };
        for (const c of channels) { panes[c].pinned = undefined; panes[c].signature = ''; discarded[c] = 0; }
      }
      runId = next.runId; cursor = next.cursor; batch = next;
      for (const event of next.events) {
        const queue = history[event.channel]; if (queue.length >= 200) { queue.shift(); discarded[event.channel]++; } queue.push(event);
      }
      // Freeze can be clicked while the request is in flight.
      if (!frozen) render();
    } catch { $('diagnostic-health').textContent = 'Diagnostic feed disconnected · retained rows remain inspectable'; }
    finally { pending = false; }
  }
  setInterval(() => { void poll(); }, 300); void poll();
  let sensorIds = '';
  return { update(next: WorldState) {
    state = next;
    const ids = Object.keys(next.sensors).join(',');
    if (ids !== sensorIds) {
      sensorIds = ids;
      const filter = panes.sensors.filter, selected = filter.value; filter.replaceChildren();
      for (const [value, label] of [['all', 'All sensors'], ...Object.keys(next.sensors).map(id => [id, id]), ['invalid', 'Invalid / stale']]) {
        const option = node('option', '', label); option.value = value!; filter.append(option);
      }
      filter.value = Array.from(filter.options).some(o => o.value === selected) ? selected : 'all';
    }
  } };
}
