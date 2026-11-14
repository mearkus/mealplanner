// One Durable Object per family: phones keep a WebSocket open to it, and every change made by anyone in
// the family sends a tiny "changed" message so the other phones refresh straight away.
// Uses WebSocket hibernation, so idle connections cost nothing.
import { DurableObject } from 'cloudflare:workers';

export class FamilyRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Answer keep-alive pings without waking the object up.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/broadcast' && request.method === 'POST') {
      const msg = JSON.stringify({ type: 'changed', by: Number(url.searchParams.get('by')) || null, at: Date.now() });
      for (const ws of this.ctx.getWebSockets()) {
        try { ws.send(msg); } catch { /* socket already gone */ }
      }
      return new Response('ok');
    }
    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response('Not found', { status: 404 });
  }

  async webSocketClose(ws, code, reason) {
    try { ws.close(code, reason); } catch { /* already closed */ }
  }
}
