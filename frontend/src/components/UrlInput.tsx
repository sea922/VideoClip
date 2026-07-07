import React, { useState } from 'react';
import { api, ApiError } from '../api/client';
import { useJob } from '../hooks/useJob';

interface Props {
  onVideoReady: (videoId: string) => void;
}

function isYouTubeUrl(url: string): boolean {
  return /^https?:\/\/(www\.)?(youtube\.com\/(watch|shorts\/)|youtu\.be\/)/.test(url);
}

export const UrlInput: React.FC<Props> = ({ onVideoReady }) => {
  const [url, setUrl] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [videoId, setVideoId] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const { job } = useJob(jobId);

  // Watch for job completion
  React.useEffect(() => {
    if (job?.status === 'completed' && videoId) {
      onVideoReady(videoId);
    }
  }, [job?.status, videoId, onVideoReady]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setValidationError(null);
    setSubmitError(null);

    if (!url.trim()) {
      setValidationError('Please enter a YouTube URL');
      return;
    }
    if (!isYouTubeUrl(url.trim())) {
      setValidationError('Please enter a valid YouTube URL (youtube.com or youtu.be)');
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await api.submitVideo(url.trim());
      setVideoId(result.videoId);
      setJobId(result.jobId);
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setSubmitError('Server is busy — please try again in a minute');
      } else {
        setSubmitError(err instanceof Error ? err.message : 'Failed to submit video');
      }
      setIsSubmitting(false);
    }
  };

  const isProcessing = jobId !== null && job?.status !== 'completed' && job?.status !== 'failed';

  return (
    <div className="url-input-container">
      <div className="url-input-header">
        <h2>Paste a YouTube URL</h2>
        <p>Download, clip, and export any YouTube video</p>
      </div>

      <form onSubmit={handleSubmit} className="url-form">
        <div className="input-row">
          <input
            id="youtube-url"
            type="url"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setValidationError(null);
            }}
            placeholder="https://www.youtube.com/watch?v=..."
            className={`url-field ${validationError ? 'error' : ''}`}
            disabled={isProcessing}
            autoFocus
          />
          <button
            type="submit"
            className="btn-primary"
            disabled={isProcessing || isSubmitting}
          >
            {isSubmitting ? 'Submitting…' : 'Load Video'}
          </button>
        </div>

        {validationError && (
          <p className="field-error">{validationError}</p>
        )}
        {submitError && (
          <p className="field-error">{submitError}</p>
        )}
      </form>

      {isProcessing && (
        <div className="download-status">
          <div className="spinner" />
          <div className="status-text">
            <span>Downloading video…</span>
            {job?.progress ? (
              <span className="progress-label">{job.progress}%</span>
            ) : null}
          </div>
          <div className="progress-bar">
            <div
              className="progress-fill"
              style={{ width: `${job?.progress ?? 0}%` }}
            />
          </div>
        </div>
      )}

      {job?.status === 'failed' && (
        <div className="status-error">
          <span>⚠️ Download failed: {job.error ?? 'Unknown error'}</span>
          <button
            className="btn-ghost"
            onClick={() => {
              setJobId(null);
              setVideoId(null);
              setIsSubmitting(false);
            }}
          >
            Try again
          </button>
        </div>
      )}
    </div>
  );
};
