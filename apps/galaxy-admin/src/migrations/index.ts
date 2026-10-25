import * as migration_20261020_091547_initial from './20261020_091547_initial';
import * as migration_20261024_110000_system_settings_general from './20261024_110000_system_settings_general';

export const migrations = [
  {
    up: migration_20261020_091547_initial.up,
    down: migration_20261020_091547_initial.down,
    name: '20261020_091547_initial'
  },
  {
    up:migration_20261024_110000_system_settings_general.up,
    down:migration_20261024_110000_system_settings_general.down,
    name:'20261024_110000_system_settings_general'
  },
];
