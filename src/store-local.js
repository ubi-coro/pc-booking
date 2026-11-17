// Demo mode: same interface as githubStore, backed by this browser's localStorage and fake data.
import { toIso, today } from './dates.js';

const KEY = 'pcb.demo.bookings';

const PCS = [
  { id: 'vega', gpu: 'NVIDIA RTX PRO 6000', vram: 96, ram: 128, location: 'TransferLab', room: '0.211', setup: 'UR3e', netboot: true, responsible: 'Ada Lovelace' },
  { id: 'deneb', gpu: 'NVIDIA RTX PRO 6000', vram: 96, ram: 96, location: 'Office', room: '1.217', setup: '', netboot: true, responsible: 'Alan Turing' },
  { id: 'altair', gpu: 'NVIDIA RTX 6000 Ada', vram: 48, ram: 128, location: 'HumanoidLab', room: '0.111', setup: 'Data collection', netboot: false, responsible: 'Grace Hopper', notes: 'RT kernel, no netboot' },
  { id: 'rigel', gpu: 'NVIDIA RTX 5000 Ada', vram: 32, ram: 64, location: 'TransferLab', room: '0.211', setup: 'XTS', netboot: true, responsible: 'Edsger Dijkstra' },
  { id: 'mira', gpu: 'NVIDIA GeForce RTX 4090', vram: 24, ram: 128, location: 'TransferLab', room: '0.211', setup: 'Aloha', netboot: true, responsible: 'Barbara Liskov' },
  { id: 'capella', gpu: 'NVIDIA RTX 4500 Ada', vram: 24, ram: 64, location: 'TransferLab', room: '0.211', setup: 'bimanual UR5e', netboot: true, responsible: 'Ken Thompson' },
  { id: 'spica', gpu: 'NVIDIA RTX PRO 6000', vram: 96, ram: 128, location: 'HumanoidLab', room: '0.111', setup: '', netboot: true, responsible: 'Margaret Hamilton' },
  { id: 'antares', gpu: 'NVIDIA RTX 5000 Ada', vram: 32, ram: 64, location: 'Lemgo', room: '', setup: 'Aloha', netboot: true, responsible: 'Donald Knuth' },
];

// Offsets from today so the demo never goes stale.
const BOOKINGS = [
  ['vega', 'Ada', -6, 12],
  ['deneb', 'Alan', 13, 30],
  ['altair', 'Grace', -20, 40],
  ['rigel', 'Edsger', 0, 3],
  ['capella', 'Students', -2, 13, { preemptible: true, note: 'kill if needed' }],
  ['spica', 'Margaret', -1, 1],
  ['spica', 'Ken', 1, 9],
  ['mira', 'Barbara', 6, 8],
];

function seed() {
  const t = today();
  return BOOKINGS.map(([pc, user, a, b, extra], i) => ({ id: `demo-${i}`, pc, user, from: toIso(t + a), to: toIso(t + b), ...extra }));
}

export function localStore() {
  const read = () => {
    try { return JSON.parse(localStorage.getItem(KEY)) ?? seed(); } catch { return seed(); }
  };
  return {
    async whoami() { return null; },
    async load() { return { pcs: PCS, bookings: read() }; },
    async mutate(op) {
      const next = op(read());
      try { localStorage.setItem(KEY, JSON.stringify(next)); } catch {}
      return next;
    },
  };
}
