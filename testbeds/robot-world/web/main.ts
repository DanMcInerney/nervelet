import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import './style.css';
import { createCockpit } from './cockpit.ts';
import type { LabRuntime } from '../src/runtime.ts';
import type { Vec3 } from '../src/contracts.ts';

type State = ReturnType<LabRuntime['inspect']> & { waypoint: number; auto: boolean; busy: boolean; error: string; policy: string; jevEnabled: boolean; native: boolean };
const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
const text = (id: string, value: string) => { element(id).textContent = value; };
let state: State | undefined, sceneId = '', follow = false;
const cockpit = createCockpit();
const viewport = element('viewport');
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.3;
viewport.append(renderer.domElement);
const scene = new THREE.Scene(); scene.fog = new THREE.Fog('#152735', 35, 90);
const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 150); camera.up.set(0, 0, 1); camera.position.set(23, -28, 25);
const controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true; controls.target.set(0, 0, 1.5); controls.maxPolarAngle = Math.PI / 2 - 0.02; controls.minDistance = 4; controls.maxDistance = 65;
scene.add(new THREE.HemisphereLight('#a5d9ef', '#233b46', 2.8));
const sun = new THREE.DirectionalLight('#eef9ff', 3); sun.position.set(-9, -12, 20); sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048); Object.assign(sun.shadow.camera, { left: -20, right: 20, top: 20, bottom: -20, near: 1, far: 70 });
sun.shadow.normalBias = 0.035; scene.add(sun);
const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 32), new THREE.MeshStandardMaterial({ color: '#1b3341', roughness: 1 }));
floor.receiveShadow = true; floor.position.z = -0.015; scene.add(floor);
const grid = new THREE.GridHelper(36, 36, '#496879', '#294655'); grid.rotation.x = Math.PI / 2; grid.position.z = 0.001; scene.add(grid);
const content = new THREE.Group(); scene.add(content);
let robot = new THREE.Group();
const beams = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: '#4cdbc4', transparent: true, opacity: 0.27 })); scene.add(beams);
const trailPoints: THREE.Vector3[] = [];
const trail = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: '#62e5ce', transparent: true, opacity: 0.6 })); scene.add(trail);
const rotors: THREE.Mesh[] = [];

function box(size: Vec3, color: string) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), new THREE.MeshStandardMaterial({ color, roughness: 0.65, metalness: 0.15 }));
  mesh.castShadow = true; mesh.receiveShadow = true; return mesh;
}
function disposeGroup(group: THREE.Group) {
  group.traverse(o => { if (o instanceof THREE.Mesh || o instanceof THREE.Line) { o.geometry.dispose();
    const materials = Array.isArray(o.material) ? o.material : [o.material]; for (const m of materials) m.dispose(); }
    if (o instanceof THREE.Sprite) { o.material.map?.dispose(); o.material.dispose(); }
  });
  group.clear();
}
function buildWorld(s: State) {
  disposeGroup(content); rotors.length = 0; trailPoints.length = 0;
  for (const obstacle of s.scenario.obstacles) {
    const mesh = obstacle.shape.kind === 'sphere' ? new THREE.Mesh(new THREE.SphereGeometry(obstacle.shape.size.x / 2, 24, 16),
      new THREE.MeshStandardMaterial({ color: obstacle.shape.color })) : box(obstacle.shape.size, obstacle.shape.color);
    mesh.position.copy(obstacle.position); mesh.castShadow = true; mesh.receiveShadow = true; content.add(mesh);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), new THREE.LineBasicMaterial({ color: '#c2d3da', transparent: true, opacity: 0.2 })); mesh.add(edges);
  }
  for (const [index, p] of s.scenario.waypoints.entries()) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.025, 8, 64), new THREE.MeshBasicMaterial({ color: '#e5be72', transparent: true, opacity: 0.9 }));
    ring.position.copy(p); content.add(ring);
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(p.x, p.y, 0), new THREE.Vector3(p.x, p.y, p.z)]),
      new THREE.LineDashedMaterial({ color: '#c3a469', dashSize: 0.15, gapSize: 0.2, transparent: true, opacity: 0.35 })); line.computeLineDistances(); content.add(line);
    const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64; const c = canvas.getContext('2d')!;
    c.fillStyle = '#edcd90'; c.font = '28px monospace'; c.textAlign = 'center'; c.fillText(String(index + 1).padStart(2, '0'), 32, 40);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true }));
    sprite.position.set(p.x, p.y, p.z + 0.75); sprite.scale.set(1, 1, 1); content.add(sprite);
  }
  robot = new THREE.Group(); robot.add(box(s.scenario.robot.shape.size, s.scenario.robot.shape.color)); content.add(robot);
  if (s.scenario.robot.model === 'drone') {
    for (const x of [-0.44, 0.44]) for (const y of [-0.44, 0.44]) {
      const motor = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.15, 16), new THREE.MeshStandardMaterial({ color: '#243844' }));
      motor.rotation.x = Math.PI / 2; motor.position.set(x, y, 0.1); robot.add(motor);
      const arm = box({ x: 0.64, y: 0.08, z: 0.065 }, '#354f60'); arm.position.set(x / 2, y / 2, 0); arm.rotation.z = Math.atan2(y, x); robot.add(arm);
      const rotor = new THREE.Mesh(new THREE.CircleGeometry(0.28, 32), new THREE.MeshBasicMaterial({ color: '#7cebd5', transparent: true, opacity: 0.3, side: THREE.DoubleSide }));
      rotor.position.set(x, y, 0.2); robot.add(rotor); rotors.push(rotor);
    }
    const nose = box({ x: 0.08, y: 0.25, z: 0.06 }, '#ffe0a1'); nose.position.x = 0.33; robot.add(nose);
  } else {
    for (const x of [-0.26, 0.26]) for (const y of [-0.35, 0.35]) {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.12, 20), new THREE.MeshStandardMaterial({ color: '#14222d' })); wheel.position.set(x, y, -0.1); robot.add(wheel);
    }
  }
}
new ResizeObserver(() => { const w = viewport.clientWidth, h = viewport.clientHeight;
  renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix(); }).observe(viewport);
