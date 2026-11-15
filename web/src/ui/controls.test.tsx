import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Check, Chip, Radio, TextButton } from './controls';

afterEach(cleanup);

function CheckHarness() {
  const [on, setOn] = useState(false);
  return <Check checked={on} onChange={setOn} label="CITI BIKE" />;
}

function RadioHarness() {
  const [v, setV] = useState('24h');
  return (
    <>
      {['24h', '48h'].map((w) => (
        <Radio key={w} name="win" checked={v === w} onChange={() => setV(w)} label={w} />
      ))}
    </>
  );
}

describe('Check', () => {
  it('toggles and exposes aria-checked', () => {
    render(<CheckHarness />);
    const box = screen.getByRole('checkbox', { name: 'CITI BIKE' }) as HTMLInputElement;
    expect(box.getAttribute('aria-checked')).toBe('false');
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    expect(box.getAttribute('aria-checked')).toBe('true');
    expect(box.checked).toBe(true);
    fireEvent.click(screen.getByText('CITI BIKE')); // clicking the label toggles too
    expect(box.getAttribute('aria-checked')).toBe('false');
  });

  it('does not call onChange when disabled', () => {
    const onChange = vi.fn();
    render(<Check checked={false} onChange={onChange} label="OFF" disabled />);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps `right` outside the label', () => {
    render(<Check checked onChange={() => {}} label="ROW" right={<button type="button">[+]</button>} />);
    const btn = screen.getByRole('button', { name: '[+]' });
    expect(btn.closest('label')).toBeNull();
  });
});

describe('Radio', () => {
  it('selects one option at a time and exposes aria-checked', () => {
    render(<RadioHarness />);
    const [a, b] = screen.getAllByRole('radio') as HTMLInputElement[];
    expect(a.getAttribute('aria-checked')).toBe('true');
    expect(b.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(b);
    expect(a.getAttribute('aria-checked')).toBe('false');
    expect(b.getAttribute('aria-checked')).toBe('true');
    expect(b.checked).toBe(true);
    expect(a.name).toBe('win');
  });
});

describe('TextButton', () => {
  it('exposes aria-pressed and toggles it', () => {
    function Harness() {
      const [p, setP] = useState(false);
      return (
        <TextButton pressed={p} onClick={() => setP(!p)} ariaLabel="Live">
          LIVE
        </TextButton>
      );
    }
    render(<Harness />);
    const btn = screen.getByRole('button', { name: 'Live' });
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(btn.textContent).toBe('[LIVE]');
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-pressed')).toBe('true');
  });

  it('omits aria-pressed for plain actions and keeps existing brackets', () => {
    render(
      <TextButton onClick={() => {}} ariaLabel="Close">
        [CLOSE]
      </TextButton>,
    );
    const btn = screen.getByRole('button', { name: 'Close' });
    expect(btn.hasAttribute('aria-pressed')).toBe(false);
    expect(btn.textContent).toBe('[CLOSE]');
  });

  it('stays focusable but inert when disabled', () => {
    const onClick = vi.fn();
    render(
      <TextButton disabled onClick={onClick} ariaLabel="Reset">
        RESET
      </TextButton>,
    );
    const btn = screen.getByRole('button', { name: 'Reset' });
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect(btn.hasAttribute('disabled')).toBe(false);
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('Chip', () => {
  it('is a toggle button with aria-pressed when clickable', () => {
    render(
      <Chip pressed onClick={() => {}} ariaLabel="Brooklyn">
        BK
      </Chip>,
    );
    expect(screen.getByRole('button', { name: 'Brooklyn' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('is a link with href', () => {
    render(<Chip href="https://example.org/">SOURCE</Chip>);
    const a = screen.getByRole('link', { name: 'SOURCE' });
    expect(a.getAttribute('rel')).toBe('noreferrer');
  });
});
