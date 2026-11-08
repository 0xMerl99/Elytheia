import type { Request, Response } from 'express';

/** Minimal server-sent-events hub used to push trades and launches to open pages. */
const clients = new Set<Response>();

export function sseHandler(req: Request, res: Response) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  res.write(`data: ${JSON.stringify({ type: 'hello' })}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
}

export function publish(event: Record<string, unknown>) {
  if (clients.size === 0) return;
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  for (const c of clients) {
    try {
      c.write(frame);
    } catch {
      clients.delete(c);
    }
  }
}

setInterval(() => {
  for (const c of clients) {
    try {
      c.write(': ping\n\n');
    } catch {
      clients.delete(c);
    }
  }
}, 25_000).unref();
