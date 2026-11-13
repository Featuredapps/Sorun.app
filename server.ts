import express from 'express';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { WebSocketServer, WebSocket } from 'ws';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Shared Gemini client initialized with User-Agent for telemetry
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    },
  },
});

/**
 * Splits text into chunks of roughly maxChars, respecting Arabic sentence boundaries.
 */
function splitText(text: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let currentChunk = '';
  const sentences = text.match(/[^.۔!?؟\n]+[.۔!?؟\n]*\s*/g) || [text];

  for (const sentence of sentences) {
    if ((currentChunk + sentence).length > maxChars && currentChunk.length > 0) {
      chunks.push(currentChunk.trim());
      currentChunk = sentence;
    } else {
      currentChunk += sentence;
    }
  }

  if (currentChunk.trim().length > 0) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

/**
 * Helper to generate a single TTS audio chunk via Gemini
 */
async function generateSingleTTSChunk(text: string, instructions: string, voiceName: string): Promise<string> {
  const prompt = `
[ROLE & PRODUCTION STANDARD]
You are a master professional voiceover artist delivering broadcast studio-grade Arabic voice acting.
Acoustics: Warm, clear, high-fidelity studio vocal presence with zero robotic artifacts, natural resonance, and balanced dynamic range.

[PERFORMANCE & ARTISTIC DIRECTION]
${instructions}

[ARABIC PHONOLOGY & CADENCE RULES]
- Deliver authentic Arabic phonetics with pristine articulation of letter origins (Makharij al-Huroof), natural elongation (Madd), and proper gemination (Shaddah).
- Honor natural punctuation pauses (Waqf) for organic human breathing, thought processing, and dramatic rhythm.
- Avoid flat or mechanical recitation; infuse the performance with authentic emotional color, expressive intonation contours, and vocal vitality appropriate to the character.

[SCRIPT TO PERFORM]
${text}
  `.trim();

  // Try gemini-2.5-flash-preview-tts first, fallback to gemini-3.8-flash-lite-tts if needed
  let response;
  try {
    response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-preview-tts',
      contents: [{ parts: [{ text: prompt }] }],
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: voiceName || 'Fenrir' },
          },
        },
      },
    });
  } catch (err: any) {
    if (err?.status === 404 || err?.message?.includes('not found') || err?.message?.includes('404')) {
      response = await ai.models.generateContent({
        model: 'gemini-3.8-flash-lite-tts',
        contents: [
          {
            role: 'user',
            parts: [{ text: prompt }],
          },
        ],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: voiceName || 'Fenrir' },
            },
          },
        },
      });
    } else {
      throw err;
    }
  }

  const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!base64Audio) {
    throw new Error('No audio data received from Gemini API');
  }
  return base64Audio;
}

/**
 * Concatenates multiple base64 encoded audio strings with subtle natural breathing gaps.
 */
function concatenateBase64Audio(base64Array: string[]): string {
  if (base64Array.length === 1) {
    return base64Array[0];
  }

  // 24000Hz, 16-bit mono = 48000 bytes/sec. ~140ms silence = ~6720 bytes.
  const silenceBytesCount = 6720;
  const silenceBuffer = new Uint8Array(silenceBytesCount);

  const arrays = base64Array.map((b64, idx) => {
    const binaryString = Buffer.from(b64, 'base64');
    // If it has a RIFF header and is not the first chunk, strip 44-byte WAV header
    const hasRiff = binaryString.length >= 44 && binaryString.subarray(0, 4).toString() === 'RIFF';
    if (idx > 0 && hasRiff) {
      return binaryString.subarray(44);
    }
    return binaryString;
  });

  const totalLength = arrays.reduce((acc, arr) => acc + arr.length, 0) + (arrays.length - 1) * silenceBytesCount;
  const result = Buffer.alloc(totalLength);

  let offset = 0;
  for (let i = 0; i < arrays.length; i++) {
    arrays[i].copy(result, offset);
    offset += arrays[i].length;
    if (i < arrays.length - 1) {
      Buffer.from(silenceBuffer).copy(result, offset);
      offset += silenceBytesCount;
    }
  }

  return result.toString('base64');
}

// -------------------------------------------------------------
// REST API Routes
// -------------------------------------------------------------

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Voiceover generation (Unary / Chunked)
app.post('/api/voiceover', async (req, res) => {
  try {
    const { text, instructions = '', voiceName = 'Fenrir' } = req.body;

    if (!text || typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'Text is required' });
    }

    if (text.length < 400) {
      const base64Audio = await generateSingleTTSChunk(text, instructions, voiceName);
      return res.json({ base64: base64Audio });
    }

    const chunks = splitText(text, 500);
    const chunkPromises = chunks.map((chunk) => generateSingleTTSChunk(chunk, instructions, voiceName));
    const base64Chunks = await Promise.all(chunkPromises);
    const combinedBase64 = concatenateBase64Audio(base64Chunks);

    return res.json({ base64: combinedBase64 });
  } catch (error: any) {
    console.error('Error generating voiceover on server:', error);
    const status = error?.status || error?.code || 500;
    return res.status(status).json({
      error: error?.message || 'Failed to generate voiceover',
      status,
      details: error?.error || error,
    });
  }
});

