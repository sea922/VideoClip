import React, { useRef, useEffect } from 'react';
import { api } from '../api/client';

interface Props {
  videoId: string;
  onDurationLoaded: (duration: number) => void;
}

/**
 * HTML5 video player that streams via a backend pre-signed URL redirect.
 * The backend GET /videos/:id/stream returns a 302 to MinIO/S3.
 * Video bytes never flow through NestJS.
 */
export const VideoPlayer: React.FC<Props> = ({ videoId, onDurationLoaded }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamUrl = api.getStreamUrl(videoId);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handleMetadata = () => {
      if (video.duration && isFinite(video.duration)) {
        onDurationLoaded(video.duration);
      }
    };

    video.addEventListener('loadedmetadata', handleMetadata);
    return () => video.removeEventListener('loadedmetadata', handleMetadata);
  }, [onDurationLoaded]);

  return (
    <div className="video-player-container">
      <video
        ref={videoRef}
        src={streamUrl}
        controls
        className="video-player"
        preload="metadata"
        crossOrigin="anonymous"
      >
        Your browser does not support HTML5 video.
      </video>
    </div>
  );
};
