import { useState, useCallback } from 'react';
import { UrlInput } from './components/UrlInput';
import { VideoPlayer } from './components/VideoPlayer';
import { Timeline } from './components/Timeline';
import { ClipList } from './components/ClipList';
import { TransitionPicker } from './components/TransitionPicker';
import type { Transition } from './components/TransitionPicker';
import { ExportPanel } from './components/ExportPanel';
import { useClips } from './hooks/useClips';
import './styles/index.css';

type Step = 1 | 2 | 3;

function StepIndicator({ current }: { current: Step }) {
  const steps = ['Load Video', 'Select Clips', 'Export'];
  return (
    <div className="step-indicator">
      {steps.map((label, i) => {
        const num = (i + 1) as Step;
        return (
          <div
            key={num}
            className={`step ${current === num ? 'active' : ''} ${current > num ? 'done' : ''}`}
          >
            <div className="step-circle">{current > num ? '✓' : num}</div>
            <span className="step-label">{label}</span>
            {i < steps.length - 1 && <div className="step-line" />}
          </div>
        );
      })}
    </div>
  );
}

export default function App() {
  const [step, setStep] = useState<Step>(1);
  const [videoId, setVideoId] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [transition, setTransition] = useState<Transition>('cut');

  const { clips, addClip, updateClip, removeClip } = useClips(duration);

  const handleVideoReady = useCallback((id: string) => {
    setVideoId(id);
    setStep(2);
  }, []);

  const handleDurationLoaded = useCallback((d: number) => {
    setDuration(d);
  }, []);

  const handleGoToExport = useCallback(() => {
    setStep(3);
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <a href="/" className="logo" style={{ textDecoration: 'none', color: 'inherit' }}>
          <span className="logo-icon">✂</span>
          <span className="logo-text">VideoClip</span>
        </a>
        <StepIndicator current={step} />
      </header>

      <main className="app-main">
        {/* ── Step 1: URL Input ── */}
        {step === 1 && (
          <section className="step-section">
            <UrlInput onVideoReady={handleVideoReady} />
          </section>
        )}

        {/* ── Step 2: Video Editor ── */}
        {step === 2 && videoId && (
          <section className="step-section step-editor">
            <div className="editor-left">
              <VideoPlayer
                videoId={videoId}
                onDurationLoaded={handleDurationLoaded}
              />
            </div>
            <div className="editor-right">
              <Timeline
                duration={duration}
                clips={clips}
                onUpdate={updateClip}
                onAdd={addClip}
              />
              <ClipList clips={clips} onRemove={removeClip} />
              <TransitionPicker value={transition} onChange={setTransition} />

              <button
                id="go-export-btn"
                className="btn-primary btn-large"
                disabled={clips.length === 0}
                onClick={handleGoToExport}
              >
                Continue to Export →
              </button>
            </div>
          </section>
        )}

        {/* ── Step 3: Export ── */}
        {step === 3 && videoId && (
          <section className="step-section">
            <div className="export-header">
              <button
                className="btn-ghost"
                onClick={() => setStep(2)}
              >
                ← Back to Editor
              </button>
            </div>
            <ExportPanel
              videoId={videoId}
              clips={clips}
              transition={transition}
            />
          </section>
        )}
      </main>
    </div>
  );
}
