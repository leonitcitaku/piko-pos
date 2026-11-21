// Server Sent Events: keeps every screen in sync and pushes printer alerts.
const clients = new Set();
export function addClient(res, user) {
  const c = { res, user };
  clients.add(c);
  res.on('close', () => clients.delete(c));
}
export function broadcast(type, data = {}) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) { try { c.res.write(msg); } catch { clients.delete(c); } }
}
export const clientCount = () => clients.size;
setInterval(() => { for (const c of clients) { try { c.res.write(': ping\n\n'); } catch { clients.delete(c); } } }, 20000).unref();
