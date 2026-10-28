import { ApiError, NETWORK_ERROR_MESSAGE, type Message } from './api.ts';
import { backendUrl } from './config.ts';

export interface UploadHandle {
  promise: Promise<Message>;
  cancel(): void;
}

/**
 * Upload cu progres (XMLHttpRequest, fiindcă fetch nu raportează progresul trimiterii).
 * Numele fișierului călătorește codificat într-un antet, iar conținutul ca flux binar.
 */
export function uploadFile(
  roomId: string,
  token: string,
  file: File,
  onProgress: (fraction: number) => void,
  caption = '',
): UploadHandle {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<Message>((resolve, reject) => {
    xhr.open('POST', `${backendUrl()}/api/rooms/${roomId}/files`);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
    if (caption) xhr.setRequestHeader('X-Caption', encodeURIComponent(caption));
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) onProgress(ev.loaded / ev.total);
    };
    xhr.onload = () => {
      let data: { message?: Message; error?: { code: string; message: string } } = {};
      try {
        data = JSON.parse(xhr.responseText || '{}');
      } catch {
        // răspuns neașteptat
      }
      if (xhr.status === 201 && data.message) resolve(data.message);
      else reject(new ApiError(xhr.status, data.error?.code ?? 'upload_failed', data.error?.message ?? `Încărcarea a eșuat (${xhr.status}).`));
    };
    xhr.onerror = () => reject(new ApiError(0, 'network', NETWORK_ERROR_MESSAGE));
    xhr.onabort = () => reject(new ApiError(0, 'aborted', 'Încărcare anulată.'));
    xhr.send(file);
  });
  return { promise, cancel: () => xhr.abort() };
}

/** Descarcă un fișier cu autorizare (tokenul nu apare niciodată în URL). */
export async function fetchFileBlob(fileId: string, token: string): Promise<Blob> {
  let res: Response;
  try {
    res = await fetch(`${backendUrl()}/api/files/${fileId}`, {
      headers: { Authorization: `Bearer ${token}` },
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
  } catch {
    throw new ApiError(0, 'network', NETWORK_ERROR_MESSAGE);
  }
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: { code: string; message: string } };
    throw new ApiError(res.status, err.error?.code ?? 'download_failed', err.error?.message ?? 'Descărcarea a eșuat.');
  }
  return res.blob();
}

export async function saveFile(fileId: string, name: string, token: string): Promise<void> {
  const blob = await fetchFileBlob(fileId, token);
  // Tipul generic împiedică browserul să deschidă conținutul în pagină.
  const url = URL.createObjectURL(new Blob([blob], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Previzualizări de imagini, păstrate cât timp e deschisă camera. */
export class PreviewCache {
  private readonly urls = new Map<string, Promise<string>>();

  get(fileId: string, token: () => Promise<string>): Promise<string> {
    let p = this.urls.get(fileId);
    if (!p) {
      p = token()
        .then((t) => fetchFileBlob(fileId, t))
        .then((blob) => URL.createObjectURL(blob));
      p.catch(() => this.urls.delete(fileId));
      this.urls.set(fileId, p);
    }
    return p;
  }

  dispose(): void {
    for (const p of this.urls.values()) void p.then((u) => URL.revokeObjectURL(u), () => undefined);
    this.urls.clear();
  }
}
