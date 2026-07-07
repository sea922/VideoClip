import { useState, useEffect } from 'react';
import type { JobStatus } from '../api/client';
import { JobState, BASE_URL } from '../api/client';

const TERMINAL_STATES = new Set<JobState>([JobState.COMPLETED, JobState.FAILED]);

/**
 * Connects to /jobs/:jobId/progress SSE stream until the job reaches a terminal state.
 * Automatically stops listening on 'completed' or 'failed'.
 */
export function useJob(jobId: string | null): {
  job: JobStatus | null;
  isLoading: boolean;
  error: string | null;
} {
  const [job, setJob] = useState<JobStatus | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!jobId) {
      setJob(null);
      setError(null);
      return;
    }

    setIsLoading(true);
    setError(null);

    const eventSource = new EventSource(`${BASE_URL}/jobs/${jobId}/progress`);

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as JobStatus;
        setJob(data);

        if (TERMINAL_STATES.has(data.status)) {
          setIsLoading(false);
          eventSource.close();
        }
      } catch (err) {
        console.error('Failed to parse SSE data', err);
      }
    };

    eventSource.onerror = (err) => {
      console.error('EventSource error:', err);
      // Don't override terminal states with error
      setJob((prev) => {
        if (!prev || !TERMINAL_STATES.has(prev.status)) {
          setError('Lost connection to server. Retrying...');
        }
        return prev;
      });
    };

    return () => {
      eventSource.close();
    };
  }, [jobId]);

  return { job, isLoading, error };
}
