import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClassroomHandler } from './classroom-handler';
import { ClassroomService } from './classroom-service';
import { JsonClassroomStore } from './classroom-store';
import { ClassroomAiService } from './classroom-ai';
import { ClassroomLessonService } from './classroom-lesson';
import { ClassroomMaterialService } from './classroom-materials';
import { ClassroomRecognitionService } from './classroom-recognition';
import { ClassroomAudioService } from './classroom-audio';
import { ClassroomTranscriptionService, createHttpTranscriptionProvider } from './classroom-transcription';
import { createClassroomStaticHandler } from './classroom-static';

const root = resolve(import.meta.dirname, '..');
const store = await JsonClassroomStore.open(process.env.INKLOOP_CLASSROOM_STORE || resolve(root, '.inkloop/classrooms'));
const service = new ClassroomService(store);
const transcription = new ClassroomTranscriptionService(store, service, {
  processingMode: process.env.INKLOOP_CLASSROOM_TRANSCRIPTION_MODE === 'external' ? 'external' : 'local',
  ...(process.env.INKLOOP_CLASSROOM_TRANSCRIPTION_URL ? { provider: createHttpTranscriptionProvider({
    baseUrl: process.env.INKLOOP_CLASSROOM_TRANSCRIPTION_URL,
    mode: process.env.INKLOOP_CLASSROOM_TRANSCRIPTION_MODE === 'external' ? 'external' : 'local',
    externalOptIn: process.env.INKLOOP_CLASSROOM_TRANSCRIPTION_EXTERNAL_OPT_IN === '1',
    apiKey: process.env.INKLOOP_CLASSROOM_TRANSCRIPTION_API_KEY,
  }) } : {}),
});
const audio = new ClassroomAudioService(store, transcription);
await transcription.recover();
const classroom = createClassroomHandler({
  store, service, ai: new ClassroomAiService(store), lesson: new ClassroomLessonService(store),
  materials: new ClassroomMaterialService(store, service), recognition: new ClassroomRecognitionService(store), audio, transcription,
  allowOrigins: (process.env.INKLOOP_CLASSROOM_ORIGINS || '').split(',').map((origin) => origin.trim()).filter(Boolean),
  requireSecureTransport: true,
});
const staticFiles = createClassroomStaticHandler(resolve(root, 'dist'));
const port = Number(process.env.INKLOOP_HTTPS_PORT || 8872);
const keyPath = String(process.env.INKLOOP_HTTPS_KEY_PATH || '');
const certPath = String(process.env.INKLOOP_HTTPS_CERT_PATH || '');
if (!keyPath || !certPath) throw new Error('classroom_https_certificate_required');

const server = createHttpsServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, (req, res) => {
  void classroom(req, res).then((handled) => {
    if (handled || staticFiles(req, res)) return;
    if (req.url === '/healthz') {
      res.statusCode = 200; res.setHeader('content-type', 'application/json'); res.end('{"ok":true,"service":"inkloop-classroom"}'); return;
    }
    res.statusCode = 404; res.setHeader('content-type', 'application/json'); res.end('{"error":"not_found"}');
  }).catch(() => { if (!res.headersSent) res.statusCode = 500; res.end(); });
});
server.listen(port, '0.0.0.0', () => console.log(`[InkLoop classroom] HTTPS only :${port}`));
