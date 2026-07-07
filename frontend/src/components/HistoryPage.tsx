import { useEffect, useState } from 'react';
import { api, JobState } from '../api/client';
import type { HistoryJob } from '../api/client';

interface Props {
  onReviewVideo: (videoId: string) => void;
}

export function HistoryPage({ onReviewVideo }: Props) {
  const [jobs, setJobs] = useState<HistoryJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchJobs();
  }, []);

  const fetchJobs = async () => {
    try {
      setLoading(true);
      const data = await api.getAllJobs();
      setJobs(data);
      setError(null);
    } catch (err: any) {
      setError(err.message || 'Failed to load history');
    } finally {
      setLoading(false);
    }
  };

  const handleDownloadExport = async (exportId: string) => {
    try {
      const res = await api.getExport(exportId);
      if (res.presignedUrl) {
        window.open(res.presignedUrl, '_blank');
      }
    } catch (err: any) {
      alert('Failed to get download link: ' + err.message);
    }
  };

  if (loading) {
    return <div className="history-page"><div className="spinner"></div></div>;
  }

  if (error) {
    return <div className="history-page"><div className="status-error">{error}</div></div>;
  }

  return (
    <div className="history-page card glass slide-up">
      <div className="history-header">
        <h2>Task History</h2>
        <button className="btn-ghost" onClick={fetchJobs}>Refresh</button>
      </div>
      
      {jobs.length === 0 ? (
        <p className="text-muted">No past tasks found.</p>
      ) : (
        <table className="history-table">
          <thead>
            <tr>
              <th>Type</th>
              <th>Status</th>
              <th>Details</th>
              <th>Created At</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <tr key={`${job.type}-${job.id}`}>
                <td className="job-type-cell">
                  <span className={`badge ${job.type === 'download' ? 'badge-primary' : 'badge-secondary'}`}>
                    {job.type.toUpperCase()}
                  </span>
                </td>
                <td className="job-status-cell">
                  <span className={`status-badge ${job.status}`}>
                    {job.status} {job.status !== JobState.COMPLETED && job.status !== JobState.FAILED && `(${job.progress}%)`}
                  </span>
                </td>
                <td className="job-details-cell">
                  {job.type === 'download' ? (
                    <a href={job.data.url} target="_blank" rel="noreferrer" className="truncate-link">
                      {job.data.url}
                    </a>
                  ) : (
                    <span>Clips: {job.data.clips?.length ?? 0}</span>
                  )}
                  {job.error && <div className="error-text text-sm">{job.error}</div>}
                </td>
                <td className="job-date-cell">
                  {new Date(job.createdAt).toLocaleString()}
                </td>
                <td className="job-actions-cell">
                  {job.type === 'download' && job.status === JobState.COMPLETED && (
                    <button 
                      className="btn-sm btn-primary"
                      onClick={() => onReviewVideo(job.data.videoId)}
                    >
                      Review
                    </button>
                  )}
                  {job.type === 'export' && job.status === JobState.COMPLETED && job.data.exportId && (
                    <button 
                      className="btn-sm btn-success"
                      onClick={() => handleDownloadExport(job.data.exportId)}
                    >
                      Download
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
