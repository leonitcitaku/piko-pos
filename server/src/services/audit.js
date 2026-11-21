import { run } from '../db.js';
import { now } from '../clock.js';
export function audit(ctx, action, target = null, detail = null) {
  run('INSERT INTO audit_log(user_id, action, target, detail, device, at) VALUES(?,?,?,?,?,?)',
    ctx?.user?.id ?? null, action, target == null ? null : String(target),
    detail == null ? null : (typeof detail === 'string' ? detail : JSON.stringify(detail)), ctx?.device ?? null, now());
}
