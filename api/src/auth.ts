import jwt from 'jsonwebtoken';
import { Request, Response, NextFunction } from 'express';
import { config } from './config.js';

export function createToken(username: string): string {
  return jwt.sign({ sub: username }, config.jwtSecret, {
    expiresIn: config.jwtTtl,
  });
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!config.authEnabled) {
    next();
    return;
  }

  const authHeader = req.headers.authorization;
  const headerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const queryToken = req.query.token as string | undefined;
  const token = headerToken ?? queryToken ?? null;

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
