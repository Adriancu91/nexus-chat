# API backend (M1)

Toate răspunsurile sunt JSON. Erorile au forma `{"error": {"code": "...", "message": "..."}}`.
Autentificare: `Authorization: Bearer <token>`.

## Public
| Metodă | Cale | Corp | Răspuns |
|---|---|---|---|
| GET | `/api/health` | — | `{ok, name, version}` |
| POST | `/api/rooms/join` | `{code, password, displayName}` | 201 `{token, expiresAt, room, participant}` · 401 `invalid_credentials` · 403 `room_closed`/`room_full` · 429 |
| GET | `/api/session` | — | `{principal}` |
| POST | `/api/session/logout` | — | 204 |
| GET | `/api/rooms/:roomId/messages?limit&beforeSeq&afterSeq` | — | `{roomId, messages, hasMore}` |

## Autentificare administrator
| Metodă | Cale | Corp |
|---|---|---|
| POST | `/api/admin/enroll` | `{code, publicKey: JWK P-256, label}` → 201 `{device}` |
| POST | `/api/admin/challenge` | `{deviceId}` → `{challengeId, nonce, expiresAt}` |
| POST | `/api/admin/login` | `{deviceId, challengeId, signature}` → `{token, expiresAt}` |

Semnătura: ECDSA P-256 / SHA-256, format IEEE P1363 (implicit în WebCrypto), base64url, peste
`nexus-chat/admin-login/v1\n<challengeId>\n<nonce>`.

## Administrare (doar token de administrator)
| Metodă | Cale | Corp |
|---|---|---|
| GET | `/api/admin/status` | — |
| GET | `/api/admin/devices` | — |
| POST | `/api/admin/devices/:id/revoke` | — |
| POST | `/api/admin/enrollment-codes` | — → `{code, expiresAt}` |
| GET | `/api/admin/rooms` | — |
| POST | `/api/admin/rooms` | `{name, password, maxParticipants?}` |
| PATCH | `/api/admin/rooms/:id` | `{name?, password?, maxParticipants?, closed?, revokeSessions?}` |
| DELETE | `/api/admin/rooms/:id` | `{confirmCode: <codul camerei>}` |
| GET | `/api/admin/rooms/:id/participants` | — |
| POST | `/api/admin/participants/:id/revoke` | — |
| GET | `/api/admin/audit?limit&beforeId` | — |

## WebSocket `/ws`
Primul mesaj trebuie să fie `auth` (în maxim 10 s). Orice mesaj poate avea un `ref` opțional,
returnat în răspuns.

| Client → server | Server → client |
|---|---|
| `{type:"auth", token}` | `{type:"ready", principal}` |
| `{type:"subscribe", roomId, afterSeq?}` | `{type:"history", roomId, room, messages, hasMore}` + `presence` |
| `{type:"history", roomId, beforeSeq?}` | `{type:"history", roomId, messages, hasMore}` |
| `{type:"send", roomId, body, clientMsgId?}` | `{type:"ack", clientMsgId, message}`; abonații primesc `{type:"message", message}` |
| `{type:"unsubscribe", roomId}` | `{type:"presence", roomId, online}` |
| `{type:"ping"}` | `{type:"pong"}` |
| | `{type:"error", code, message, ref?}` |

Coduri de închidere: 4401 neautentificat, 4403 sesiune revocată, 4408 timp de autentificare depășit,
1001 oprire server.
