import { readMonitorKey } from './auth.js';

// Forward only monitor operations; the remote server authenticates every request.
// Never substitute a privileged server key for the browser's supplied key.
export function remoteMonitorProxy(baseUrl) {
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol)) throw new Error('Invalid REMOTE_MONITOR_URL protocol.');
  return async (request, response, next) => {
    const pathname = request.path;
    const allowed = (request.method === 'GET' && /^\/jobs(?:\/[^/]+\/scans(?:\/[^/]+\/image)?)?$/.test(pathname))
      || (request.method === 'POST' && /^\/jobs\/[^/]+\/retry$/.test(pathname))
      || (request.method === 'DELETE' && /^\/jobs\/[^/]+$/.test(pathname));
    if (!allowed) return response.status(404).json({success: false, error: 'Monitor endpoint not found.'});
    try {
      const target = new URL(`${base.pathname.replace(/\/$/, '')}/api/v1/monitor${pathname}`, base.origin);
      const upstream = await fetch(target, {
        method: request.method,
        headers: {'X-Monitor-Key': String(readMonitorKey(request)), Accept: request.get('accept') || 'application/json'},
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      });
      response.status(upstream.status).set('Cache-Control', 'private, no-store');
      if (request.method === 'GET' && pathname === '/jobs' && upstream.ok) {
        return response.json({...await upstream.json(), remoteMonitor: true, monitorSource: base.origin});
      }
      response.set('Content-Type', upstream.headers.get('content-type') || 'application/json');
      return response.send(Buffer.from(await upstream.arrayBuffer()));
    } catch (error) { next(error); }
  };
}
