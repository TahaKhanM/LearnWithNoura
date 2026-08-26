export interface IllustrationBrief {
  purpose: string;
  subject: string;
  style?: string;
  requiredElements: string[];
  forbiddenElements: string[];
  at?: [number, number];
  w?: number;
  h?: number;
  alt?: string;
}

export type IllustrationMime = 'image/png' | 'image/jpeg' | 'image/webp';

export interface IllustrationRecord {
  id: string;
  cacheKey: string;
  mime: IllustrationMime;
  bytes: Uint8Array;
  createdAt: number;
  parentId?: string;
  sessionId?: string;
}

export interface IllustrationStore {
  getById(id: string): Promise<IllustrationRecord | null>;
  getByCacheKey(key: string): Promise<IllustrationRecord | null>;
  put(record: IllustrationRecord): Promise<void>;
}

export interface IllustrationUsage {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
}

export interface IllustrationGenerateResult {
  bytes: Uint8Array;
  mime: IllustrationMime;
  usage: IllustrationUsage;
}

export interface IllustrationGenerateClient {
  generate(input: {
    prompt: string;
    model: string;
    onPartial?: (dataUrl: string, index: number) => void;
  }): Promise<IllustrationGenerateResult | null>;
}

export interface IllustrationVisionClient {
  inspect(input: { prompt: string; imageDataUrl: string }): Promise<string | null>;
}
