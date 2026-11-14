import jwt from 'jsonwebtoken';
import { FLEET_IDS } from '../../shared/geo.js';
import { config } from './config.js';

export function signToken(user) {
  return jwt.sign(
    { sub: user.username, role: user.role, fleets: user.role === 'admin' ? FLEET_IDS : user.fleets },
    config.jwtSecret,
    { expiresIn: '12h' },
  );
}

export function verifyToken(token) {
  const p = jwt.verify(token, config.jwtSecret);
  return { username: p.sub, role: p.role, fleets: p.fleets };
}

export const canSeeFleet = (user, fleetId) => user.fleets.includes(fleetId);

/** Express middleware: requires `Authorization: Bearer <jwt>`. */
export function requireUser(req, res, next) {
  const h = req.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Sign in required' });
  try {
    req.user = verifyToken(token);
    next();
  } catch {
    res.status(401).json({ error: 'Session expired, sign in again' });
  }
}

/** Express middleware for device endpoints: requires the shared device key. */
export function requireDevice(req, res, next) {
  if (req.get('x-api-key') !== config.deviceApiKey) return res.status(401).json({ error: 'Invalid device key' });
  next();
}

/** Restricts a requested fleet list (comma string or undefined) to what the user may see. */
export function allowedFleets(user, requested) {
  if (!requested) return user.fleets;
  return String(requested).split(',').filter((f) => canSeeFleet(user, f));
}
