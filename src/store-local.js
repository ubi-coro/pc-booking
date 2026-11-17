// Demo mode: same interface as githubStore, backed by this browser's localStorage and fake data.
import { toIso, today } from './dates.js';

const KEY = 'pcb.demo.bookings.v2';

// The demo signs you in as Ada: responsible for vega, creator of some bookings, so both edit rules can be tried.
const ME = { login: 'ada', name: 'Ada Lovelace', avatar: null };

const PCS = [
  { id: 'vega', gpu: 'NVIDIA RTX PRO 6000', vram: 96, ram: 128, location: 'TransferLab', room: '0.211', setup: 'UR3e', netboot: true, responsible: 'Ada Lovelace', responsibleLogin: 'ada' },
  { id: 'deneb', gpu: 'NVIDIA RTX PRO 6000', vram: 96, ram: 96, location: 'Office', room: '1.217', setup: '', netboot: true, responsible: 'Alan Turing', responsibleLogin: 'alan' },
  { id: 'altair', gpu: 'NVIDIA RTX 6000 Ada', vram: 48, ram: 128, location: 'HumanoidLab', room: '0.111', setup: 'Data collection', netboot: false, responsible: 'Grace Hopper', responsibleLogin: 'grace', notes: 'RT kernel, no netboot' },
  { id: 'rigel', gpu: 'NVIDIA RTX 5000 Ada', vram: 32, ram: 64, location: 'TransferLab', room: '0.211', setup: 'XTS', netboot: true, responsible: 'Edsger Dijkstra', responsibleLogin: 'edsger' },
  { id: 'mira', gpu: 'NVIDIA GeForce RTX 4090', vram: 24, ram: 128, location: 'TransferLab', room: '0.211', setup: 'Aloha', netboot: true, responsible: 'Barbara Liskov', responsibleLogin: 'barbara' },
  { id: 'capella', gpu: 'NVIDIA RTX 4500 Ada', vram: 24, ram: 64, location: 'TransferLab', room: '0.211', setup: 'bimanual UR5e', netboot: true, responsible: 'Ken Thompson', responsibleLogin: 'ken' },
  { id: 'spica', gpu: 'NVIDIA RTX PRO 6000', vram: 96, ram: 128, location: 'HumanoidLab', room: '0.111', setup: '', netboot: true, responsible: 'Margaret Hamilton', responsibleLogin: 'margaret' },
  { id: 'antares', gpu: 'NVIDIA RTX 5000 Ada', vram: 32, ram: 64, location: 'Lemgo', room: '', setup: 'Aloha', netboot: true, responsible: 'Donald Knuth', responsibleLogin: 'donald' },
];

// Offsets from today so the demo never goes stale.
const BOOKINGS = [
  ['vega', 'Ada', -6, 12, { createdBy: 'ada' }],
  ['vega', 'Alan', 14, 20, { createdBy: 'alan' }],
  ['deneb', 'Alan', 13, 30, { createdBy: 'alan' }],
  ['altair', 'Grace', -20, 40, { createdBy: 'grace' }],
  ['rigel', 'Edsger', 0, 3, { createdBy: 'edsger' }],
  ['capella', 'Students', -2, 13, { createdBy: 'ada', preemptible: true, note: 'kill if needed' }],
  ['spica', 'Margaret', -1, 1, { createdBy: 'margaret' }],
  ['spica', 'Ken', 1, 9, { createdBy: 'ken' }],
  ['mira', 'Barbara', 6, 8, { createdBy: 'barbara' }],
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
    async whoami() { return ME; },
    async load() { return { pcs: PCS, bookings: read() }; },
    async mutate(op) {
      const next = op(read());
      try { localStorage.setItem(KEY, JSON.stringify(next)); } catch {}
      return next;
    },
  };
}