function render() {
  requestAnimationFrame(render);
  if (state) {
    robot.position.lerp(new THREE.Vector3(state.robot.position.x, state.robot.position.y, state.robot.position.z), 0.25);
    if (follow) controls.target.lerp(robot.position, 0.12);
    beams.visible = element<HTMLInputElement>('rays').checked;
    const range = state.sensors.range?.value as { distances?: number[] } | undefined;
    if (range?.distances) {
      const points: THREE.Vector3[] = [];
      for (const [index, d] of range.distances.entries()) {
        const angle = index * Math.PI * 2 / range.distances.length;
        points.push(robot.position.clone(), robot.position.clone().add(new THREE.Vector3(Math.cos(angle) * d, Math.sin(angle) * d, 0)));
      }
      beams.geometry.dispose(); beams.geometry = new THREE.BufferGeometry().setFromPoints(points);
    }
  }
  controls.update(); renderer.render(scene, camera);
}
render();

async function control(body: Record<string, unknown>) {
  try { const response = await fetch('/api/control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error); text('error', ''); await poll();
  } catch (error) { text('error', String(error)); }
}
element('run').onclick = () => { void control({ op: 'run' }); };
element('hold').onclick = () => { void control({ op: 'hold' }); };
element('pause').onclick = () => { void control({ op: 'pause' }); };
element('step').onclick = () => { void control({ op: 'step' }); };
element('reset').onclick = () => { sceneId = ''; void control({ op: 'reset', scenario: element<HTMLSelectElement>('scenario').value }); };
element('scenario').onchange = () => { sceneId = ''; void control({ op: 'reset', scenario: element<HTMLSelectElement>('scenario').value }); };
element('policy').onchange = () => { void control({ op: 'policy', policy: element<HTMLSelectElement>('policy').value }); };
element('orbit').onclick = () => { follow = false; controls.target.set(0, 0, 1.5); element('orbit').classList.add('active'); element('follow').classList.remove('active'); };
element('follow').onclick = () => { follow = true; element('follow').classList.add('active'); element('orbit').classList.remove('active'); };
for (const id of ['latency', 'dropout', 'noise']) element(id).oninput = () => {
  const v = Number(element<HTMLInputElement>(id).value); text(`${id}-value`, id === 'latency' ? `${v} ms` : id === 'dropout' ? `${v}%` : `${(v / 100).toFixed(2)} m`);
};
element('apply-sensor').onclick = () => { void control({ op: 'sensor', id: element<HTMLSelectElement>('sensor').value,
  latencyMs: Number(element<HTMLInputElement>('latency').value), dropout: Number(element<HTMLInputElement>('dropout').value) / 100, noise: Number(element<HTMLInputElement>('noise').value) / 100 }); };
function instruments(s: State) {
  cockpit.update(s);
  for (const id of ['run', 'reset', 'scenario']) element<HTMLButtonElement>(id).disabled = s.native;
  element('hold').textContent = s.native ? '■ Stop agent' : '■ Hold';
  const note = document.querySelector<HTMLElement>('.controller-note')!;
  note.textContent = s.native ? `Connected: ${s.controller.name} · ${s.controller.status}` : 'Native Codex: Luna · xhigh — opt-in CLI dashboard on port 8861.';
  text('sim-time', `${(s.simMs / 1000).toFixed(2)} s`);
  const complete = s.jobs.filter(j => j.status === 'completed').length;
  text('progress', `${complete} / ${s.scenario.waypoints.length}`); text('collisions', String(s.collisions));
  text('decision-time', s.lastDecision ? `${Math.round(Number(s.lastDecision.latencyMs))} ms` : '—');
  text('world-name', s.scenario.name); text('mode', s.paused ? 'PAUSED' : s.auto ? 'RUNNING' : 'READY'); element('mode').classList.toggle('running', s.auto);
  text('pause', s.paused ? '▶ Resume world' : 'Ⅱ Pause world'); element<HTMLButtonElement>('step').disabled = !s.paused;
  element<HTMLSelectElement>('policy').value = s.policy; element<HTMLSelectElement>('policy').disabled = s.native || s.auto || s.busy;
  element<HTMLOptionElement>('policy').querySelector<HTMLOptionElement>('option[value=jev]')!.disabled = !s.jevEnabled;
  if (s.jevEnabled) element('policy').querySelector('option[value=jev]')!.textContent = 'Jev / live, bounded to 30 calls';
  text('clock-note', `60 Hz physics · simulation lag ${s.realTimeLagMs.toFixed(0)} ms · ${s.ticks.toLocaleString()} ticks`);
  if (s.error) text('error', s.error);
  const list = element('sensor-list'); list.replaceChildren();
  for (const [id, reading] of Object.entries(s.sensors)) {
    const row = document.createElement('div'); row.className = 'sensor-row';
    const name = document.createElement('span'); name.textContent = id;
    const small = document.createElement('small'); small.textContent = `sample #${reading.sequence} · acquired ${(reading.acquiredSimMs / 1000).toFixed(2)} s`; name.append(small);
    const age = document.createElement('span'); age.className = reading.valid ? 'fresh' : 'stale'; age.textContent = reading.valid ? `${Math.round(s.simMs - reading.acquiredSimMs)} ms` : (reading.reason ?? 'invalid');
    row.append(name, age); list.append(row);
  }
  const depth = s.sensors.depth?.value as { width: number; height: number; range: number; distances: number[] } | null;
  if (depth) { const canvas = element<HTMLCanvasElement>('depth-canvas'), c = canvas.getContext('2d')!;
    for (const [index, d] of depth.distances.entries()) { const t = 1 - d / depth.range;
      c.fillStyle = `rgb(${Math.round(10 + 65 * t)},${Math.round(28 + 188 * t)},${Math.round(40 + 146 * t)})`;
      c.fillRect(index % depth.width * canvas.width / depth.width, Math.floor(index / depth.width) * canvas.height / depth.height, canvas.width / depth.width + 1, canvas.height / depth.height + 1);
    }
    text('depth-age', `${Math.round(s.simMs - s.sensors.depth!.acquiredSimMs)} MS OLD`);
  }
  const job = s.jobs.find(j => j.status === 'running') ?? s.jobs.at(-1);
  text('job', job ? `${job.id} · ${job.status}${job.reason ? ` / ${job.reason}` : ''}` : 'Holding position');
  const protocol = s.protocol as Record<string, unknown>;
  text('protocol', s.scenario.robot.protocol === 'mavlink' ? `MAVLink v2 · binary loopback\n${protocol.frames} frames · ${Number(protocol.bytes).toLocaleString()} bytes\n${protocol.commandFrames} setpoints · ENU ↔ NED` : `Direct adapter · ${protocol.commands} commands`);
  element('protocol').style.whiteSpace = 'pre-line';
  const events = element('events'); events.replaceChildren();
  for (const event of s.trace.filter(e => e.type !== 'assembly').slice(-5).reverse()) {
    const row = document.createElement('div'); row.className = 'event'; const time = document.createElement('time');
    time.textContent = `${(Number((event as Record<string, unknown>).simMs) / 1000).toFixed(1)}s`; const name = document.createElement('span');
    name.textContent = String(event.type); row.append(time, name); events.append(row);
  }
}
let polling = false;
async function poll() {
  if (polling) return; polling = true;
  try { const response = await fetch('/api/state'); if (!response.ok) throw new Error('Disconnected'); const s: State = await response.json(); state = s;
    if (sceneId !== s.scenario.id) { buildWorld(s); sceneId = s.scenario.id; }
    if (!trailPoints.length || trailPoints.at(-1)!.distanceTo(new THREE.Vector3(...Object.values(s.robot.position))) > 0.08) {
      trailPoints.push(new THREE.Vector3(s.robot.position.x, s.robot.position.y, s.robot.position.z)); if (trailPoints.length > 600) trailPoints.shift();
      trail.geometry.dispose(); trail.geometry = new THREE.BufferGeometry().setFromPoints(trailPoints);
    }
    instruments(s); text('connection-label', 'CONNECTED'); element('connection').classList.add('connected');
  } catch { text('connection-label', 'DISCONNECTED'); element('connection').classList.remove('connected'); }
  finally { polling = false; }
}
setInterval(() => { void poll(); }, 150); void poll();
