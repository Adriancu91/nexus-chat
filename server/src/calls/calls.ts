import { HttpError } from '../errors.ts';
import { authenticateHash, senderOf, type Principal } from '../services/sessions.ts';
import { accessToken, verifyWebhook } from './jwt.ts';
import type { LiveKitKeys, RoomServiceClient } from './livekit.ts';
import type { Ctx } from '../context.ts';

export interface CallState {
  roomId: string;
  /** false = serverul nu are apelurile configurate (butonul de apel nu se afișează). */
  available: boolean;
  /** true = media trebuie să treacă prin releul TURN (drumul direct nu e disponibil). */
  relay: boolean;
  participants: { name: string; kind: 'admin' | 'participant' }[];
}

interface Issued {
  roomId: string;
  tokenHash: string;
}

/**
 * Apelurile trec prin LiveKit (SFU) pe același calculator. NEXUS rămâne autoritatea:
 * doar cine are acces la cameră primește un bilet semnat pentru apelul acelei camere,
 * iar revocarea accesului scoate imediat persoana și din apel.
 * Apelurile nu sunt înregistrate (componenta de înregistrare LiveKit nu este instalată).
 */
export class CallService {
  private readonly ctx: Ctx;
  private readonly keys: LiveKitKeys | null;
  private readonly rooms: RoomServiceClient | null;
  /** Bilete emise: identitate LiveKit → sesiunea NEXUS care a primit-o. */
  private readonly issued = new Map<string, Issued>();
  onState: (state: CallState) => void = () => undefined;
  /** Starea drumului media din internet (setată de aplicație). */
  network: () => { portMapping: string; active: boolean; externalIp: string | null; error: string | null } = () => ({
    portMapping: 'none',
    active: false,
    externalIp: null,
    error: null,
  });

  constructor(ctx: Ctx, backend: { keys: LiveKitKeys; rooms: RoomServiceClient } | null) {
    this.ctx = ctx;
    this.keys = backend?.keys ?? null;
    this.rooms = backend?.rooms ?? null;
  }

  get available(): boolean {
    return this.keys !== null && this.rooms !== null;
  }

  async issueToken(principal: Principal, roomId: string): Promise<{ token: string; identity: string; expiresInSec: number }> {
    if (!this.keys || !this.rooms) throw new HttpError(503, 'calls_unavailable', 'Apelurile nu sunt configurate pe server.');
    const sender = senderOf(principal);
    // Identitate unică per sesiune: același om pe două dispozitive apare de două ori, fără conflict.
    const identity = `${sender.senderKind}:${sender.senderId}:${principal.sessionId.slice(0, 8)}`;
    const current = await this.rooms.listParticipants(roomId);
    if (current.filter((p) => p.identity !== identity).length >= this.ctx.config.calls.maxParticipants) {
      throw new HttpError(403, 'call_full', `Apelul a atins numărul maxim de ${this.ctx.config.calls.maxParticipants} participanți.`);
    }
    const ttl = this.ctx.config.calls.tokenTtlSec;
    const token = accessToken({
      ...this.keys,
      identity,
      name: sender.senderName,
      metadata: JSON.stringify({ kind: sender.senderKind }),
      ttlSec: ttl,
      grant: { room: roomId, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: false, canUpdateOwnMetadata: false },
    });
    this.issued.set(identity, { roomId, tokenHash: principal.tokenHash });
    return { token, identity, expiresInSec: ttl };
  }

  async state(roomId: string): Promise<CallState> {
    if (!this.rooms) return { roomId, available: false, relay: false, participants: [] };
    const relay = this.relayMode();
    try {
      const list = await this.rooms.listParticipants(roomId);
      return {
        roomId,
        available: true,
        relay,
        participants: list.map((p) => ({ name: p.name, kind: p.identity.startsWith('admin:') ? 'admin' : 'participant' })),
      };
    } catch (err) {
      console.error('[apeluri] nu pot citi starea apelului:', err instanceof Error ? err.message : err);
      return { roomId, available: true, relay, participants: [] };
    }
  }

  /** Releul se folosește când e configurat și porturile directe nu sunt deschise în router. */
  private relayMode(): boolean {
    const turn = this.ctx.config.calls.turn;
    return Boolean(turn.domain || turn.udpPort) && !this.network().active;
  }

  /** Scoate din apeluri pe cei ale căror sesiuni au fost revocate, au expirat sau a căror cameră s-a închis. */
  async kickInvalid(): Promise<void> {
    if (!this.rooms) return;
    for (const [identity, info] of this.issued) {
      if (authenticateHash(this.ctx, info.tokenHash)) continue;
      this.issued.delete(identity);
      try {
        await this.rooms.removeParticipant(info.roomId, identity);
      } catch (err) {
        console.error('[apeluri] nu pot scoate participantul din apel:', err instanceof Error ? err.message : err);
      }
    }
  }

  /** Evenimente trimise de LiveKit (cineva a intrat/ieșit din apel). Semnătura este obligatorie. */
  async handleWebhook(body: Buffer, authorization: string | undefined): Promise<boolean> {
    if (!this.keys || !verifyWebhook(body, authorization, this.keys.apiKey, this.keys.apiSecret)) return false;
    let event: { event?: string; room?: { name?: string } };
    try {
      event = JSON.parse(body.toString('utf8')) as typeof event;
    } catch {
      return false;
    }
    const roomId = event.room?.name;
    if (roomId && /^(participant_joined|participant_left|room_finished|room_started)$/.test(event.event ?? '')) {
      this.onState(await this.state(roomId));
    }
    return true;
  }
}
