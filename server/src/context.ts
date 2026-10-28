import type { DatabaseSync } from 'node:sqlite';
import type { Config } from './config.ts';

export interface Ctx {
  db: DatabaseSync;
  config: Config;
  now: () => number;
}
