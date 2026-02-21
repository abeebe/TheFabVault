import jwt from 'jsonwebtoken';
import { Request, Response, NextFunction } from 'express';
import { config } from './config.js';

export interface JwtPayload {
  sub: string;
  iat?: number;
  exp?: number;
}

export function createToken(username: string): string {
  return jwt.sign({ sub: username }, config.jwtSecret, {
    expiresIn: config.jwtTtl,
  });
}

function extractToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  const headerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const queryToken = req.query.token as string | undefined;
  return headerToken ?? queryToken ?? null;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!config.authEnabled) {
    next();
    return;
  }

  const token = extractToken(req);

  if (!token) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    jwt.verify(token, config.jwtSecret);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!config.authEnabled) {
    next();
    return;
  }

  const token = extractToken(req);

  if (!token) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const decoded = jwt.verify(token, config.jwtSecret) as JwtPayload;
    // Admin is the configured auth username
    if (decoded.sub === config.authUsername) {
      next();
    } else {
      res.status(403).json({ error: 'Forbidden: admin access required' });
    }
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}
