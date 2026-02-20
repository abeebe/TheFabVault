import { Router, Request, Response } from 'express';
import { requireAuth } from '../auth.js';
import { thumbFilePath, thumbExists } from '../services/fileStore.js';

const router = Router();

router.get('/thumb/:id.jpg', requireAuth, (req: Request, res: Response) => {
  const { id } = req.params;
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    res.status(400).json({ error: 'Invalid id' });
    return;
  }
  if (!thumbExists(id)) {
    res.status(404).json({ error: 'Thumbnail not found' });
    return;
  }
  res.sendFile(thumbFilePath(id), { headers: { 'Cache-Control': 'public, max-age=31536000' } });
});

export default router;
