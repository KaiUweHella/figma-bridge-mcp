// Block registry - all available blocks
// Each block has: name, description, category, and a create function

import { dashboard01 } from './dashboard-01.js';

export const BLOCKS = [
  {
    id: 'dashboard-01',
    name: 'Dashboard',
    description: 'Analytics dashboard with sidebar, stats cards, area chart and data table',
    category: 'Application',
    create: dashboard01
  }
];

export function listBlocks() {
  return BLOCKS.map(b => ({
    id: b.id,
    name: b.name,
    description: b.description,
    category: b.category
  }));
}

export function getBlock(id) {
  return BLOCKS.find(b => b.id === id);
}
