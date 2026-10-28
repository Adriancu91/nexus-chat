import {
  ConnectionState,
  DisconnectReason,
  Room,
  RoomEvent,
  Track,
  VideoPresets,
  type Participant,
  type RemoteTrack,
  type TrackPublication,
} from 'livekit-client';
import { errorMessage, request } from '../api.ts';
import { backendUrl } from '../config.ts';
import { clear, h, icon } from '../dom.ts';
import { initials, senderHue, toast } from '../ui.ts';

export interface CallOptions {
  roomId: string;
  roomName: string;
  token: () => Promise<string>;
  withVideo: boolean;
  onClosed: () => void;
}

/** Adresa de semnalizare LiveKit: aceeași cu serverul NEXUS (care o redirecționează local pe /rtc). */
function liveKitUrl(): string {
  return backendUrl().replace(/^http/, 'ws');
}

const DISCONNECT_MESSAGES: Partial<Record<DisconnectReason, string>> = {
  [DisconnectReason.PARTICIPANT_REMOVED]: 'Ai fost scos din apel (accesul a fost revocat).',
  [DisconnectReason.ROOM_DELETED]: 'Apelul a fost închis.',
  [DisconnectReason.DUPLICATE_IDENTITY]: 'Ai intrat în apel de pe alt dispozitiv.',
  [DisconnectReason.JOIN_FAILURE]: 'Nu s-a putut stabili legătura audio-video cu serverul.',
};

/**
 * Ecranul de apel. Sunetul și imaginea trec prin serverul media (LiveKit) de pe calculatorul
 * gazdă: fiecare participant are o singură conexiune, către server, nu direct către ceilalți.
 */
