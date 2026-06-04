import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] || 'paper_materials/ready_single_user_v1/runs/2026-05-28T03-03-28/per_trial_json';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
const all = files.map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));

const grouped = {};
all.forEach(j => {
  const b = j.baseline_name;
  if (!grouped[b]) grouped[b] = [];
  grouped[b].push(j);
});

function med(a) {
  const s = a.filter(x => x != null && isFinite(x)).sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : null;
}

function iqr(a) {
  const s = a.filter(x => x != null && isFinite(x)).sort((x, y) => x - y);
  if (s.length < 3) return { q1: s[0], q3: s[s.length - 1] };
  return { q1: s[Math.floor(s.length * 0.25)], q3: s[Math.floor(s.length * 0.75)] };
}

const keys = [
  'quality_at_5s', 'quality_at_10s', 'time_to_1M_visible_splats_ms',
  'blank_ratio', 'first_visible_splat_ms', 'completed_chunks',
  'throughput_Mbps', 'measure_fps', 'visible_splat_count_5s',
  'visible_splat_count_10s', 'visible_splat_count_20s',
  'total_received_bytes', 'cdp_rad_206_count',
];

const order = ['Spark-OD', 'Naive-PF', 'PRoGS', 'SGSS', 'READY-P', 'READY-E', 'READY-G', 'READY', 'Oracle'];

const results = [];
order.forEach(b => {
  const g = grouped[b];
  if (!g) return;
  const o = { baseline: b, n: g.length };
  keys.forEach(k => {
    o[k + '_med'] = med(g.map(r => r[k]));
    const iq = iqr(g.map(r => r[k]));
    o[k + '_q1'] = iq.q1;
    o[k + '_q3'] = iq.q3;
  });
  // per-trial values for paired comparison
  o.trials = g.map(r => ({
    t: r.trial_index,
    q5s: r.quality_at_5s,
    q10s: r.quality_at_10s,
    t1m: r.time_to_1M_visible_splats_ms,
    blank: r.blank_ratio,
    fv: r.first_visible_splat_ms,
    chunks: r.completed_chunks,
    tp: r.throughput_Mbps,
    fps: r.measure_fps,
    vis5s: r.visible_splat_count_5s,
    vis10s: r.visible_splat_count_10s,
    vis20s: r.visible_splat_count_20s,
    bytes: r.total_received_bytes,
    rad206: r.cdp_rad_206_count,
  }));
  results.push(o);
});

// Also load delivery_path_sanity for local/edge/remote comparison
let sanityDir = 'paper_materials/ready_single_user_v1/runs/delivery_path_sanity_2026-05-28T00-19-46/per_trial_json';
let sanity = [];
try {
  const sf = fs.readdirSync(sanityDir).filter(f => f.endsWith('.json'));
  sanity = sf.map(f => JSON.parse(fs.readFileSync(path.join(sanityDir, f), 'utf8')));
} catch(e) {}

const byDelivery = {};
sanity.forEach(j => {
  const dk = j.delivery_key || j.actual_delivery_key || 'unknown';
  if (!byDelivery[dk]) byDelivery[dk] = [];
  byDelivery[dk].push(j);
});

const deliveryStats = {};
Object.keys(byDelivery).forEach(dk => {
  const g = byDelivery[dk];
  deliveryStats[dk] = {
    n: g.length,
    q5s_med: med(g.map(r => r.quality_at_5s)),
    t1m_med: med(g.map(r => r.time_to_1M_visible_splats_ms)),
    blank_med: med(g.map(r => r.blank_ratio)),
    fv_med: med(g.map(r => r.first_visible_splat_ms)),
    tp_med: med(g.map(r => r.throughput_Mbps)),
    fps_med: med(g.map(r => r.measure_fps)),
    chunks_med: med(g.map(r => r.completed_chunks)),
  };
});

console.log(JSON.stringify({ results, deliveryStats }, null, 2));
