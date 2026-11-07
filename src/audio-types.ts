/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
export type AudioTask = 'speech' | 'sound' | 'rhythm' | 'melody' | 'chords' | 'structure';
export const audioTasks: AudioTask[] = ['speech', 'sound', 'rhythm', 'melody', 'chords', 'structure'];
export type AudioSettings = {
  speechBackend: 'local' | 'cloud';
  speechModelId: string;
  understandingModelId: string;
  musicBackend: 'local' | 'cloud';
};
export const audioDefaults: AudioSettings = {
  speechBackend: 'local', speechModelId: '', understandingModelId: '', musicBackend: 'local',
};
/** Adapter times are relative to the supplied clip. The coordinator adds the media offset once. */
export type AudioSegment = { startSeconds: number; endSeconds: number; text: string };
export type AudioEvidence = {
  text: string;
  timing: 'segment' | 'clip';
  segments?: AudioSegment[];
  events?: string[];
  warnings: string[];
  details?: Record<string, unknown>;
  usage?: Record<string, number>;
};
export type AudioOutcome = {
  task: AudioTask; backend: 'local' | 'cloud'; status: 'completed' | 'failed';
  evidence?: AudioEvidence; code?: string; error?: string;
};
