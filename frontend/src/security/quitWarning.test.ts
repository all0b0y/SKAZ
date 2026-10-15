import { describe, expect, it } from 'vitest';
import { quitWarning } from '../../../electron/captureProtection';

describe('Quit warning: each situation in its own words', () => {
  it('audio still being saved', () => {
    const w = quitWarning({ recorderState: 'processing', pending: 3, failed: 0 });
    expect(w.message).toBe('Audio is still being saved');
    expect(w.detail).toMatch(/still saving/);
    expect(w.buttons).toEqual(['Stay in SKAZ', 'Discard unsaved audio and quit']);
  });

  it('audio that could not be saved', () => {
    const w = quitWarning({ recorderState: 'idle', pending: 0, failed: 2 });
    expect(w.message).toBe('Some audio couldn’t be saved');
    expect(w.detail).toMatch(/couldn’t save part of the recording/);
    expect(w.buttons[1]).toBe('Discard unsaved audio and quit');
  });

  it('a recording still running when the save could not be confirmed', () => {
    expect(quitWarning({ recorderState: 'recording', pending: 0, failed: 0 }).message).toBe('Audio is still being saved');
  });

  it('nothing is pending but the end of the recording was never confirmed', () => {
    const w = quitWarning({ recorderState: 'idle', pending: 0, failed: 0 });
    expect(w.message).toBe('The end of the recording isn’t confirmed');
    expect(w.detail).toMatch(/Everything SKAZ received is saved/);
    // Nothing known to be unsaved: the choice is not called "discard".
    expect(w.buttons).toEqual(['Stay in SKAZ', 'Quit anyway']);
  });
});
