import { useState, useCallback } from 'react';

export interface Clip {
  id: string;
  start: number;
  end: number;
}

export function useClips(videoDuration: number) {
  const [clips, setClips] = useState<Clip[]>([]);

  const addClip = useCallback(() => {
    const id = crypto.randomUUID();
    const start = 0;
    const end = Math.min(30, videoDuration);
    setClips((prev) => [...prev, { id, start, end }]);
  }, [videoDuration]);

  const updateClip = useCallback((id: string, start: number, end: number) => {
    setClips((prev) =>
      prev.map((c) => (c.id === id ? { ...c, start, end } : c)),
    );
  }, []);

  const removeClip = useCallback((id: string) => {
    setClips((prev) => prev.filter((c) => c.id !== id));
  }, []);

  const clearClips = useCallback(() => setClips([]), []);

  return { clips, addClip, updateClip, removeClip, clearClips };
}
