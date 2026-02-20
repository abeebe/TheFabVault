import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { createToken, requireAuth } from '../auth.js';
import type { LoginRequest, LoginResponse, HealthResponse } from '../types/index.js';

const router = Router();

router.get('/health', (_req: Request, res: Response) => {
  const body: HealthResponse = { ok: true, authRequired: config.authEnabled };
  res.json(body);
});

router.post('/auth/login', (req: Request, res: Response) => {
  if (!config.authEnabled) {
    res.status(503).json({ error: 'Authentication not configured' });
    return;
  }
  const { username, password } = req.body as LoginRequest;
  if (!username || !password) {
    res.status(400).json({ error: 'username and password required' });
    return;
  }
  if (username !== config.authUsername || password !== config.authPassword) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }
  const token = createToken(username);
  const body: LoginResponse = { token, expiresIn: config.jwtTtl };
  res.json(body);
});

router.post('/auth/refresh', requireAuth, (req: Request, res: Response) => {
  if (!config.authEnabled) {
    res.status(503).json({ error: 'Authentication not configured' });
    return;
  }
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  try {
    const payload = jwt.verify(token, config.jwtSecret) as { sub: string };
    const newToken = createToken(payload.sub);
    const body: LoginResponse = { token: newToken, expiresIn: config.jwtTtl };
    res.json(body);
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
});

export default router;
