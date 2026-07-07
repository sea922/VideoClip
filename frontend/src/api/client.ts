/**
 * Typed API client for the Video Editor backend.
 * All functions throw ApiError on non-2xx responses.
 */

export const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: res.statusText }));
    throw new ApiError(res.status, body.message ?? res.statusText);
  }

  return res.json() as Promise<T>;
}

// ── Types ────────────────────────────────────────────────────

export interface SubmitVideoResponse {
  videoId: string;
  jobId: string;
}

export interface VideoMetadata {
  videoId: string;
  s3Key: string;
  duration: number;
  title: string;
  thumbnailUrl: string;
}

export const JobState = {
  WAITING: 'waiting',
  ACTIVE: 'active',
  COMPLETED: 'completed',
  FAILED: 'failed',
  DELAYED: 'delayed',
  UNKNOWN: 'unknown',
} as const;

export type JobState = typeof JobState[keyof typeof JobState];

export interface JobStatus {
  id: string;
  status: JobState;
  progress: number;
  error?: string;
}

export interface SubmitExportRequest {
  videoId: string;
  clips: Array<{ start: number; end: number }>;
  transition: 'cut' | 'fade' | 'slide';
}

export interface SubmitExportResponse {
  exportId: string;
  jobId: string;
}

export interface ExportResult {
  exportId: string;
  status: string;
  presignedUrl?: string;
}

// ── API functions ────────────────────────────────────────────

export const api = {
  submitVideo: (url: string): Promise<SubmitVideoResponse> =>
    request('/videos', {
      method: 'POST',
      body: JSON.stringify({ url }),
    }),

  getJob: (jobId: string): Promise<JobStatus> =>
    request(`/jobs/${jobId}`),

  getVideo: (videoId: string): Promise<VideoMetadata> =>
    request(`/videos/${videoId}`),

  getStreamUrl: (videoId: string): string =>
    `${BASE_URL}/videos/${videoId}/stream`,

  submitExport: (data: SubmitExportRequest): Promise<SubmitExportResponse> =>
    request('/exports', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  getExport: (exportId: string): Promise<ExportResult> =>
    request(`/exports/${exportId}`),
};
