import * as migration_20261020_091547_initial from './20261020_091547_initial';

export const migrations = [
  {
    up: migration_20261020_091547_initial.up,
    down: migration_20261020_091547_initial.down,
    name: '20261020_091547_initial'
  },
];
