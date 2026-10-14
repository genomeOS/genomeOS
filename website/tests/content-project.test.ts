/**
 * Project page content (moved verbatim from content.test.ts, #454). Owned by the Project task.
 */
import { describe, expect, it } from 'vitest';

import { builtHtml } from './helpers/dist';

const project = builtHtml('project');

describe('project page content', () => {
  it('labels current work, active work, and future ideas separately', () => {
    expect(project).toMatch(
      /Available now[\s\S]*In active development[\s\S]*Future exploration/,
    );
  });

  it('states the scientific publication bar', () => {
    expect(project).toMatch(/HbS[\s\S]*G6PD[\s\S]*screening/);
    expect(project).toContain('Why haemoglobin S makes the mission tangible');
    expect(project).toMatch(/population-location registry/i);
    expect(project).toMatch(/interactive public map/i);
    expect(project).toContain('/images/vision-earth.webp');
    expect(project).toContain('/images/vision-cell.webp');
    expect(project).toContain('/images/vision-bridge.webp');
    expect(project).toContain('ancient-DNA time slider');
  });
});
