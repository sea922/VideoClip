import React from 'react';

export type Transition = 'cut' | 'fade' | 'slide';

interface Props {
  value: Transition;
  onChange: (value: Transition) => void;
}

const OPTIONS: Array<{
  value: Transition;
  label: string;
  description: string;
  disabled?: boolean;
}> = [
  {
    value: 'cut',
    label: 'Cut',
    description: 'Hard cut between clips — fastest processing',
  },
  {
    value: 'fade',
    label: 'Fade',
    description: '0.5s crossfade between clips',
  },
  {
    value: 'slide',
    label: 'Slide',
    description: 'Coming soon — too CPU-intensive for current infrastructure',
    disabled: true,
  },
];

export const TransitionPicker: React.FC<Props> = ({ value, onChange }) => {
  return (
    <div className="transition-picker">
      <h4>Transition Effect</h4>
      <div className="transition-options">
        {OPTIONS.map((opt) => (
          <label
            key={opt.value}
            className={`transition-option ${opt.disabled ? 'disabled' : ''} ${value === opt.value ? 'selected' : ''}`}
            title={opt.disabled ? opt.description : undefined}
          >
            <input
              type="radio"
              name="transition"
              value={opt.value}
              checked={value === opt.value}
              disabled={opt.disabled}
              onChange={() => onChange(opt.value)}
            />
            <span className="transition-label">{opt.label}</span>
            <span className="transition-desc">{opt.description}</span>
          </label>
        ))}
      </div>
    </div>
  );
};
