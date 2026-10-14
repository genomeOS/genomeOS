/**
 * Contribute page content (moved from content.test.ts, #454). Owned by the Contribute task.
 */
import { describe, expect, it } from 'vitest';

import { builtHtml } from './helpers/dist';

const contribute = builtHtml('contribute');

describe('contribute page content', () => {
  it('teaches the repository contribution workflow', () => {
    expect(contribute).toContain('Discussion #76');
    expect(contribute).toContain('mention the original issue author');
    expect(contribute).toContain('Ready');
    expect(contribute).toContain('needs-human-decision');
    expect(contribute).toContain('wants-expert-review');
    expect(contribute).toContain('https://github.com/orgs/genomeOS/projects/1');
    expect(contribute).toContain('/images/contribute-community.webp');
  });

  // Task 3 enables: the working groups now live on Contribute (spec §4.3 C2, §9.1).
  it.skip('defines all three forming working groups and modeling breadth', () => {
    expect(contribute).toMatch(
      /Data Gathering &amp; Infrastructure[\s\S]*Statistical &amp; AI Modeling[\s\S]*UI &amp; Applications/,
    );
    expect(contribute).toContain('geometric deep learning');
    expect(contribute).toContain('Brian');
    expect(contribute).toMatch(/not been sampled evenly/i);
    expect(contribute).toMatch(/disease-burden[\s\S]*risk estimates/i);
    expect(contribute).toMatch(/agentic AI[\s\S]*own genomes/i);
    expect(contribute).toMatch(
      /Future exploration[\s\S]*privacy[\s\S]*consent[\s\S]*governance/,
    );
    expect(contribute).toContain('Groups are forming');
  });
});