// Streaming Voiceover via SSE
app.post('/api/voiceover/stream', async (req, res) => {
  try {
    const { text, instructions = '', voiceName = 'Fenrir' } = req.body;

    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'Text is required' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const prompt = `
[ROLE & PRODUCTION STANDARD]
Broadcast studio-grade Arabic voice acting.
${instructions}
[SCRIPT TO PERFORM]
${text}
    `.trim();

    const responseStream = await ai.models.generateContentStream({
      model: 'gemini-3.8-flash-lite-tts',
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }],
        },
      ],
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: voiceName || 'Fenrir' },
          },
        },
      },
    });

    for await (const chunk of responseStream) {
      const data = chunk.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (data) {
        res.write(`data: ${JSON.stringify({ audioChunk: data })}\n\n`);
      }
    }

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (error: any) {
    console.error('Error in voiceover stream:', error);
    if (!res.headersSent) {
      res.status(error?.status || 500).json({ error: error?.message || 'Stream error' });
    } else {
      res.write(`data: ${JSON.stringify({ error: error?.message })}\n\n`);
      res.end();
    }
  }
});

// General Gemini text generation
app.post('/api/gemini/generate', async (req, res) => {
  try {
    const { prompt, model = 'gemini-3.8-flash', systemInstruction } = req.body;
    const response = await ai.models.generateContent({
      model,
      contents: prompt,
      config: systemInstruction ? { systemInstruction } : undefined,
    });
    res.json({ text: response.text });
  } catch (error: any) {
    console.error('Error in gemini generate:', error);
    res.status(error?.status || 500).json({ error: error?.message || 'Gemini error' });
  }
});

// General Gemini text streaming
app.post('/api/gemini/stream', async (req, res) => {
  try {
    const { prompt, model = 'gemini-3.8-flash', systemInstruction } = req.body;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const stream = await ai.models.generateContentStream({
      model,
      contents: prompt,
      config: systemInstruction ? { systemInstruction } : undefined,
    });

    for await (const chunk of stream) {
      if (chunk.text) {
        res.write(`data: ${JSON.stringify({ text: chunk.text })}\n\n`);
      }
    }
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (error: any) {
    console.error('Error in gemini stream:', error);
    if (!res.headersSent) {
      res.status(error?.status || 500).json({ error: error?.message || 'Stream error' });
    } else {
      res.write(`data: ${JSON.stringify({ error: error?.message })}\n\n`);
      res.end();
    }
  }
});

// -------------------------------------------------------------
// Live API WebSocket Bridge
// -------------------------------------------------------------
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const { pathname } = new URL(request.url || '', `http://${request.headers.host}`);
  if (pathname === '/ws/live' || pathname === '/api/live') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  }
});

wss.on('connection', async (ws: WebSocket) => {
  console.log('Client connected to Live API WebSocket bridge');
  let liveSession: any = null;

  try {
    if (ai.live && typeof ai.live.connect === 'function') {
      liveSession = await ai.live.connect({
        model: 'gemini-3.8-live',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } },
          },
          systemInstruction: 'You are a helpful Arabic voice assistant.',
        },
        callbacks: {
          onmessage: (message: LiveServerMessage) => {
            if (ws.readyState !== WebSocket.OPEN) return;
            for (const part of message.serverContent?.modelTurn?.parts ?? []) {
              if (part.inlineData?.data) {
                ws.send(JSON.stringify({ audio: part.inlineData.data }));
              }
            }
            if (message.serverContent?.interrupted) {
              ws.send(JSON.stringify({ interrupted: true }));
            }
          },
          onerror: (err: any) => {
            console.error('Live API session error:', err);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ error: err?.message || 'Live API error' }));
            }
          },
          onclose: () => {
            console.log('Live API session closed');
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ closed: true }));
            }
          },
        },
      });
    }
  } catch (err: any) {
    console.error('Error connecting Live API session:', err);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ error: err?.message || 'Failed to initialize Live API session' }));
    }
  }

  ws.on('message', async (data: Buffer | string) => {
    try {
      if (!liveSession) return;
      const parsed = typeof data === 'string' ? JSON.parse(data) : JSON.parse(data.toString());
      if (parsed.audio) {
        liveSession.sendRealtimeInput({
          audio: { data: parsed.audio, mimeType: 'audio/pcm;rate=16000' },
        });
      } else if (parsed.realtimeInput) {
        liveSession.sendRealtimeInput(parsed.realtimeInput);
      }
    } catch (err: any) {
      console.error('Error processing client message in Live session:', err);
    }
  });

  ws.on('close', () => {
    console.log('Live API client disconnected');
    if (liveSession && typeof liveSession.close === 'function') {
      try {
        liveSession.close();
      } catch (e) {
        // ignore
      }
    }
  });
});

// -------------------------------------------------------------
// Vite middleware in dev or static files in production
// -------------------------------------------------------------
async function startServer() {
  const isProd = process.env.NODE_ENV === 'production';
  const PORT = process.env.PORT || 3000;

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  server.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
