import React from 'react';
import type { Clip } from '../hooks/useClips';

interface Props {
  clips: Clip[];
  onRemove: (id: string) => void;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export const ClipList: React.FC<Props> = ({ clips, onRemove }) => {
  if (clips.length === 0) return null;

  return (
    <div className="clip-list">
      <h4>Selected Clips ({clips.length})</h4>
      <ul>
        {clips.map((clip, i) => (
          <li key={clip.id} className="clip-item">
            <span className="clip-label">Clip {i + 1}</span>
            <span className="clip-range">
              {formatTime(clip.start)} → {formatTime(clip.end)}
            </span>
            <span className="clip-duration">
              ({(clip.end - clip.start).toFixed(1)}s)
            </span>
            <button
              className="btn-remove"
              onClick={() => onRemove(clip.id)}
              aria-label={`Remove clip ${i + 1}`}
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
};
