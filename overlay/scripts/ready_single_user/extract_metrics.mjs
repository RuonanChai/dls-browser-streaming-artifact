import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] || 'paper_materials/ready_single_user_v1/runs/2026-05-28T03-03-28/per_trial_json';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
const rows = files.map(f => {
  const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  return {
    b: j.baseline_name,
    q5s: j.quality_at_5s,
    q10s: j.quality_at_10s,
    t1m: Math.round(j.time_to_1M_visible_splats_ms),
    blank: Math.round(j.blank_ratio * 1000) / 10,
    fv: Math.round(j.first_visible_splat_ms),
    chunks: j.completed_chunks,
    tp: Math.round((j.throughput_Mbps || 0) * 10) / 10,
    fps: j.measure_fps,
  };
});
rows.sort((a, b) => b.q5s - a.q5s);
console.log('Baseline         | q5s(K) | q10s(K) | t1m(ms) | blank% | fv(ms) | chunks | tp(Mbps) | fps');
console.log('-----------------|--------|---------|---------|--------|--------|--------|----------|-----');
rows.forEach(r => {
  const line = [
    r.b.padEnd(17),
    String(Math.round(r.q5s / 1000)).padStart(6),
    String(Math.round(r.q10s / 1000)).padStart(7),
    String(r.t1m).padStart(7),
    String(r.blank).padStart(6),
    String(r.fv).padStart(6),
    String(r.chunks).padStart(6),
    String(r.tp).padStart(8),
    String(r.fps).padStart(5),
  ].join(' | ');
  console.log(line);
});