export async function openCall(opts: CallOptions): Promise<void> {
  const room = new Room({
    adaptiveStream: true,
    dynacast: true,
    videoCaptureDefaults: { resolution: VideoPresets.h360.resolution },
    publishDefaults: {
      simulcast: true,
      // Limită de bitrate: conexiunea gazdei trebuie să ducă fluxul fiecăruia către toți ceilalți.
      videoEncoding: { maxBitrate: 600_000, maxFramerate: 24 },
      dtx: true,
    },
  });

  const status = h('div', { class: 'call-status', role: 'status', 'data-testid': 'call-status' }, 'Se conectează…');
  const grid = h('div', { class: 'call-grid', 'data-testid': 'call-grid' });
  const audioSink = h('div', { hidden: true });
  const micBtn = h('button', { type: 'button', class: 'call-btn', 'aria-pressed': 'true' });
  const camBtn = h('button', { type: 'button', class: 'call-btn', 'aria-pressed': 'false' });
  const flipBtn = h('button', { type: 'button', class: 'call-btn', hidden: true, 'aria-label': 'Schimbă camera', title: 'Schimbă camera' }, icon('flip'));
  const audioBtn = h('button', { type: 'button', class: 'call-btn call-btn-warn', hidden: true }, 'Pornește sunetul');
  const leaveBtn = h('button', { type: 'button', class: 'call-btn call-btn-leave', 'aria-label': 'Închide apelul', title: 'Închide apelul' }, icon('hangup'));
  const overlay = h(
    'div',
    { class: 'call-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': `Apel în ${opts.roomName}` },
    h('header', { class: 'call-head' }, h('strong', null, opts.roomName), status),
    grid,
    audioSink,
    h('div', { class: 'call-controls' }, micBtn, camBtn, flipBtn, audioBtn, leaveBtn),
  );
  document.body.appendChild(overlay);
  document.body.classList.add('in-call');

  let closed = false;
  const close = async (message?: string) => {
    if (closed) return;
    closed = true;
    await room.disconnect().catch(() => undefined);
    overlay.remove();
    document.body.classList.remove('in-call');
    if (message) toast(message, 'info');
    opts.onClosed();
  };

  // ---- afișare ----
  function tile(p: Participant): HTMLElement {
    const camera = p.getTrackPublication(Track.Source.Camera);
    const mic = p.getTrackPublication(Track.Source.Microphone);
    const showVideo = camera?.track && !camera.isMuted;
    const label = p.name || 'Participant';
    const el = h(
      'div',
      { class: `call-tile ${p.isSpeaking ? 'call-tile-speaking' : ''}`, 'data-testid': 'call-tile', 'data-local': p.isLocal ? 'yes' : 'no' },
      showVideo ? null : h('span', { class: 'avatar call-avatar', style: { '--hue': senderHue(p.identity) } }, initials(label)),
      h('span', { class: 'call-name' }, label, p.isLocal ? ' (tu)' : '', !mic || mic.isMuted ? icon('micOff', 'microfon oprit') : null),
    );
    if (showVideo && camera.track) {
      const video = camera.track.attach() as HTMLVideoElement;
      video.muted = true;
      video.playsInline = true;
      video.setAttribute('data-testid', p.isLocal ? 'local-video' : 'remote-video');
      if (p.isLocal) video.classList.add('mirror');
      el.prepend(video);
    }
    return el;
  }

  function render() {
    clear(grid);
    const people: Participant[] = [room.localParticipant, ...room.remoteParticipants.values()];
    grid.dataset.count = String(people.length);
    for (const p of people) grid.append(tile(p));
    const mic = room.localParticipant.isMicrophoneEnabled;
    const cam = room.localParticipant.isCameraEnabled;
    clear(micBtn);
    micBtn.append(icon(mic ? 'mic' : 'micOff'));
    micBtn.setAttribute('aria-pressed', String(mic));
    micBtn.setAttribute('aria-label', mic ? 'Oprește microfonul' : 'Pornește microfonul');
    micBtn.title = micBtn.getAttribute('aria-label')!;
    clear(camBtn);
    camBtn.append(icon(cam ? 'cam' : 'camOff'));
    camBtn.setAttribute('aria-pressed', String(cam));
    camBtn.setAttribute('aria-label', cam ? 'Oprește camera' : 'Pornește camera');
    camBtn.title = camBtn.getAttribute('aria-label')!;
    const others = room.remoteParticipants.size;
    if (room.state === ConnectionState.Connected) {
      status.textContent = others === 0 ? 'Aștepți să intre și ceilalți…' : `${others + 1} în apel`;
    }
  }

  function attachAudio(track: RemoteTrack) {
    if (track.kind === Track.Kind.Audio) audioSink.append(track.attach());
  }

  room
    .on(RoomEvent.ParticipantConnected, render)
    .on(RoomEvent.ParticipantDisconnected, render)
    .on(RoomEvent.TrackSubscribed, (track) => {
      attachAudio(track);
      render();
    })
    .on(RoomEvent.TrackUnsubscribed, (track) => {
      track.detach().forEach((el) => el.remove());
      render();
    })
    .on(RoomEvent.TrackMuted, render)
    .on(RoomEvent.TrackUnmuted, render)
    .on(RoomEvent.LocalTrackPublished, render)
    .on(RoomEvent.LocalTrackUnpublished, render)
    .on(RoomEvent.ActiveSpeakersChanged, render)
    .on(RoomEvent.Reconnecting, () => {
      status.textContent = 'Legătura s-a întrerupt, se reconectează…';
    })
    .on(RoomEvent.Reconnected, render)
    .on(RoomEvent.AudioPlaybackStatusChanged, () => {
      audioBtn.hidden = room.canPlaybackAudio;
    })
    .on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
      void close(reason !== undefined && reason !== DisconnectReason.CLIENT_INITIATED ? DISCONNECT_MESSAGES[reason] ?? 'Apelul s-a încheiat.' : undefined);
    });

  // ---- comenzi ----
  const guard = (fn: () => Promise<unknown>) => async () => {
    try {
      await fn();
    } catch (err) {
      toast(mediaError(err), 'error');
    }
    render();
  };
  micBtn.addEventListener('click', guard(() => room.localParticipant.setMicrophoneEnabled(!room.localParticipant.isMicrophoneEnabled)));
  camBtn.addEventListener('click', guard(() => room.localParticipant.setCameraEnabled(!room.localParticipant.isCameraEnabled)));
  flipBtn.addEventListener(
    'click',
    guard(async () => {
      const devices = await Room.getLocalDevices('videoinput');
      const current = room.getActiveDevice('videoinput');
      const idx = devices.findIndex((d) => d.deviceId === current);
      const next = devices[(idx + 1) % devices.length];
      if (next) await room.switchActiveDevice('videoinput', next.deviceId);
    }),
  );
  audioBtn.addEventListener('click', () => void room.startAudio());
  leaveBtn.addEventListener('click', () => void close());
  overlay.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') void close();
  });

  // ---- conectare ----
  try {
    const { token } = await request<{ token: string }>('POST', `/api/rooms/${opts.roomId}/call/token`, { token: await opts.token() });
    await room.connect(liveKitUrl(), token, { autoSubscribe: true });
    room.remoteParticipants.forEach((p) => p.trackPublications.forEach((pub: TrackPublication) => pub.track && attachAudio(pub.track as RemoteTrack)));
    render();
    await room.localParticipant.setMicrophoneEnabled(true).catch((err: unknown) => toast(mediaError(err), 'error'));
    if (opts.withVideo) await room.localParticipant.setCameraEnabled(true).catch((err: unknown) => toast(mediaError(err), 'error'));
    flipBtn.hidden = (await Room.getLocalDevices('videoinput').catch(() => [])).length < 2;
    audioBtn.hidden = room.canPlaybackAudio;
    render();
    leaveBtn.focus();
  } catch (err) {
    await close();
    toast(`Nu am putut intra în apel: ${errorMessage(err)}`, 'error');
  }
}

function mediaError(err: unknown): string {
  const name = err instanceof Error ? err.name : '';
  if (name === 'NotAllowedError') return 'Nu ai dat permisiunea pentru microfon sau cameră. Verifică setările browserului pentru acest site.';
  if (name === 'NotFoundError') return 'Nu am găsit microfon sau cameră pe acest dispozitiv.';
  if (name === 'NotReadableError') return 'Camera sau microfonul sunt folosite de altă aplicație.';
  return errorMessage(err);
}
