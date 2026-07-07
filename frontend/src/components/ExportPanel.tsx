import React, { useState } from 'react';
import { api, ApiError, JobState } from '../api/client';
import { useJob } from '../hooks/useJob';
import type { Clip } from '../hooks/useClips';
import type { Transition } from './TransitionPicker';

interface Props {
  videoId: string;
  clips: Clip[];
  transition: Transition;
}

export const ExportPanel: React.FC<Props> = ({ videoId, clips, transition }) => {
  const [jobId, setJobId] = useState<string | null>(null);
  const [exportId, setExportId] = useState<string | null>(null);
  const [presignedUrl, setPresignedUrl] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const { job } = useJob(jobId);

  // When job completes, fetch the export result for the presigned URL
  React.useEffect(() => {
    if (job?.status === JobState.COMPLETED && exportId) {
      api.getExport(exportId).then((result) => {
        if (result.presignedUrl) setPresignedUrl(result.presignedUrl);
      });
    }
  }, [job?.status, exportId]);

  const handleExport = async () => {
    if (clips.length === 0) return;
    setSubmitError(null);
    setIsSubmitting(true);
    setPresignedUrl(null);
    setJobId(null);

    try {
      const result = await api.submitExport({
        videoId,
        clips: clips.map((c) => ({ start: c.start, end: c.end })),
        transition,
      });
      setExportId(result.exportId);
      setJobId(result.jobId);
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setSubmitError('Server is busy — please try again in a minute');
      } else {
        setSubmitError(err instanceof Error ? err.message : 'Export failed');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const isProcessing =
    jobId !== null && job?.status !== JobState.COMPLETED && job?.status !== JobState.FAILED;

  const canExport = clips.length > 0 && !isProcessing && !isSubmitting;

  return (
    <div className="export-panel">
      <div className="export-summary">
        <span>{clips.length} clip{clips.length !== 1 ? 's' : ''} selected</span>
        <span className="separator">·</span>
        <span className="transition-badge">{transition} transition</span>
      </div>

      {submitError && <p className="field-error">{submitError}</p>}

      {!presignedUrl && (
        <button
          id="export-btn"
          className="btn-primary btn-large"
          onClick={handleExport}
          disabled={!canExport}
        >
          {isSubmitting ? 'Submitting…' : isProcessing ? 'Processing…' : 'Export Video'}
        </button>
      )}

      {isProcessing && (
        <div className="export-progress">
          <div className="spinner" />
          <div className="status-text">
            <span>Merging clips with FFmpeg…</span>
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

      {job?.status === JobState.FAILED && (
        <div className="status-error">
          ⚠️ Export failed: {job.error ?? 'Unknown error'}
        </div>
      )}

      {presignedUrl && (
        <div className="download-ready">
          <div className="success-icon">✓</div>
          <h3>Your video is ready!</h3>
          <a
            id="download-link"
            href={presignedUrl}
            download="export.mp4"
            className="btn-download"
            target="_blank"
            rel="noopener noreferrer"
          >
            ⬇ Download MP4
          </a>
          <p className="download-note">
            Link expires in 15 minutes. Downloaded directly from storage — no server load.
          </p>
        </div>
      )}
    </div>
  );
};
