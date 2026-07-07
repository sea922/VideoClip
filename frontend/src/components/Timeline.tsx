import React, { useCallback } from 'react';
import type { Clip } from '../hooks/useClips';

interface Props {
  duration: number;
  clips: Clip[];
  onUpdate: (id: string, start: number, end: number) => void;
  onAdd: () => void;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

interface RangeSliderProps {
  clip: Clip;
  duration: number;
  onUpdate: (id: string, start: number, end: number) => void;
}

const RangeSlider: React.FC<RangeSliderProps> = ({ clip, duration, onUpdate }) => {
  const startPct = (clip.start / duration) * 100;
  const endPct = (clip.end / duration) * 100;

  const handleStartChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = Number(e.target.value);
      if (val < clip.end) onUpdate(clip.id, val, clip.end);
    },
    [clip, onUpdate],
  );

  const handleEndChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = Number(e.target.value);
      if (val > clip.start) onUpdate(clip.id, clip.start, val);
    },
    [clip, onUpdate],
  );

  return (
    <div className="range-slider">
      <div className="range-track">
        <div
          className="range-fill"
          style={{ left: `${startPct}%`, width: `${endPct - startPct}%` }}
        />
      </div>
      <input
        type="range"
        min={0}
        max={duration}
        step={0.1}
        value={clip.start}
        onChange={handleStartChange}
        className="range-input range-start"
        aria-label="Clip start time"
      />
      <input
        type="range"
        min={0}
        max={duration}
        step={0.1}
        value={clip.end}
        onChange={handleEndChange}
        className="range-input range-end"
        aria-label="Clip end time"
      />
      <div className="range-labels">
        <span>{formatTime(clip.start)}</span>
        <span>{formatTime(clip.end)}</span>
      </div>
    </div>
  );
};

export const Timeline: React.FC<Props> = ({ duration, clips, onUpdate, onAdd }) => {
  if (duration === 0) return null;

  return (
    <div className="timeline-container">
      <div className="timeline-header">
        <h3>Select Clips</h3>
        <button className="btn-ghost" onClick={onAdd}>
          + Add Clip
        </button>
      </div>

      {clips.length === 0 && (
        <p className="timeline-empty">
          Click <strong>Add Clip</strong> to select a time range from the video.
        </p>
      )}

      <div className="timeline-clips">
        {clips.map((clip, i) => (
          <div key={clip.id} className="timeline-clip-row">
            <span className="clip-index">Clip {i + 1}</span>
            <RangeSlider clip={clip} duration={duration} onUpdate={onUpdate} />
          </div>
        ))}
      </div>

      <div className="timeline-duration">
        Total duration: {formatTime(duration)}
      </div>
    </div>
  );
};
