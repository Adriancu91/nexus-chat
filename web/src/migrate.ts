import { migrateAdminDevice } from './adminAuth.ts';
import { backendOverride, previousBackendUrls, setBackendOverride } from './config.ts';
import { migrateRoomSessions } from './sessions.ts';

/**
 * După mutarea serverului pe alt calculator, adresa lui se schimbă. Sesiunile din camere și
 * cheia de administrator sunt păstrate în browser pe adresă; aici le trecem pe adresa nouă,
 * ca nimeni să nu fie nevoit să reintre în camere sau să-și reînregistreze dispozitivul.
 * Sursa adreselor vechi este doar `config.json` publicat de proprietar, niciodată un link.
 */
export async function migrateBackendData(): Promise<void> {
  const previous = previousBackendUrls();
  if (previous.length === 0) return;
  try {
    const override = backendOverride();
    // O setare manuală care indică serverul vechi ar ține browserul pe adresa veche.
    if (override && previous.includes(override)) setBackendOverride(null);
  } catch {
    // stocare indisponibilă
  }
  migrateRoomSessions(previous);
  try {
    await migrateAdminDevice(previous);
  } catch {
    // IndexedDB indisponibil: dispozitivul se poate reînregistra manual
  }
}
