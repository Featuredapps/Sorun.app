/**
 * Client service to communicate with server-side Gemini API endpoints.
 * All API keys and Gemini SDK calls are securely handled on the server.
 */

export interface VoiceoverResponse {
  base64: string;
}

/**
 * Generates voiceover by sending the request to the server-side /api/voiceover endpoint.
 */
export async function generateVoiceover(
  text: string,
  instructions: string,
  voiceName: string = 'Fenrir'
): Promise<string> {
  const response = await fetch('/api/voiceover', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text,
      instructions,
      voiceName,
    }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const error: any = new Error(errorData.error || errorData.message || `Request failed with status ${response.status}`);
    error.status = response.status;
    error.code = response.status;
    error.details = errorData;
    throw error;
  }

  const data: VoiceoverResponse = await response.json();
  if (!data.base64) {
    throw new Error('No audio data received from server');
  }

  return data.base64;
}

/**
 * Connect to streaming voiceover endpoint via Server-Sent Events
 */
export async function streamVoiceover(
  text: string,
  instructions: string,
  voiceName: string = 'Fenrir',
  onChunk: (base64Chunk: string) => void
): Promise<void> {
  const response = await fetch('/api/voiceover/stream', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text, instructions, voiceName }),
  });

  if (!response.ok || !response.body) {
    throw new Error(`Stream request failed: ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const jsonStr = line.slice(6).trim();
        if (jsonStr) {
          try {
            const parsed = JSON.parse(jsonStr);
            if (parsed.audioChunk) {
              onChunk(parsed.audioChunk);
            }
          } catch (e) {
            // ignore malformed chunk
          }
        }
      }
    }
  }
}
